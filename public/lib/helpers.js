// Pure helpers shared between the browser client (app.js imports this as an
// ES module) and the Node test suite (which imports it directly) — Plan 8.

export function describeWeatherCode(code) {
  const map = {
    0: "Clear sky", 1: "Mostly clear", 2: "Partly cloudy", 3: "Overcast",
    45: "Foggy", 48: "Icy fog", 51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle",
    56: "Freezing drizzle", 57: "Freezing drizzle", 61: "Light rain", 63: "Rain",
    65: "Heavy rain", 66: "Freezing rain", 67: "Freezing rain", 71: "Light snow",
    73: "Snow", 75: "Heavy snow", 77: "Snow grains", 80: "Light showers",
    81: "Showers", 82: "Heavy showers", 85: "Snow showers", 86: "Snow showers",
    95: "Thunderstorm", 96: "Thunderstorm with hail", 99: "Thunderstorm with hail",
  };
  return map[code] || "Unknown conditions";
}

// Speakable label for a set of weekday numbers (0=Sun … 6=Sat).
export function formatDays(days) {
  const sorted = [...days].sort((a, b) => a - b);
  if (sorted.length === 7) return "daily";
  if (sorted.join() === "1,2,3,4,5") return "M–F";
  if (sorted.join() === "0,6") return "weekends";
  return sorted.map(d => "SMTWTFS"[d]).join(" ");
}

// Routine steps are a tool-name string or { tool, args }.
export function routineStepNames(steps) {
  return steps.map(s => (typeof s === "string" ? s : s?.tool));
}

// Compact stopwatch display: M:SS until the first hour, then H:MM:SS.
export function formatElapsedTime(elapsedMs) {
  const ms = Number(elapsedMs);
  const totalSeconds = Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mm = hours ? String(minutes).padStart(2, "0") : String(minutes);
  return `${hours ? `${hours}:` : ""}${mm}:${String(seconds).padStart(2, "0")}`;
}

// User-selected Smart Home entities are stored as stable string keys. Keep
// malformed or repeated localStorage values from leaking into the UI.
export function normalizePinnedDeviceKeys(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(key => typeof key === "string" && key.trim()).map(key => key.trim()))];
}

// ---- Wake word & idle timeout ----

// The browser's speech recognizer is tuned for phrases, not names, and "Nova"
// comes back as "no va", "novah" or "Noah" often enough that an exact match
// misses most of the time. Interim results arrive as a growing phrase, so this
// looks anywhere in the string rather than anchoring to the start.
//
// False positives are cheap on purpose: a wake word only opens a session, and
// a session nobody talks to now closes itself (see the idle timeout below).
const WAKE_WORD_RE = /\b(?:no ?va[hs]?|noah|nowa|nofa)\b/;

export function matchesWakeWord(transcript) {
  // Punctuation and casing vary by engine and by interim-vs-final result;
  // flatten both so one spelling of the pattern covers every shape.
  const text = String(transcript || "").toLowerCase().replace(/[^a-z]+/g, " ");
  return WAKE_WORD_RE.test(text);
}

// A live Realtime session holds the microphone open and bills by the minute,
// so one that nobody is talking to has to end by itself — on a device with no
// keyboard or mouse, nothing else is going to end it.
export const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
const MIN_IDLE_TIMEOUT_MS = 10_000;         // below this, a thinking pause reads as idleness
const MAX_IDLE_TIMEOUT_MS = 30 * 60_000;

// Seconds, from `?idle=` or localStorage — a wall-mounted tablet has no way to
// edit a constant. "off" disables the timeout; anything unparseable falls back
// to the default rather than silently leaving a microphone open forever.
export function readIdleTimeoutMs(raw, fallback = DEFAULT_IDLE_TIMEOUT_MS) {
  if (raw === null || raw === undefined) return fallback;
  const text = String(raw).trim().toLowerCase();
  if (!text) return fallback;
  if (text === "off" || text === "never" || text === "0") return 0;
  const seconds = Number(text);
  if (!Number.isFinite(seconds) || seconds <= 0) return fallback;
  return Math.min(MAX_IDLE_TIMEOUT_MS, Math.max(MIN_IDLE_TIMEOUT_MS, Math.round(seconds * 1000)));
}

// ---- Memory archive (Plan 10, Tier C) ----

// A past instant the way a person would say it out loud. Recall results are
// read aloud, so the model never sees an ISO string — same treatment
// get_calendar gives event times.
export function spokenPastTime(iso, now = Date.now()) {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "at some point";
  const today = new Date(now);
  const midnight = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((midnight(today) - midnight(at)) / 86400000);
  const time = at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (days === 0) return `today at ${time}`;
  if (days === 1) return `yesterday at ${time}`;
  if (days > 1 && days < 7) return `${at.toLocaleDateString([], { weekday: "long" })} at ${time}`;
  return at.toLocaleDateString([], { month: "long", day: "numeric" });
}

// Tools that pull in text Nova doesn't control. Rows they produce are marked
// source "external" and stay out of recall results by default. Pairs with
// UNTRUSTED_TOOLS in lib/memory.js, which does the same job for the rollover.
export const EXTERNAL_TOOLS = ["get_news"];

// Recall shouldn't archive the act of recalling: a row per lookup would grow
// the file every time the model reads it and match every later query about
// the same subject.
export const ARCHIVE_SKIP_TOOLS = ["recall_memory"];

// The argument fields worth querying later, per tool. Everything else is
// dropped before the row is written — not only for size: retrieval quality
// degrades sharply when one record mixes topics, so a focused row beats a
// complete one. Tools absent from this map archive with no arguments at all.
const ARCHIVE_ARG_FIELDS = {
  get_weather: ["location"],
  manage_list: ["action", "list", "item"],
  control_device: ["device", "action", "value"],
  set_timer: ["label", "minutes"],
  start_stopwatch: ["label"],
  set_alarm: ["time", "label"],
  set_reminder: ["text", "datetime"],
  snooze: ["minutes"],
  cancel_timer_or_alarm: ["label"],
  get_news: ["topic"],
  play_ambient_sound: ["sound"],
  run_routine: ["name"],
  manage_routine: ["action", "name", "step_tool"],
  get_calendar: ["days"],
  set_volume: ["level", "direction"],
  // Deliberately action-only. What was remembered is already a fact in
  // memory.json; copying the text into an append-only log would put the most
  // sensitive thing the user ever says somewhere "forget that" can't reach.
  manage_preferences: ["action"],
  remember: ["action"],
};

export function redactArgs(name, args = {}) {
  const fields = ARCHIVE_ARG_FIELDS[name];
  if (!fields || !args || typeof args !== "object") return {};
  const out = {};
  for (const field of fields) {
    const value = args[field];
    const kind = typeof value;
    if (kind === "string" ? value.trim() : kind === "number" || kind === "boolean") {
      out[field] = kind === "string" ? value.trim() : value;
    }
  }
  return out;
}

// One short line a person could read back. Only scalars survive, which is also
// what keeps fetched third-party text — news headlines arrive as objects —
// from ever reaching the summary.
export function summarizeToolResult(output) {
  if (!output || typeof output !== "object") return "";
  if (output.error) return String(output.error).slice(0, 200);
  const parts = [];
  for (const [key, value] of Object.entries(output)) {
    if (parts.length >= 4) break;
    if (key === "ok") continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      parts.push(`${key}: ${value}`);
    } else if (Array.isArray(value) && value.every(v => typeof v === "string") && value.length) {
      parts.push(`${key}: ${value.slice(0, 5).join(", ")}`);
    }
  }
  return parts.join(", ").slice(0, 200);
}
