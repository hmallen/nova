// Nova — Alexa-style voice assistant on the OpenAI Realtime API.
//
// This server does exactly two things:
//   1. Serves the static client from ./public
//   2. Mints short-lived Realtime "client secrets" (ephemeral tokens) so the
//      browser can open a WebRTC session directly with OpenAI without ever
//      seeing the real API key.
//
// Zero npm dependencies — Node 18+ only.

import http from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const PORT = Number(process.env.PORT || 3000);

// Minimal .env loader so no dotenv dependency is needed.
const envPath = path.join(__dirname, ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
// Latest generation realtime speech-to-speech model (July 2026).
// Override with REALTIME_MODEL=gpt-realtime-2.1-mini for lower cost/latency.
const REALTIME_MODEL = process.env.REALTIME_MODEL || "gpt-realtime-2.1";
const VOICE = process.env.REALTIME_VOICE || "marin";
// Voices the client may request via saved preferences (mirrored in app.js).
const ALLOWED_VOICES = ["marin", "cedar", "alloy"];

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
- You have tools for the current date and time, timers, alarms, weather,
  shopping and to-do lists, simulated smart-home devices, ambient sounds, and
  speaker volume. Always use the matching tool instead of guessing — for
  example, never state the time or weather from memory.
- You can also set reminders ("remind me to X at Y"), repeating alarms, and
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
`.trim();

// Read a small JSON request body (also used by the list-sync endpoints).
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

// Prefs arrive from the browser and get spliced into the system prompt —
// treat as untrusted: allowlist enums, truncate free text, strip newlines.
function sanitizePrefs(raw) {
  const prefs = {};
  if (!raw || typeof raw !== "object") return prefs;
  const clean = (s) => String(s).replace(/[\r\n]+/g, " ").trim().slice(0, 60);
  if (typeof raw.name === "string" && raw.name.trim()) prefs.name = clean(raw.name);
  if (typeof raw.homeLabel === "string" && raw.homeLabel.trim()) prefs.homeLabel = clean(raw.homeLabel);
  if (raw.units === "fahrenheit" || raw.units === "celsius") prefs.units = raw.units;
  if (ALLOWED_VOICES.includes(raw.voice)) prefs.voice = raw.voice;
  return prefs;
}

// Session template. Tool definitions live in the client (public/app.js)
// alongside their implementations and are attached via session.update once the
// data channel opens.
function sessionConfig(prefs = {}) {
  let instructions = INSTRUCTIONS;
  const about = [];
  if (prefs.name) about.push(`- Name: ${prefs.name} — address them by name occasionally, not every turn.`);
  if (prefs.homeLabel) about.push(`- Home: ${prefs.homeLabel} — assume this for weather and time-of-day context.`);
  if (prefs.units) about.push(`- Units: ${prefs.units}.`);
  if (about.length) {
    instructions += `\n\nAbout this user (from saved preferences):\n${about.join("\n")}`;
  }
  return {
    session: {
      type: "realtime",
      model: REALTIME_MODEL,
      instructions,
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

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
};

const server = http.createServer(async (req, res) => {
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
});

server.listen(PORT, () => {
  console.log(`\n  Nova voice assistant`);
  console.log(`  → http://localhost:${PORT}`);
  console.log(`  model: ${REALTIME_MODEL}, voice: ${VOICE}`);
  if (!OPENAI_API_KEY) {
    console.warn(`\n  ⚠  OPENAI_API_KEY not set — copy .env.example to .env and add your key.\n`);
  }
});
