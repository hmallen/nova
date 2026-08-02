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
import {
  createGoogleCalendar,
  buildEventResource,
  isValidTimeZone,
  isoToLocal,
  GoogleCalendarError,
} from "./lib/gcal.js";
import { parseEnv, applyEnv } from "./lib/env.js";
import { sanitizePrefs, buildAboutBlock } from "./lib/prefs.js";
import {
  addFact,
  forgetFact,
  activeFacts,
  factsForPrompt,
  sanitizeRollover,
  rolloverForSession,
  renderRolloverText,
  mergeSuggestions,
  pendingSuggestions,
  acceptSuggestion,
  dismissSuggestion,
  askSuggestion,
  setFactStale,
  DEFAULT_ROLLOVER_MAX_AGE_MIN,
} from "./lib/memory.js";
import {
  sanitizeEvent,
  appendEvents,
  scanArchive,
  readRange,
  sweepArchive,
  archiveStats,
  MAX_BATCH_EVENTS,
  RECALL_LIMIT,
  DEFAULT_TURN_RETENTION_DAYS,
} from "./lib/archive.js";
import { detectHabits, measureHabit, isDecayed } from "./lib/habits.js";

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

Calendar:
- When you add or change an event, repeat the title and the time back in your
  confirmation ("Added dentist, Thursday at two thirty") so a misheard time is
  caught immediately.
- Cancelling an event cannot be undone. Before calling cancel_calendar_event,
  name the specific event and get a clear yes — and if the calendar has more
  than one event that matches what they said, ask which one rather than
  guessing.
- If the user gives a day but no time, ask for the time rather than inventing
  one. If they give a time but no duration, just book an hour.

The user may address you as "Nova". Do not mention OpenAI, models, tools, or
function names — you are simply Nova.

If the user tells you something to remember about themselves (their name, home
city, temperature units, or which voice to use), call manage_preferences to
save it — don't just acknowledge.

If they ask you to remember anything else — an allergy, a family member, a
habit — call remember to save it; don't just say you will. If they tell you
something that contradicts a fact you were given, save the new one with the
"replaces" field set to the old fact's id. Memory ids are for your use only:
never say one out loud.

Use recall_memory only when the user asks about the PAST — what was on a list
on an earlier day, when a device was last changed, what you talked about days
ago — and you don't already know the answer. Never use it for current state;
the normal skill for that is always right and always faster. If recall_memory
comes back with found false, say plainly that you have no record of it. Never
guess at what happened, and never infer a past event from what is true now.

When the user greets you with "good morning" or "good night", call run_routine
with that name if it exists. Present routine results as one connected update,
not a list of tool outputs: weather first, then today's schedule, then a few
headlines. Keep the whole update under about thirty seconds of speech.

If a routine result includes a "suggestion", mention it once at the very end of
that update, as one short friendly question — never in the middle, never more
than one, and never anywhere except after a routine. If the user says yes, call
remember with action "accept" and that suggestion's id. If they say no, call it
with action "dismiss". If they ignore it or change the subject, let it go
without asking again.
`.trim();

// The OAuth callback is the only HTML this server generates, and it echoes
// query parameters that arrive from a redirect. Escape them.
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

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
  // Memory gets its own file (Plan 9): separate blast radius, separate backup,
  // and a corrupt memory file can never take the shopping list down with it.
  const memory = createStore(path.join(dataDir, "memory.json"), {
    facts: [],
    rollover: null,
    // Tier D (Plan 10). Timestamps default to "" rather than null: createStore
    // discards a stored value whose broad kind doesn't match its default, and
    // typeof null is "object".
    suggestions: [],
    lastScanAt: "",
    lastSweepAt: "",
  });
  // Tier C's archive is a directory of month files, not a store — append-only,
  // never read on a normal turn. See lib/archive.js.
  const archiveDir = path.join(dataDir, "archive");

  const num = (raw, fallback, floor = 0) => {
    const value = Number(String(raw ?? "").trim());
    return String(raw ?? "").trim() && Number.isFinite(value) && value >= floor ? value : fallback;
  };
  // How long a finished conversation stays replayable. 0 turns rollover off.
  const ROLLOVER_MAX_AGE_MIN = num(env.ROLLOVER_MAX_AGE_MIN, DEFAULT_ROLLOVER_MAX_AGE_MIN);
  // Conversation turns expire; structured events don't. 0 keeps turns forever.
  const TURN_RETENTION_DAYS = num(env.ARCHIVE_TURN_RETENTION_DAYS, DEFAULT_TURN_RETENTION_DAYS);
  // Habit scan cadence. 0 turns Tier D off entirely.
  const HABIT_SCAN_INTERVAL_H = num(env.HABIT_SCAN_INTERVAL_H, 6);

  // ---- Memory archive (Plan 10, Tier C) ----

  // Last sign of a live session. The habit pass reads month files, and there
  // is no reason to do that while someone is talking.
  let lastActivityAt = 0;
  const SESSION_QUIET_MS = 2 * 60 * 1000;
  const noteActivity = () => { lastActivityAt = Date.now(); };

  // Fire-and-forget in every caller: capture must degrade, never break the
  // voice path. Sanitization is authoritative here rather than in the browser,
  // for the same reason the rollover's is — the client is untrusted input even
  // when it's ours.
  //
  // Writes are serialized through a promise chain, like createStore's: two
  // appends racing on the same month file have no ordering guarantee, and an
  // append-only log with interleaved lines is a log with a hole in it.
  let archiveWrites = Promise.resolve(0);
  function archive(events) {
    const rows = (Array.isArray(events) ? events : [events])
      .slice(0, MAX_BATCH_EVENTS)
      .map(event => sanitizeEvent(event))
      .filter(Boolean);
    if (!rows.length) return archiveWrites.then(() => 0);
    archiveWrites = archiveWrites
      .then(() => appendEvents(archiveDir, rows))
      .catch((err) => {
        console.warn(`  ⚠  archive: couldn't write ${rows.length} event(s) — ${err.message || err}`);
        return 0;
      });
    return archiveWrites;
  }

  // A list PUT carries the whole map, not the edit. Diffing is what turns
  // "another device saved a different shopping list" into "oat milk was added"
  // — the row Tier D's recurring-purchase rule counts, and the only capture
  // path for a device that isn't the one running the session.
  function diffLists(before = {}, after = {}) {
    const events = [];
    const counts = (items = []) => {
      const map = new Map();
      for (const item of items) map.set(item, (map.get(item) || 0) + 1);
      return map;
    };
    for (const list of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const was = counts(before[list]);
      const now = counts(after[list]);
      for (const [item, n] of now) {
        for (let i = 0; i < n - (was.get(item) || 0); i++) {
          events.push({ kind: "list", name: list, args: { action: "add", list, item },
            summary: `added ${item} to ${list}` });
        }
      }
      for (const [item, n] of was) {
        for (let i = 0; i < n - (now.get(item) || 0); i++) {
          events.push({ kind: "list", name: list, args: { action: "remove", list, item },
            summary: `removed ${item} from ${list}` });
        }
      }
    }
    return events.slice(0, MAX_BATCH_EVENTS);
  }

  // ---- Learned habits (Plan 10, Tier D) ----

  // Long enough for the widest rule (recurring purchases, six weeks).
  const HABIT_WINDOW_DAYS = 42;

  async function runHabitScan({ now = Date.now(), force = false } = {}) {
    if (!force && now - lastActivityAt < SESSION_QUIET_MS) return null;
    let rows;
    try {
      rows = await readRange(archiveDir, new Date(now - HABIT_WINDOW_DAYS * 86400000).toISOString(), null);
    } catch {
      return null; // no archive yet, or unreadable — nothing to notice
    }
    const detected = detectHabits(rows, { now });
    let summary = null;
    await memory.update((cur) => {
      const merged = mergeSuggestions(cur.suggestions, detected, { now: () => now });
      // Decay (§9): habits end. Re-measure the rule behind every accepted
      // derived fact and retire the ones that have quietly stopped being true.
      // The fact is kept — a habit resuming should simply restore it.
      let facts = cur.facts;
      let retired = 0;
      let restored = 0;
      for (const fact of cur.facts) {
        if (fact.source !== "derived" || !fact.rule || fact.supersededBy) continue;
        const decayed = isDecayed(fact.rule, measureHabit(fact, rows, { now }));
        if (decayed !== Boolean(fact.stale)) decayed ? retired++ : restored++;
        facts = setFactStale(facts, fact.id, decayed);
      }
      summary = {
        proposed: merged.added,
        pending: pendingSuggestions(merged.suggestions).length,
        retired,
        restored,
      };
      return {
        ...cur,
        facts,
        suggestions: merged.suggestions,
        lastScanAt: new Date(now).toISOString(),
      };
    });
    return summary;
  }

  // Expired turn rows are dropped on the same off-session moment as the scan,
  // at most once a day — the sweep re-reads old month files, so there is no
  // point doing it four times.
  async function runSweep({ now = Date.now() } = {}) {
    const last = memory.get().lastSweepAt;
    if (last && now - Date.parse(last) < 24 * 60 * 60 * 1000) return null;
    let result;
    try {
      result = await sweepArchive(archiveDir, { now, turnRetentionDays: TURN_RETENTION_DAYS });
    } catch {
      return null;
    }
    await memory.update((cur) => ({ ...cur, lastSweepAt: new Date(now).toISOString() }));
    if (result.removed) {
      console.log(`  memory: archive sweep dropped ${result.removed} expired turn(s).`);
    }
    return result;
  }

  // A plain setInterval at boot: no cron, no new container, no new dependency.
  // The due check reads the persisted lastScanAt, so a container restart never
  // triggers an immediate rescan.
  let scanTimer = null;
  if (HABIT_SCAN_INTERVAL_H > 0) {
    const intervalMs = HABIT_SCAN_INTERVAL_H * 60 * 60 * 1000;
    scanTimer = setInterval(() => {
      const last = Date.parse(memory.get().lastScanAt || "");
      if (Number.isFinite(last) && Date.now() - last < intervalMs) return;
      runSweep().catch(() => {});
      runHabitScan().catch(() => {});
    }, Math.min(intervalMs, 15 * 60 * 1000));
    scanTimer.unref?.(); // never hold the process open for a habit count
  }

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

  // Calendar. Two halves that answer different questions:
  //
  //   ICS_URL          — a subscription feed. HTTP GET, so read-only forever.
  //   Google Calendar  — OAuth, and the only one of the two that can be
  //                      written to. When connected it is also the better
  //                      reader: Google expands recurrence server-side, which
  //                      lib/ics.js only approximates.
  //
  // Reads merge whichever are available (a household may point ICS_URL at a
  // work calendar and connect Google for the personal one); writes always go
  // to Google, because nothing else here can accept them.
  const ICS_URL = env.ICS_URL || "";
  const ICS_CACHE_MS = 15 * 60 * 1000;
  let icsCache = null; // { at, text }

  const googleStore = createStore(path.join(dataDir, "google.json"), { google: {} });
  const gcal = createGoogleCalendar({
    clientId: env.GOOGLE_CLIENT_ID || "",
    clientSecret: env.GOOGLE_CLIENT_SECRET || "",
    calendarId: env.GOOGLE_CALENDAR_ID || "primary",
    store: googleStore,
  });
  // Google requires an exact match against a registered redirect URI, so the
  // env override is the escape hatch when Nova is reached by any name other
  // than the one the browser is using right now.
  const googleRedirectUri = (req) => {
    if (env.GOOGLE_REDIRECT_URI) return env.GOOGLE_REDIRECT_URI;
    const host = req.headers.host || `localhost:${env.PORT || 3000}`;
    return `${httpsOptions ? "https" : "http"}://${host}/api/google/callback`;
  };

  async function fetchIcsEvents(windowStart, windowEnd) {
    if (!icsCache || Date.now() - icsCache.at > ICS_CACHE_MS) {
      const resp = await fetch(ICS_URL, { signal: AbortSignal.timeout(8000) });
      if (!resp.ok) throw new Error(`Calendar feed returned HTTP ${resp.status}`);
      icsCache = { at: Date.now(), text: await resp.text() };
    }
    const { events, unsupported } = expandEvents(parseIcs(icsCache.text), windowStart, windowEnd);
    return {
      unsupported,
      events: events.map(e => ({
        id: "",
        summary: e.summary,
        start_iso: new Date(e.start).toISOString(),
        end_iso: new Date(e.end).toISOString(),
        all_day: e.allDay,
        source: "ics",
      })),
    };
  }

  async function fetchCalendar(days) {
    const now = Date.now();
    const windowStart = now - 60 * 60 * 1000;
    const windowEnd = now + days * 24 * 60 * 60 * 1000;
    const notes = [];
    let events = [];

    if (gcal.connected()) {
      // A dead Google connection must not black out a working ICS feed.
      try {
        events = await gcal.listEvents({ timeMin: windowStart, timeMax: windowEnd, maxResults: 25 });
      } catch (err) {
        if (!ICS_URL) throw err;
        notes.push("Google Calendar couldn't be reached");
      }
    }
    if (ICS_URL) {
      try {
        const ics = await fetchIcsEvents(windowStart, windowEnd);
        // The common setup points ICS_URL at the very calendar Google is
        // already serving, so the same event arrives twice. Same title at the
        // same minute is one event.
        const seen = new Set(events.map(e => `${e.summary}|${e.start_iso.slice(0, 16)}`));
        for (const e of ics.events) {
          if (seen.has(`${e.summary}|${e.start_iso.slice(0, 16)}`)) continue;
          events.push(e);
        }
        if (ics.unsupported) notes.push("some repeating events couldn't be read");
      } catch (err) {
        if (!events.length) throw err;
        notes.push("the subscribed feed couldn't be reached");
      }
    }

    events.sort((a, b) => a.start_iso.localeCompare(b.start_iso));
    return {
      events: events.slice(0, 15),
      writable: gcal.connected(),
      ...(notes.length ? { note: notes.join("; ") } : {}),
    };
  }

  // Shared by the three write endpoints: they differ only in what they do with
  // a validated draft, and all three answer with the same failure vocabulary.
  function calendarWriteGuard(res) {
    if (!gcal.configured) {
      res.writeHead(501, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Google Calendar isn't configured on this server." }));
      return false;
    }
    if (!gcal.connected()) {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Google Calendar isn't connected yet.", needs_connect: true }));
      return false;
    }
    return true;
  }

  function calendarWriteFailed(res, err) {
    const status = err instanceof GoogleCalendarError ? err.status || 502 : 502;
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      error: String(err?.message || err),
      ...(err?.needsReconnect ? { needs_connect: true } : {}),
    }));
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
  function sessionConfig(prefs = {}, facts = []) {
    return {
      session: {
        type: "realtime",
        model: REALTIME_MODEL,
        instructions: INSTRUCTIONS + buildAboutBlock(prefs, facts),
        audio: {
          output: { voice: prefs.voice || VOICE },
        },
      },
    };
  }

  async function mintClientSecret(prefs, facts) {
    const resp = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(sessionConfig(prefs, facts)),
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
        noteActivity();
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
        // Remembered facts (Plan 9) live server-side and are never posted from
        // the browser — that keeps them shared across devices and removes a
        // whole class of injection at the same time.
        const mem = memory.get();
        const { facts, dropped } = factsForPrompt(mem.facts);
        if (dropped) {
          console.warn(`  ⚠  memory: ${dropped} fact(s) left out of the prompt (over the size cap).`);
        }
        try {
          const secret = await mintClientSecret(prefs, facts);
          const rollover = rolloverForSession(mem.rollover, { maxAgeMin: ROLLOVER_MAX_AGE_MIN });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            value: secret.value,
            model: REALTIME_MODEL,
            // Rides back on the response the client already waits for, so
            // rehydration costs no extra round trip on the startup path.
            rollover: rollover ? { text: renderRolloverText(rollover.turns) } : null,
          }));
        } catch (err) {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(err.message || err) }));
        }
        return;
      }

      // ---- Memory (Plan 9). Same LAN trust level as the lists above. ----
      if (req.url.split("?")[0] === "/api/memory/facts") {
        // Only id and text go back to the client: tool results are read aloud,
        // so they stay small and speakable.
        const speakable = (f) => ({ id: f.id, text: f.text });
        if (req.method === "GET") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ facts: activeFacts(memory.get().facts).map(speakable) }));
          return;
        }
        if (req.method === "POST") {
          let body;
          try { body = JSON.parse(await readBody(req)); } catch { body = null; }
          let result = { error: "Unknown action." };
          if (body?.action === "add" || body?.action === "forget") {
            await memory.update((cur) => {
              result = body.action === "add"
                ? addFact(cur.facts, { text: body.text, replaces: body.replaces, source: "speech" })
                : forgetFact(cur.facts, body.id);
              if (result.error) return null; // no write, no rev bump
              return { ...cur, facts: result.facts };
            });
          }
          if (result.error) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: result.error }));
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result.fact
            ? { ok: true, fact: speakable(result.fact) }
            : { ok: true, forgot: speakable(result.forgotten) }));
          return;
        }
        res.writeHead(405); res.end(); return;
      }

      // ---- Memory archive (Plan 10). ----

      // Batched capture from the client. POST-only because sendBeacon can't do
      // anything else, and the pagehide flush is what makes an unclean drop
      // cost seconds of history rather than a session of it.
      if (req.url.split("?")[0] === "/api/memory/archive") {
        if (req.method === "POST") {
          noteActivity();
          let body;
          try { body = JSON.parse(await readBody(req)); } catch { body = null; }
          const stored = await archive(body?.events || []);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, stored }));
          return;
        }
        res.writeHead(405); res.end(); return;
      }

      // The recall read path. POST, not GET with a query string: the query is
      // household conversation content and has no business in a URL or an
      // access log.
      if (req.url.split("?")[0] === "/api/memory/recall") {
        if (req.method === "POST") {
          noteActivity();
          let body;
          try { body = JSON.parse(await readBody(req)); } catch { body = null; }
          const query = String(body?.query || "").slice(0, 200);
          if (!query.trim()) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "A query is required." }));
            return;
          }
          let result;
          try {
            result = await scanArchive(archiveDir, {
              query,
              kind: body?.kind,
              since: body?.since,
              until: body?.until,
              limit: RECALL_LIMIT,
            });
          } catch {
            // A missing or unreadable archive is an honest "no record", not an
            // error the model has to interpret.
            result = { found: false, events: [], scanned: 0, oversized: 0 };
          }
          // Logged from day one with its arguments: the cost argument for Tier
          // C rests on this being called rarely, and that can't be tuned
          // without knowing what triggered it (plans/10 "Before you start" A).
          console.log(`  memory: recall ${JSON.stringify({ query, kind: body?.kind, since: body?.since, until: body?.until })}` +
            ` → ${result.events.length} of ${result.scanned} row(s)`);
          if (result.oversized) {
            console.warn(`  ⚠  memory: a month file holds ${result.oversized} rows — past the point where ` +
              `the substring scan is worth replacing with a keyword index (see plans/10 "Deferred").`);
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          // found:false explicitly, never an empty array — an empty list reads
          // to the model as success, and the failure mode that produces is a
          // confident, fabricated answer about the household's own past.
          res.end(JSON.stringify(result.found
            ? { found: true, events: result.events.map(e => ({ at: e.at, kind: e.kind, name: e.name, summary: e.summary })) }
            : { found: false }));
          return;
        }
        res.writeHead(405); res.end(); return;
      }

      // Habit suggestions (Tier D). Accept is the only path from a noticed
      // pattern into the system prompt, and it is a button, not a scan result.
      if (req.url.split("?")[0] === "/api/memory/suggestions") {
        const speakable = (s) => ({ id: s.id, text: s.text, support: s.support });
        if (req.method === "GET") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ suggestions: pendingSuggestions(memory.get().suggestions).map(speakable) }));
          return;
        }
        if (req.method === "POST") {
          let body;
          try { body = JSON.parse(await readBody(req)); } catch { body = null; }
          // "ask" claims the next suggestion for Nova to raise out loud and
          // stamps it, so she raises it once no matter how many routines run.
          if (body?.action === "ask") {
            let claimed = null;
            await memory.update((cur) => {
              const result = askSuggestion(cur.suggestions);
              claimed = result.suggestion;
              if (!claimed) return null;
              return { ...cur, suggestions: result.suggestions };
            });
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ suggestion: claimed ? speakable(claimed) : null }));
            return;
          }
          let result = { error: "Unknown action." };
          if (body?.action === "accept" || body?.action === "dismiss") {
            await memory.update((cur) => {
              result = body.action === "accept"
                ? acceptSuggestion(cur, body.id)
                : dismissSuggestion(cur.suggestions, body.id);
              if (result.error) return null; // no write, no rev bump
              return { ...cur, ...(result.facts ? { facts: result.facts } : {}), suggestions: result.suggestions };
            });
          }
          if (result.error) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: result.error }));
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, ...(result.fact ? { fact: { id: result.fact.id, text: result.fact.text } } : {}) }));
          return;
        }
        res.writeHead(405); res.end(); return;
      }

      // POST as well as PUT: the client flushes on pagehide via sendBeacon,
      // which can only POST.
      if (req.url.split("?")[0] === "/api/memory/rollover") {
        if (req.method === "PUT" || req.method === "POST") {
          noteActivity();
          let body;
          try { body = JSON.parse(await readBody(req)); } catch { body = null; }
          const rollover = sanitizeRollover(body);
          if (!rollover) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Bad rollover payload" }));
            return;
          }
          await memory.update((cur) => ({ ...cur, rollover }));
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        res.writeHead(405); res.end(); return;
      }

      // Which optional integrations are live (non-secret config only).
      if (req.method === "GET" && req.url.split("?")[0] === "/api/config") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          homeAssistant: HA_ENABLED,
          calendar: Boolean(ICS_URL) || gcal.connected(),
          // Whether Nova may *create* events, and whether there is a connect
          // flow worth offering. The refresh token itself never appears here.
          calendarWritable: gcal.connected(),
          googleConfigured: gcal.configured,
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
          // Every real device change is recorded here, whichever device asked
          // for it — this is the row Tier D's device rule counts.
          archive({
            kind: "device",
            name: call.entity_id,
            args: {
              action: call.service === "turn_on" ? "on" : call.service === "turn_off" ? "off" : "set",
              ...(typeof call.data?.temperature === "number" ? { value: call.data.temperature } : {}),
            },
            ok: true,
            summary: `${call.entity_id} ${call.service.replace(/_/g, " ")}`,
          }).catch(() => {});
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(err.message || err) }));
        }
        return;
      }

      if (req.method === "GET" && req.url.split("?")[0] === "/api/calendar") {
        if (!ICS_URL && !gcal.connected()) { res.writeHead(404); res.end(); return; }
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

      // ---- Calendar writes. Google only; see the fetchCalendar comment. ----

      if (req.url.split("?")[0] === "/api/calendar/events") {
        if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
        if (!calendarWriteGuard(res)) return;
        noteActivity();
        let draft;
        try { draft = JSON.parse(await readBody(req)); } catch { draft = null; }
        const timeZone = isValidTimeZone(draft?.timezone)
          ? draft.timezone
          : Intl.DateTimeFormat().resolvedOptions().timeZone;
        const { event, error } = buildEventResource(draft || {}, { timeZone });
        if (error) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error }));
          return;
        }
        try {
          const created = await gcal.createEvent(event);
          // Same rationale as the Home Assistant call above: a real, durable
          // change to something outside Nova gets a row whichever device asked.
          archive({
            kind: "calendar",
            name: created.summary,
            args: { action: "create", start: created.start_iso },
            ok: true,
            summary: `calendar event created: ${created.summary}`,
          }).catch(() => {});
          res.writeHead(201, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, event: created }));
        } catch (err) {
          calendarWriteFailed(res, err);
        }
        return;
      }

      if (req.url.split("?")[0].startsWith("/api/calendar/events/")) {
        const id = decodeURIComponent(req.url.split("?")[0].slice("/api/calendar/events/".length));
        if (!id) { res.writeHead(404); res.end(); return; }
        if (req.method !== "PATCH" && req.method !== "DELETE") { res.writeHead(405); res.end(); return; }
        if (!calendarWriteGuard(res)) return;
        noteActivity();

        if (req.method === "DELETE") {
          try {
            // Read first so the archive row and the spoken confirmation can
            // name what was cancelled rather than an opaque id.
            let summary = "";
            try { summary = (await gcal.getEvent(id))?.summary || ""; } catch {}
            await gcal.deleteEvent(id);
            archive({
              kind: "calendar",
              name: summary || id,
              args: { action: "cancel" },
              ok: true,
              summary: `calendar event cancelled: ${summary || id}`,
            }).catch(() => {});
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, summary }));
          } catch (err) {
            calendarWriteFailed(res, err);
          }
          return;
        }

        let patch;
        try { patch = JSON.parse(await readBody(req)); } catch { patch = null; }
        if (!patch || typeof patch !== "object") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Bad event patch." }));
          return;
        }
        const timeZone = isValidTimeZone(patch.timezone)
          ? patch.timezone
          : Intl.DateTimeFormat().resolvedOptions().timeZone;
        try {
          // A patch may change only the title, only the time, or both. Times
          // are validated as a pair, so re-running the full builder against
          // the merged before/after state is what keeps "move it an hour
          // later" from producing an event that ends before it starts.
          const current = await gcal.getEvent(id);
          if (!current) { res.writeHead(404); res.end(); return; }
          const local = (iso, allDay) => isoToLocal(iso, timeZone, { dateOnly: allDay });
          const allDay = patch.all_day === undefined ? current.all_day : Boolean(patch.all_day);
          // Moving an event keeps its length. "Move the standup to four"
          // says nothing about duration, and defaulting to an hour would
          // quietly stretch a fifteen-minute meeting.
          const heldDuration = Math.max(
            1, Math.round((new Date(current.end_iso) - new Date(current.start_iso)) / 60000)
          );
          const movedTimed = Boolean(patch.start) && !allDay;
          const merged = {
            summary: patch.summary ?? current.summary,
            location: patch.location ?? current.location,
            description: patch.description,
            all_day: allDay,
            start: patch.start ?? local(current.start_iso, allDay),
            end: patch.end ?? (patch.start ? undefined : local(current.end_iso, allDay)),
            ...(patch.duration_minutes !== undefined
              ? { duration_minutes: patch.duration_minutes }
              : movedTimed && current.all_day === allDay
                ? { duration_minutes: heldDuration }
                : {}),
          };
          // The all-day equivalent: a three-day trip moved to a new start day
          // is still three days.
          if (allDay && patch.start && !patch.end && current.all_day) {
            const spanDays = Math.max(1, Math.round(
              (new Date(current.end_iso) - new Date(current.start_iso)) / 86400000
            ));
            // merged.end is the inclusive last day — the builder is what turns
            // it back into Google's exclusive one.
            const shifted = new Date(`${patch.start}T00:00:00Z`);
            shifted.setUTCDate(shifted.getUTCDate() + spanDays - 1);
            merged.end = shifted.toISOString().slice(0, 10);
          }
          const { event, error } = buildEventResource(merged, { timeZone });
          if (error) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error }));
            return;
          }
          const updated = await gcal.updateEvent(id, event);
          archive({
            kind: "calendar",
            name: updated.summary,
            args: { action: "update", start: updated.start_iso },
            ok: true,
            summary: `calendar event moved: ${updated.summary}`,
          }).catch(() => {});
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, event: updated }));
        } catch (err) {
          calendarWriteFailed(res, err);
        }
        return;
      }

      // ---- Google OAuth. Browser-facing, not called by the model. ----

      if (req.method === "GET" && req.url.split("?")[0] === "/api/google/auth") {
        if (!gcal.configured) {
          res.writeHead(501, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env first.");
          return;
        }
        res.writeHead(302, { Location: gcal.beginAuth(googleRedirectUri(req)) });
        res.end();
        return;
      }

      if (req.method === "GET" && req.url.split("?")[0] === "/api/google/callback") {
        const params = new URL(req.url, "http://x").searchParams;
        const page = (title, detail) =>
          `<!doctype html><meta charset="utf-8"><title>Nova — ${title}</title>` +
          `<body style="font:16px system-ui;background:#0a0e14;color:#e6edf3;padding:3rem">` +
          `<h1 style="color:#00d4ff">${title}</h1><p>${detail}</p>` +
          `<p><a style="color:#00d4ff" href="/">Back to Nova</a></p>`;
        const fail = (detail) => {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end(page("Couldn&rsquo;t connect", detail));
        };
        if (params.get("error")) return void fail("Google reported: " + escapeHtml(params.get("error")));
        if (!gcal.checkState(params.get("state"))) {
          return void fail("That sign-in link was stale or unexpected. Start again from Nova.");
        }
        const code = params.get("code");
        if (!code) return void fail("Google didn&rsquo;t send an authorization code.");
        try {
          await gcal.connect(code, googleRedirectUri(req));
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(page("Calendar connected", "Nova can now read and create events on your Google Calendar."));
        } catch (err) {
          fail(escapeHtml(String(err?.message || err)));
        }
        return;
      }

      if (req.method === "POST" && req.url.split("?")[0] === "/api/google/disconnect") {
        await gcal.disconnect();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
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
          let changes = [];
          const next = await store.update((cur) => {
            if (body.rev !== cur.rev) { conflict = true; return null; }
            changes = diffLists(cur.lists, body.lists);
            return { ...cur, lists: body.lists };
          });
          if (conflict) {
            // Stale client: hand back current state so it can re-apply on top.
            res.writeHead(409, { "Content-Type": "application/json" });
            res.end(JSON.stringify(next));
            return;
          }
          // Archived here rather than in the client, so an edit made on the
          // tablet is captured on the box that isn't running the session.
          archive(changes).catch(() => {});
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
    // The volume measurement plans/10 "Before you start" B asks for, reported
    // rather than left to someone remembering to look.
    archive: archiveStats(archiveDir),
    googleConfigured: gcal.configured,
    googleConnected: gcal.connected(),
  };
  // Tier D runs on a timer measured in hours, and archive writes complete
  // after the response that triggered them; tests and any future manual
  // trigger need a way in that doesn't involve waiting for either.
  server.novaMemory = { runHabitScan, runSweep, settled: () => archiveWrites };
  server.on("close", () => { if (scanTimer) clearInterval(scanTimer); });
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
      const { model, voice, https: tls, hasKey, archive, googleConfigured, googleConnected } = server.novaInfo;
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
      if (archive.length) {
        const kb = Math.round(archive.reduce((sum, m) => sum + m.bytes, 0) / 1024);
        console.log(`  memory: archive ${archive.length} month(s), ${kb} KB`);
      }
      if (googleConfigured && !googleConnected) {
        console.log(`  calendar: open ${proto}://localhost:${PORT}/api/google/auth to connect Google Calendar`);
      } else if (googleConnected) {
        console.log(`  calendar: Google connected (read/write)`);
      }
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
