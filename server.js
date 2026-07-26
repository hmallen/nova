// Nova — Alexa-style voice assistant on the OpenAI Realtime API.
//
// This server serves the static client from ./public, mints short-lived
// Realtime "client secrets" (ephemeral tokens) so the browser can open a
// WebRTC session directly with OpenAI without ever seeing the real API key,
// and hosts the small LAN-local APIs: shared lists, news, and the optional
// Home Assistant / calendar / radio integrations.
//
// Zero npm dependencies — Node 18+ only. Everything is wrapped in
// createNovaServer({ env, dataDir }) so tests can boot the real server on an
// ephemeral port with a temp data dir; the main-module guard at the bottom
// does the actual listening.

import http from "node:http";
import https from "node:https";
import os from "node:os";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createStore } from "./lib/store.js";
import { parseRss } from "./lib/rss.js";
import { parseIcs, expandEvents } from "./lib/ics.js";
import { parseEnv, applyEnv } from "./lib/env.js";
import { sanitizePrefs, buildAboutBlock } from "./lib/prefs.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");

export class HttpsSetupError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "HttpsSetupError";
  }
}

function loadHttpsOptions(env) {
  const certPath = String(env.HTTPS_CERT || "").trim();
  const keyPath = String(env.HTTPS_KEY || "").trim();

  if (!certPath && !keyPath) return null;
  if (!certPath || !keyPath) {
    const missing = certPath ? "HTTPS_KEY" : "HTTPS_CERT";
    throw new HttpsSetupError(
      `HTTPS setup error: ${missing} is not set. Set both HTTPS_CERT and HTTPS_KEY ` +
      `to readable local PEM files (see README "Use it on a tablet or phone"), ` +
      `or unset both variables to use HTTP on localhost.`
    );
  }

  const readConfiguredFile = (variable, configuredPath) => {
    try {
      return readFileSync(path.resolve(__dirname, configuredPath));
    } catch (cause) {
      const reason = cause?.code ? ` (${cause.code})` : "";
      throw new HttpsSetupError(
        `HTTPS setup error: ${variable} points to "${configuredPath}", but that file ` +
        `could not be read${reason}. Generate local certificates with mkcert and update ` +
        `HTTPS_CERT/HTTPS_KEY in .env, fix the file permissions, or unset both variables ` +
        `to use HTTP on localhost.`,
        { cause }
      );
    }
  };

  return {
    cert: readConfiguredFile("HTTPS_CERT", certPath),
    key: readConfiguredFile("HTTPS_KEY", keyPath),
  };
}

const INSTRUCTIONS = `
You are Nova, a friendly household voice assistant in the style of Amazon Alexa.

Personality and style:
- You are warm, upbeat, and efficient. This is a spoken conversation — answers
  are heard, not read.
- Keep responses short: one or two sentences for most requests. Never read out
  lists of more than five items unless asked.
- Never use markdown, bullet points, emoji, or formatting. Speak naturally.
- Say numbers, times, and units the way a person would say them out loud.
- If a request is ambiguous, make a sensible assumption rather than
  interrogating the user; briefly state the assumption.

Capabilities:
- You have tools for the current date and time, timers, stopwatches, alarms, weather,
  shopping and to-do lists, smart-home devices, ambient sounds, and
  speaker volume. Always use the matching tool instead of guessing — for
  example, never state the time or weather from memory.
- You can also start stopwatches, set reminders ("remind me to X at Y"), repeating alarms, and
  snooze whatever just rang. When a reminder fires, announce it as "This is
  your reminder to ...".
- For general knowledge, trivia, jokes, conversions, math, recipes, and
  chit-chat, answer directly yourself.
- After a tool runs, confirm the action in one short sentence, like Alexa
  would: "Okay, five minute timer, starting now."
- If the user asks for something you truly cannot do (playing licensed music,
  making phone calls, ordering products), say so briefly and, when possible,
  offer the closest thing you can do, such as an ambient sound instead of music.

The user may address you as "Nova". Do not mention OpenAI, models, tools, or
function names — you are simply Nova.

If the user tells you something to remember about themselves (their name, home
city, temperature units, or which voice to use), call manage_preferences to
save it — don't just acknowledge.

When the user greets you with "good morning" or "good night", call run_routine
with that name if it exists. Present routine results as one connected update,
not a list of tool outputs: weather first, then today's schedule, then a few
headlines. Keep the whole update under about thirty seconds of speech.
`.trim();

// Read a small JSON request body (session prefs, list sync, HA calls).
function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("Body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// Shape check for PUT /api/lists bodies: object of listName → string items,
// with sane caps so a buggy client can't balloon the store.
function validLists(lists) {
  if (!lists || typeof lists !== "object" || Array.isArray(lists)) return false;
  const names = Object.keys(lists);
  if (names.length > 20) return false;
  for (const name of names) {
    const items = lists[name];
    if (!Array.isArray(items) || items.length > 100) return false;
    if (!items.every(i => typeof i === "string" && i.length <= 200)) return false;
  }
  return true;
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
};

export function createNovaServer({ env = process.env, dataDir = path.join(__dirname, "data") } = {}) {
  const httpsOptions = loadHttpsOptions(env);
  const OPENAI_API_KEY = env.OPENAI_API_KEY;
  // Latest generation realtime speech-to-speech model (July 2026).
  // Override with REALTIME_MODEL=gpt-realtime-2.1-mini for lower cost/latency.
  const REALTIME_MODEL = env.REALTIME_MODEL || "gpt-realtime-2.1";
  const VOICE = env.REALTIME_VOICE || "marin";

  mkdirSync(dataDir, { recursive: true });
  const store = createStore(path.join(dataDir, "state.json"));

  // ---- News (Plan 4): keyless RSS proxy — browsers can't fetch
  // cross-origin RSS, so the server does, and returns speakable headlines.
  const NEWS_FEEDS = (env.NEWS_FEEDS || "https://news.google.com/rss")
    .split(",").map(s => s.trim()).filter(Boolean);
  const NEWS_CACHE_MS = 10 * 60 * 1000;
  let newsCache = null; // { at, headlines } for the no-topic case only

  async function fetchHeadlines(topic) {
    if (!topic && newsCache && Date.now() - newsCache.at < NEWS_CACHE_MS) {
      return newsCache.headlines;
    }
    const urls = topic
      ? [`https://news.google.com/rss/search?q=${encodeURIComponent(topic)}`]
      : NEWS_FEEDS;
    const items = [];
    for (const url of urls) {
      const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!resp.ok) throw new Error(`Feed returned HTTP ${resp.status}`);
      items.push(...parseRss(await resp.text()));
    }
    // Dedupe near-identical titles (same story from several feeds/outlets).
    const seen = new Set();
    const headlines = [];
    for (const item of items) {
      const key = item.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 60);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      headlines.push({ title: item.title, ...(item.source ? { source: item.source } : {}) });
      if (headlines.length >= 8) break;
    }
    if (!headlines.length) throw new Error("No headlines found in feed");
    if (!topic) newsCache = { at: Date.now(), headlines };
    return headlines;
  }

  // ---- Real integrations (Plan 7): all optional, env-gated, secrets stay
  // server-side. /api/config tells the client which ones are live. ----

  // Home Assistant. The proxy below is the security boundary — HA tokens are
  // full-admin, so it is deliberately NOT a generic passthrough: domains,
  // services, entity ids, and extra data are all allowlisted.
  const HA_URL = (env.HA_URL || "").replace(/\/+$/, "");
  const HA_TOKEN = env.HA_TOKEN || "";
  const HA_ENABLED = Boolean(HA_URL && HA_TOKEN);
  const HA_DOMAINS = ["light", "switch", "fan", "climate"];
  const HA_SERVICES = ["turn_on", "turn_off", "set_temperature"];
  const HA_ENTITY_RE = /^(light|switch|fan|climate)\.[a-z0-9_]+$/;

  async function haFetch(pathname, init = {}) {
    return fetch(HA_URL + pathname, {
      ...init,
      headers: {
        Authorization: `Bearer ${HA_TOKEN}`,
        "Content-Type": "application/json",
        ...(init.headers || {}),
      },
      signal: AbortSignal.timeout(8000),
    });
  }

  // Calendar (read-only ICS feed).
  const ICS_URL = env.ICS_URL || "";
  const ICS_CACHE_MS = 15 * 60 * 1000;
  let icsCache = null; // { at, text }

  async function fetchCalendar(days) {
    if (!icsCache || Date.now() - icsCache.at > ICS_CACHE_MS) {
      const resp = await fetch(ICS_URL, { signal: AbortSignal.timeout(8000) });
      if (!resp.ok) throw new Error(`Calendar feed returned HTTP ${resp.status}`);
      icsCache = { at: Date.now(), text: await resp.text() };
    }
    const now = Date.now();
    const { events, unsupported } = expandEvents(
      parseIcs(icsCache.text),
      now - 60 * 60 * 1000,
      now + days * 24 * 60 * 60 * 1000
    );
    return {
      events: events.slice(0, 15).map(e => ({
        summary: e.summary,
        start_iso: new Date(e.start).toISOString(),
        end_iso: new Date(e.end).toISOString(),
        all_day: e.allDay,
      })),
      ...(unsupported ? { note: "some repeating events couldn't be read" } : {}),
    };
  }

  // Internet radio. Names flow to the client via /api/config; stream URLs
  // stay server-side behind a 302 so users can swap streams without touching
  // JS. Defaults are SomaFM's public MP3 streams (listener-supported, direct
  // players historically permitted with attribution — see README).
  const DEFAULT_RADIO_STREAMS = {
    jazz: "https://ice1.somafm.com/sonicuniverse-128-mp3",
    chill: "https://ice1.somafm.com/groovesalad-128-mp3",
    lofi: "https://ice1.somafm.com/fluid-128-mp3",
  };
  let radioStreams = DEFAULT_RADIO_STREAMS;
  if (env.RADIO_STREAMS) {
    try {
      radioStreams = { ...DEFAULT_RADIO_STREAMS, ...JSON.parse(env.RADIO_STREAMS) };
    } catch {
      console.warn("  ⚠  RADIO_STREAMS is not valid JSON — using built-in streams.");
    }
  }

  // Session template. Tool definitions live in the client (public/app.js)
  // alongside their implementations and are attached via session.update once
  // the data channel opens.
  function sessionConfig(prefs = {}) {
    return {
      session: {
        type: "realtime",
        model: REALTIME_MODEL,
        instructions: INSTRUCTIONS + buildAboutBlock(prefs),
        audio: {
          output: { voice: prefs.voice || VOICE },
        },
      },
    };
  }

  async function mintClientSecret(prefs) {
    const resp = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(sessionConfig(prefs)),
    });
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const msg = body?.error?.message || `OpenAI returned HTTP ${resp.status}`;
      throw new Error(msg);
    }
    return body; // contains { value: "ek_...", expires_at, session: {...} }
  }

  const requestHandler = async (req, res) => {
    try {
      if (req.method === "POST" && req.url === "/api/session") {
        if (!OPENAI_API_KEY) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "OPENAI_API_KEY is not set. Copy .env.example to .env and add your key." }));
          return;
        }
        let prefs = {};
        try {
          const body = await readBody(req);
          prefs = sanitizePrefs(body ? JSON.parse(body).prefs : null);
        } catch {} // absent/invalid body → default session
        try {
          const secret = await mintClientSecret(prefs);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ value: secret.value, model: REALTIME_MODEL }));
        } catch (err) {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(err.message || err) }));
        }
        return;
      }

      // Which optional integrations are live (non-secret config only).
      if (req.method === "GET" && req.url.split("?")[0] === "/api/config") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          homeAssistant: HA_ENABLED,
          calendar: Boolean(ICS_URL),
          radio: Object.keys(radioStreams).map(name => ({ name })),
        }));
        return;
      }

      if (req.method === "GET" && req.url.split("?")[0] === "/api/ha/states") {
        if (!HA_ENABLED) { res.writeHead(404); res.end(); return; }
        try {
          const resp = await haFetch("/api/states");
          if (!resp.ok) throw new Error(`HA returned HTTP ${resp.status}`);
          const states = await resp.json();
          const devices = states
            .filter(s => HA_DOMAINS.includes(String(s.entity_id).split(".")[0]))
            .map(s => ({
              entity_id: s.entity_id,
              name: s.attributes?.friendly_name || s.entity_id,
              domain: s.entity_id.split(".")[0],
              state: s.state,
              ...(typeof s.attributes?.temperature === "number" ? { temp: s.attributes.temperature } : {}),
            }));
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(devices));
        } catch (err) {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(err.message || err) }));
        }
        return;
      }

      if (req.method === "POST" && req.url === "/api/ha/call") {
        if (!HA_ENABLED) { res.writeHead(404); res.end(); return; }
        let call;
        try { call = JSON.parse(await readBody(req)); } catch { call = null; }
        const dataOk = call?.data === undefined ||
          (call?.data && typeof call.data === "object" &&
           Object.keys(call.data).every(k => k === "temperature") &&
           (call.data.temperature === undefined || typeof call.data.temperature === "number"));
        if (
          !call ||
          !HA_DOMAINS.includes(call.domain) ||
          !HA_SERVICES.includes(call.service) ||
          !HA_ENTITY_RE.test(call.entity_id || "") ||
          !dataOk
        ) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Bad service call" }));
          return;
        }
        try {
          const resp = await haFetch(`/api/services/${call.domain}/${call.service}`, {
            method: "POST",
            body: JSON.stringify({ entity_id: call.entity_id, ...(call.data || {}) }),
          });
          if (!resp.ok) throw new Error(`HA returned HTTP ${resp.status}`);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(err.message || err) }));
        }
        return;
      }

      if (req.method === "GET" && req.url.split("?")[0] === "/api/calendar") {
        if (!ICS_URL) { res.writeHead(404); res.end(); return; }
        const days = Math.min(7, Math.max(1,
          parseInt(new URL(req.url, "http://x").searchParams.get("days"), 10) || 1));
        try {
          const body = await fetchCalendar(days);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(body));
        } catch (err) {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(err.message || err) }));
        }
        return;
      }

      if (req.method === "GET" && req.url.startsWith("/api/radio/")) {
        const name = decodeURIComponent(req.url.slice("/api/radio/".length).split("?")[0]).toLowerCase();
        const url = radioStreams[name];
        if (!url) { res.writeHead(404); res.end(); return; }
        res.writeHead(302, { Location: url });
        res.end();
        return;
      }

      if (req.method === "GET" && req.url.split("?")[0] === "/api/news") {
        const topic = new URL(req.url, "http://x").searchParams.get("topic") || "";
        try {
          const headlines = await fetchHeadlines(topic.slice(0, 100));
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ headlines }));
        } catch (err) {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(err.message || err) }));
        }
        return;
      }

      // Shared lists (Plan 3). No auth: the server is LAN-local and already
      // gates nothing else — same trust level as an Echo on your network.
      if (req.url.split("?")[0] === "/api/lists") {
        if (req.method === "GET") {
          const since = parseInt(new URL(req.url, "http://x").searchParams.get("since"), 10);
          const cur = store.get();
          if (Number.isInteger(since) && since === cur.rev) {
            res.writeHead(304); res.end(); return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(cur));
          return;
        }
        if (req.method === "PUT") {
          let body;
          try { body = JSON.parse(await readBody(req)); } catch { body = null; }
          if (!body || !Number.isInteger(body.rev) || !validLists(body.lists)) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Bad lists payload" }));
            return;
          }
          // Rev check runs inside the serialized update chain so two racing
          // PUTs can't both commit against the same rev.
          let conflict = false;
          const next = await store.update((cur) => {
            if (body.rev !== cur.rev) { conflict = true; return null; }
            return body.lists;
          });
          if (conflict) {
            // Stale client: hand back current state so it can re-apply on top.
            res.writeHead(409, { "Content-Type": "application/json" });
            res.end(JSON.stringify(next));
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ rev: next.rev }));
          return;
        }
        res.writeHead(405); res.end(); return;
      }

      // Static files
      let urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
      if (urlPath === "/") urlPath = "/index.html";
      const filePath = path.join(PUBLIC_DIR, urlPath);
      if (!filePath.startsWith(PUBLIC_DIR)) {
        res.writeHead(403); res.end("Forbidden"); return;
      }
      try {
        const data = await readFile(filePath);
        res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
        res.end(data);
      } catch {
        res.writeHead(404); res.end("Not found");
      }
    } catch (err) {
      res.writeHead(500); res.end("Server error");
    }
  };

  // HTTPS is optional but required for any second device on the LAN: mic
  // access (and the wake word) needs a secure context, and only localhost
  // gets one over plain HTTP. See README "Use it on a tablet or phone".
  const useHttps = Boolean(httpsOptions);
  let server;
  try {
    server = useHttps
      ? https.createServer(httpsOptions, requestHandler)
      : http.createServer(requestHandler);
  } catch (cause) {
    const reason = cause?.code ? ` (${cause.code})` : "";
    throw new HttpsSetupError(
      `HTTPS setup error: HTTPS_CERT/HTTPS_KEY could not be loaded as a valid PEM ` +
      `certificate and private-key pair${reason}. Regenerate both files with mkcert ` +
      `and update .env, or unset both variables to use HTTP on localhost.`,
      { cause }
    );
  }

  // Non-secret facts the boot logging (and tests) may want.
  server.novaInfo = {
    model: REALTIME_MODEL,
    voice: VOICE,
    https: useHttps,
    hasKey: Boolean(OPENAI_API_KEY),
  };
  return server;
}

// Run directly (`node server.js`): load .env, create, listen, log.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const envPath = path.join(__dirname, ".env");
  if (existsSync(envPath)) applyEnv(parseEnv(readFileSync(envPath, "utf8")), process.env);

  const PORT = Number(process.env.PORT || 3000);
  try {
    const server = createNovaServer();
    server.listen(PORT, () => {
      const { model, voice, https: tls, hasKey } = server.novaInfo;
      const proto = tls ? "https" : "http";
      console.log(`\n  Nova voice assistant`);
      console.log(`  → ${proto}://localhost:${PORT}`);
      if (tls) {
        // Show LAN addresses so the user knows what to type on the tablet.
        for (const addrs of Object.values(os.networkInterfaces())) {
          for (const a of addrs || []) {
            if (a.family === "IPv4" && !a.internal) console.log(`  → ${proto}://${a.address}:${PORT}  (LAN)`);
          }
        }
      }
      console.log(`  model: ${model}, voice: ${voice}`);
      if (!hasKey) {
        console.warn(`\n  ⚠  OPENAI_API_KEY not set — copy .env.example to .env and add your key.\n`);
      }
    });
  } catch (err) {
    if (!(err instanceof HttpsSetupError)) throw err;
    console.error(`\n  ✖ ${err.message}\n`);
    process.exitCode = 1;
  }
}
