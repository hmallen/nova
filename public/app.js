/* Nova — Alexa-style voice assistant on the OpenAI Realtime API (WebRTC).
 *
 * Flow (2026 best practice):
 *   1. POST /api/session → server mints an ephemeral client secret ("ek_...")
 *   2. Browser opens an RTCPeerConnection: mic track up, assistant audio down
 *      (or, in text mode, no mic at all — see sessionMode)
 *   3. SDP offer is POSTed to https://api.openai.com/v1/realtime/calls
 *   4. JSON events flow over the "oai-events" data channel
 *   5. Tools are registered via session.update; function calls are executed
 *      locally and results returned as function_call_output items.
 */

import {
  describeWeatherCode,
  formatDays,
  formatElapsedTime,
  normalizePinnedDeviceKeys,
  routineStepNames,
  redactArgs,
  summarizeToolResult,
  spokenPastTime,
  EXTERNAL_TOOLS,
  ARCHIVE_SKIP_TOOLS,
} from "./lib/helpers.js";

// ---------- DOM ----------
const ring = document.getElementById("ring");
const statusEl = document.getElementById("status");
const muteBtn = document.getElementById("muteBtn");
const wakeBtn = document.getElementById("wakeBtn");
const wakeHint = document.getElementById("wakeHint");
const transcriptEl = document.getElementById("transcript");
const assistantAudio = document.getElementById("assistantAudio");
const manageDevicesBtn = document.getElementById("manageDevicesBtn");
const devicePicker = document.getElementById("devicePicker");
const deviceSelect = document.getElementById("deviceSelect");
const addDeviceBtn = document.getElementById("addDeviceBtn");
const devicePickerHint = document.getElementById("devicePickerHint");

// ---------- Session state ----------
let pc = null;          // RTCPeerConnection
let dc = null;          // data channel
let micStream = null;
let micMuted = false;
let connected = false;
let assistantSpeaking = false;

// How the current session talks. "voice" is the ring: mic up, spoken replies.
// "text" is the type-to-Nova box: the mic is never opened and replies come
// back written. Only an explicit user action picks a mode — typing must never
// switch the microphone on by itself.
let sessionMode = "voice";
// Modality of the response currently in flight, so a tool-call follow-up
// answers in the same form as the turn that triggered it.
let lastTurnTextOnly = false;

// Auto-reconnect (Plan 5). Realtime has no session resume, so "reconnect"
// means a brand-new session started automatically; conversation history is
// gone, and Nova just acknowledges the blip.
let reconnectAttempts = 0;
let userStopped = false;      // set only by intentional stops — never auto-reconnect those
let wasReconnect = false;     // the next startSession() is an automatic retry
let reconnectTimer = null;
let pendingTypedMessage = null; // typed while disconnected → sent once the channel opens

// ---------- Assistant state (the "skills") ----------
const DEFAULT_PREFS = {
  name: null,          // "Sam"
  homeCity: null,      // "Portland" (as the user said it)
  homeLat: null, homeLon: null, homeLabel: null, // resolved+cached geocode
  units: "fahrenheit", // "fahrenheit" | "celsius"
  voice: null,         // null = server default
};

const PINNED_DEVICES_KEY = "nova.smartHome.pinnedEntities";

function loadPinnedDeviceKeys() {
  try {
    return normalizePinnedDeviceKeys(JSON.parse(localStorage.getItem(PINNED_DEVICES_KEY) || "null"));
  } catch {
    return [];
  }
}

const state = {
  timers: [],    // {id, kind:"timer",    label, endsAt, done}
  stopwatches: [], // {id, kind:"stopwatch", label, startedAt}
  alarms: [],    // {id, kind:"alarm",    label, time:"HH:MM", days:[0..6]|null, done, lastFiredOn:"YYYY-MM-DD"|null}
  reminders: [], // {id, kind:"reminder", text, at:epochMs, done, missed}
  lists: {},         // synced with the server (Plan 3); localStorage is only a crash backup
  listsRev: 0,
  listsOffline: false,
  devices: JSON.parse(localStorage.getItem("nova.devices") || "null") || {
    "living room light": { on: false },
    "bedroom light": { on: false },
    "kitchen light": { on: false },
    "fan": { on: false },
    "thermostat": { on: true, value: 70 },
  },
  pinnedDeviceKeys: loadPinnedDeviceKeys(),
  volume: 8, // 0-10
  prefs: { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem("nova.prefs") || "null") },
};

function savePrefs() {
  localStorage.setItem("nova.prefs", JSON.stringify(state.prefs));
}

function deviceName(key, device) {
  return device?.name || key;
}

function availableDeviceNames() {
  return Object.entries(state.devices).map(([key, device]) => deviceName(key, device));
}

function savePinnedDevices() {
  localStorage.setItem(PINNED_DEVICES_KEY, JSON.stringify(state.pinnedDeviceKeys));
}

// ---------- Routines (Plan 4) ----------
// Steps are a tool-name string (no args) or { tool, args }. Only
// no-interaction tools are legal, so a routine can never sit waiting on a
// geolocation prompt or set a surprise alarm.
const ROUTINE_ALLOWED_TOOLS = [
  "get_weather", "get_news", "daily_summary", "play_ambient_sound",
  "control_device", "manage_list", // manage_list is forced to action:"read"
];

const DEFAULT_ROUTINES = {
  "good morning": ["get_weather", "daily_summary", "get_news"],
  "good night": ["daily_summary", { tool: "play_ambient_sound", args: { sound: "rain" } }],
};

state.routines = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem("nova.routines") || "null");
    if (saved && typeof saved === "object") return saved;
  } catch {}
  return JSON.parse(JSON.stringify(DEFAULT_ROUTINES)); // seed on first load
})();

function saveRoutines() {
  localStorage.setItem("nova.routines", JSON.stringify(state.routines));
}

// Shared by get_weather and manage_preferences (home city is geocoded once,
// at set time, so weather lookups skip the round-trip later).
async function geocodeCity(location) {
  const geo = await fetch(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&language=en`
  ).then(r => r.json()).catch(() => null);
  const hit = geo?.results?.[0];
  if (!hit) return null;
  return {
    lat: hit.latitude,
    lon: hit.longitude,
    label: [hit.name, hit.admin1, hit.country_code].filter(Boolean).join(", "),
  };
}

// ---------- Integration config (Plan 7) ----------
// Fetched once at boot, before any session starts: the model should only be
// told about devices/calendar/radio that actually exist.
let appConfig = { homeAssistant: false, calendar: false, calendarWritable: false, googleConfigured: false, radio: [] };
// event_ref → Google event id, re-seeded on every get_calendar. Writes are
// addressed by ref so the model never has to repeat an opaque id back.
let calendarRefs = new Map();
const configReady = fetch("/api/config")
  .then(r => (r.ok ? r.json() : appConfig))
  .then(c => {
    appConfig = { homeAssistant: false, calendar: false, calendarWritable: false, googleConfigured: false, radio: [], ...c };
    if (appConfig.homeAssistant) initHaDevices();
    initCalendarCard();
    if (appConfig.calendar) {
      ROUTINE_ALLOWED_TOOLS.push("get_calendar");
      // The default morning routine gains the calendar when one exists.
      const morning = state.routines["good morning"];
      if (Array.isArray(morning) && !routineStepNames(morning).includes("get_calendar")) {
        morning.push("get_calendar");
        saveRoutines();
      }
    }
  })
  .catch(() => {});

function radioNames() {
  return (appConfig.radio || []).map(r => r.name);
}

// =====================================================================
// Tool definitions (sent to the model) + implementations (run locally)
// =====================================================================

// Built per-session (not a const): descriptions embed the real device names
// and the available radio streams, and get_calendar only registers when an
// ICS feed is configured.
function buildTools() {
  const tools = [
  {
    type: "function",
    name: "get_current_datetime",
    description: "Get the user's current local date and time. Always call this when asked about the time or date.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    type: "function",
    name: "set_timer",
    description: "Set a countdown timer.",
    parameters: {
      type: "object",
      properties: {
        minutes: { type: "number", description: "Minutes component" },
        seconds: { type: "number", description: "Seconds component" },
        label: { type: "string", description: "Optional name, e.g. 'pasta'" },
      },
      required: [],
    },
  },
  {
    type: "function",
    name: "start_stopwatch",
    description: "Start a stopwatch that counts elapsed time upward.",
    parameters: {
      type: "object",
      properties: {
        label: { type: "string", description: "Optional name, e.g. 'workout'" },
      },
      required: [],
    },
  },
  {
    type: "function",
    name: "set_alarm",
    description: "Set an alarm for a specific clock time today (or tomorrow if that time already passed), optionally repeating on given weekdays.",
    parameters: {
      type: "object",
      properties: {
        time: { type: "string", description: "24-hour time HH:MM, e.g. '07:30'" },
        label: { type: "string" },
        days: {
          type: "array",
          items: { type: "string", enum: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] },
          description: "For a repeating alarm, e.g. weekdays = [mon,tue,wed,thu,fri]. Omit for one-time.",
        },
      },
      required: ["time"],
    },
  },
  {
    type: "function",
    name: "set_reminder",
    description: "Set a reminder that Nova will announce at a specific time. " +
      "Resolve relative phrases ('in 20 minutes', 'tomorrow at 3pm') to an " +
      "absolute local datetime yourself; call get_current_datetime first if " +
      "you don't know the current time.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "What to remind the user about, phrased as said: 'take the chicken out'" },
        datetime: { type: "string", description: "Local datetime YYYY-MM-DDTHH:MM" },
      },
      required: ["text", "datetime"],
    },
  },
  {
    type: "function",
    name: "snooze",
    description: "Snooze the alarm, timer, or reminder that is currently ringing or just rang.",
    parameters: {
      type: "object",
      properties: {
        minutes: { type: "number", description: "Default 9" },
      },
      required: [],
    },
  },
  {
    type: "function",
    name: "cancel_timer_or_alarm",
    description: "Cancel a timer, stopwatch, alarm, or reminder by its label or text, or all of them. Use this to stop a stopwatch.",
    parameters: {
      type: "object",
      properties: {
        label: { type: "string", description: "Label to cancel; omit to cancel all" },
      },
      required: [],
    },
  },
  {
    type: "function",
    name: "get_weather",
    description: "Get current weather and today's forecast. Uses the user's own location if none is given.",
    parameters: {
      type: "object",
      properties: {
        location: { type: "string", description: "City name, e.g. 'Seattle'. Omit for the user's location." },
      },
      required: [],
    },
  },
  {
    type: "function",
    name: "manage_list",
    description: "Add to, remove from, read, or clear a named list (e.g. shopping, to-do).",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add", "remove", "read", "clear"] },
        list: { type: "string", description: "List name, default 'shopping'" },
        item: { type: "string", description: "Item text (for add/remove)" },
      },
      required: ["action"],
    },
  },
  {
    type: "function",
    name: "control_device",
    description: (appConfig.homeAssistant
      ? "Control a smart-home device via Home Assistant."
      : "Control a simulated smart-home device.") +
      " Devices: " + availableDeviceNames().join(", ") + ".",
    parameters: {
      type: "object",
      properties: {
        device: { type: "string", description: "Device name, or 'all lights'" },
        action: { type: "string", enum: ["on", "off", "set"] },
        value: { type: "number", description: "For thermostat 'set': target temperature" },
      },
      required: ["device", "action"],
    },
  },
  {
    type: "function",
    name: "play_ambient_sound",
    description: "Play a synthesized ambient sound (rain, white noise, ocean)" +
      (radioNames().length
        ? ` or an internet radio stream (${radioNames().join(", ")}). Use radio when the user asks for music or a genre`
        : "") +
      ". Use when the user asks for music, sleep sounds, or background noise.",
    parameters: {
      type: "object",
      properties: {
        sound: { type: "string", enum: ["rain", "white noise", "ocean", ...radioNames()] },
      },
      required: ["sound"],
    },
  },
  {
    type: "function",
    name: "stop_ambient_sound",
    description: "Stop any playing ambient sound.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    type: "function",
    name: "get_news",
    description: "Get current news headlines, optionally about a topic. Read 3-5 of them " +
      "as a brief spoken news update, paraphrasing naturally — do not read URLs or bylines.",
    parameters: {
      type: "object",
      properties: {
        topic: { type: "string", description: "Optional topic, e.g. 'technology', 'Portland'" },
      },
      required: [],
    },
  },
  {
    type: "function",
    name: "daily_summary",
    description: "Get today's schedule: running timers and stopwatches, today's alarms, and reminders due today. " +
      "Use when the user asks what their day looks like.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    type: "function",
    name: "run_routine",
    description: "Run a named routine (a saved sequence of skills). Available routines are " +
      "in the result of manage_routine get. When the user says 'good morning' or 'good night', " +
      "run the matching routine and weave the results into ONE natural spoken update.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string" },
      },
      required: ["name"],
    },
  },
  {
    type: "function",
    name: "manage_routine",
    description: "List saved routines, create or delete one, or add/remove a skill step by tool name.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["get", "add_step", "remove_step", "create", "delete"] },
        name: { type: "string", description: "Routine name, e.g. 'good morning'" },
        step_tool: { type: "string", description: "Tool name for add_step/remove_step, e.g. 'get_news'" },
      },
      required: ["action"],
    },
  },
  {
    type: "function",
    name: "manage_preferences",
    description: "Read or update remembered user preferences: their name, home city, " +
      "temperature units (fahrenheit/celsius), and Nova's voice. Use when the user says " +
      "things like 'remember that…', 'call me…', 'I live in…', 'use celsius', 'change your voice'.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["get", "set", "clear"] },
        name: { type: "string" },
        home_city: { type: "string" },
        units: { type: "string", enum: ["fahrenheit", "celsius"] },
        voice: { type: "string", enum: ["marin", "cedar", "alloy"] }, // mirror server allowlist
      },
      required: ["action"],
    },
  },
  {
    type: "function",
    name: "remember",
    description: "Save, list, or forget an open-ended fact about the household — allergies, " +
      "family members, habits, anything that doesn't fit a set preference field. Use when the " +
      "user says 'remember that…', 'don't forget…', 'forget that…'. For their name, home city, " +
      "temperature units, or your voice, use manage_preferences instead.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add", "list", "forget", "accept", "dismiss"] },
        text: { type: "string", description: "add: the fact in your own words, one short sentence" },
        replaces: { type: "string", description: "add: id of the fact this one supersedes" },
        id: { type: "string", description: "forget: id of the fact to forget. accept/dismiss: id of the suggestion" },
      },
      required: ["action"],
    },
  },
  {
    type: "function",
    name: "recall_memory",
    // Deliberately narrow. The entire cost argument for the archive is that
    // this is called rarely — every invocation adds a full model round-trip,
    // so a tool that fires on ordinary questions would erase the advantage.
    description: "Look up something that happened in the past — what was on a list on an " +
      "earlier date, when a device was last changed, what was discussed days ago. Only use " +
      "this when the user asks about the PAST and you don't already know the answer. Never " +
      "use it for current state — use the normal skill for that.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to look for, in the user's own words" },
        kind: { type: "string", enum: ["tool", "turn", "list", "device"] },
        since: { type: "string", description: "ISO date, e.g. '2026-07-20'" },
        until: { type: "string", description: "ISO date" },
      },
      required: ["query"],
    },
  },
  {
    type: "function",
    name: "set_volume",
    description: "Set the assistant's speaker volume from 0 (mute) to 10 (max), or adjust up/down.",
    parameters: {
      type: "object",
      properties: {
        level: { type: "number", description: "Absolute level 0-10" },
        direction: { type: "string", enum: ["up", "down"], description: "Relative nudge instead of absolute level" },
      },
      required: [],
    },
  },
  ];
  if (appConfig.calendar) {
    tools.push({
      type: "function",
      name: "get_calendar",
      description: "Get the user's calendar events for today or the next few days. " +
        "Each event comes back with an event_ref you can pass to " +
        "update_calendar_event or cancel_calendar_event.",
      parameters: {
        type: "object",
        properties: {
          days: { type: "number", description: "1=today (default), up to 7" },
        },
        required: [],
      },
    });
  }
  if (appConfig.calendarWritable) {
    tools.push({
      type: "function",
      name: "create_calendar_event",
      description: "Add an event to the user's calendar. Resolve relative phrases " +
        "('tomorrow at 3', 'next Tuesday morning') to an absolute local datetime " +
        "yourself; call get_current_datetime first if you don't know the current " +
        "date. If the user didn't say how long it lasts, leave the duration out.",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", description: "Event title, as the user said it: 'dentist'" },
          start: { type: "string", description: "Local datetime YYYY-MM-DDTHH:MM, or YYYY-MM-DD when all_day" },
          end: { type: "string", description: "Optional local end datetime; omit to use duration_minutes" },
          duration_minutes: { type: "number", description: "Length in minutes when no end is given. Default 60." },
          all_day: { type: "boolean", description: "True for a whole-day event with no clock time" },
          location: { type: "string", description: "Optional place" },
        },
        required: ["summary", "start"],
      },
    });
    tools.push({
      type: "function",
      name: "update_calendar_event",
      description: "Change the time or title of an existing event. Call get_calendar " +
        "first to get its event_ref. Only include the fields that change.",
      parameters: {
        type: "object",
        properties: {
          event_ref: { type: "number", description: "The event_ref from get_calendar" },
          summary: { type: "string", description: "New title" },
          start: { type: "string", description: "New local start datetime YYYY-MM-DDTHH:MM" },
          end: { type: "string", description: "New local end datetime" },
          duration_minutes: { type: "number", description: "New length in minutes" },
          location: { type: "string" },
        },
        required: ["event_ref"],
      },
    });
    tools.push({
      type: "function",
      name: "cancel_calendar_event",
      description: "Delete an event from the calendar. Call get_calendar first to get " +
        "its event_ref. Only call this once the user has confirmed they mean to " +
        "cancel that specific event — it cannot be undone.",
      parameters: {
        type: "object",
        properties: {
          event_ref: { type: "number", description: "The event_ref from get_calendar" },
        },
        required: ["event_ref"],
      },
    });
  }
  return tools;
}

const toolHandlers = {
  async get_current_datetime() {
    const now = new Date();
    return {
      local_time: now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
      local_date: now.toLocaleDateString([], { weekday: "long", year: "numeric", month: "long", day: "numeric" }),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
  },

  async set_timer({ minutes = 0, seconds = 0, label }) {
    const totalMs = (minutes * 60 + seconds) * 1000;
    if (totalMs <= 0) return { error: "Timer duration must be positive." };
    const timer = {
      id: crypto.randomUUID(),
      kind: "timer",
      label: label || `${minutes ? minutes + " minute" : ""}${seconds ? " " + seconds + " second" : ""}`.trim() || "timer",
      endsAt: Date.now() + totalMs,
      done: false,
    };
    state.timers.push(timer);
    saveSchedules();
    renderTimers();
    return { ok: true, label: timer.label, duration_seconds: Math.round(totalMs / 1000) };
  },

  async start_stopwatch({ label }) {
    const stopwatch = {
      id: crypto.randomUUID(),
      kind: "stopwatch",
      label: String(label || "").trim() || "stopwatch",
      startedAt: Date.now(),
    };
    state.stopwatches.push(stopwatch);
    saveSchedules();
    renderTimers();
    return { ok: true, label: stopwatch.label };
  },

  async set_alarm({ time, label, days }) {
    if (!/^\d{1,2}:\d{2}$/.test(time || "")) return { error: "Time must be HH:MM (24-hour)." };
    if (time.length === 4) time = "0" + time; // engine compares zero-padded HH:MM
    const DAY_NUM = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
    let dayNums = null;
    if (Array.isArray(days) && days.length) {
      dayNums = [...new Set(days.map(d => DAY_NUM[String(d).slice(0, 3).toLowerCase()]).filter(n => n !== undefined))];
      if (!dayNums.length) return { error: "Unrecognized day names — use sun/mon/tue/wed/thu/fri/sat." };
    }
    const alarm = {
      id: crypto.randomUUID(), kind: "alarm", time, label: label || "alarm",
      days: dayNums, done: false, lastFiredOn: null,
    };
    state.alarms.push(alarm);
    saveSchedules();
    renderTimers();
    const [h, m] = time.split(":").map(Number);
    const spoken = new Date(2000, 0, 1, h, m).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    return { ok: true, label: alarm.label, time: spoken, repeats: dayNums ? formatDays(dayNums) : "one-time" };
  },

  async set_reminder({ text, datetime }) {
    if (!text) return { error: "No reminder text given." };
    // Local datetime only — reject UTC "Z" suffixes and missing minutes.
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(datetime || "")) {
      return { error: "datetime must be a local datetime like 2026-07-25T17:00." };
    }
    const at = new Date(datetime).getTime();
    if (!Number.isFinite(at)) return { error: "Could not parse that datetime." };
    if (at <= Date.now()) return { error: "That time is in the past — ask the user for a future time." };
    const reminder = { id: crypto.randomUUID(), kind: "reminder", text, at, done: false };
    state.reminders.push(reminder);
    saveSchedules();
    renderTimers();
    return { ok: true, text, due: new Date(at).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) };
  },

  async snooze({ minutes = 9 }) {
    if (!lastFired || Date.now() - lastFired.at > 5 * 60 * 1000) return { error: "Nothing to snooze." };
    stopChime(); // chime only — an ambient sound keeps playing
    const ms = Math.max(1, minutes) * 60 * 1000;
    if (lastFired.kind === "reminder") {
      const r = state.reminders.find(x => x.id === lastFired.id);
      if (r) { r.at = Date.now() + ms; r.done = false; r.missed = false; }
      else state.reminders.push({ id: crypto.randomUUID(), kind: "reminder", text: lastFired.label, at: Date.now() + ms, done: false });
    } else {
      state.timers.push({
        id: crypto.randomUUID(), kind: "timer",
        label: `snoozed ${lastFired.label}`, endsAt: Date.now() + ms, done: false,
      });
    }
    const snoozed = lastFired.label;
    lastFired = null;
    saveSchedules();
    renderTimers();
    return { ok: true, snoozed, minutes: ms / 60000 };
  },

  async cancel_timer_or_alarm({ label }) {
    const before = state.timers.length + state.stopwatches.length + state.alarms.length + state.reminders.length;
    if (label) {
      const l = label.toLowerCase();
      const digits = l.replace(/\D/g, ""); // "7 am" → "7", so "cancel my 7 AM alarm" matches an unlabeled 07:00
      const alarmMatches = (a) => {
        if (a.label.toLowerCase().includes(l)) return true;
        if (!digits) return false;
        const [h, m] = a.time.split(":").map(Number);
        const h12 = ((h + 11) % 12) + 1;
        const mm = String(m).padStart(2, "0");
        return [`${h}${mm}`, `${h12}${mm}`, m === 0 ? `${h}` : null, m === 0 ? `${h12}` : null]
          .filter(Boolean).includes(digits);
      };
      state.timers = state.timers.filter(t => !t.label.toLowerCase().includes(l));
      state.stopwatches = state.stopwatches.filter(s => !s.label.toLowerCase().includes(l));
      state.alarms = state.alarms.filter(a => !alarmMatches(a));
      state.reminders = state.reminders.filter(r => !r.text.toLowerCase().includes(l));
    } else {
      state.timers = [];
      state.stopwatches = [];
      state.alarms = [];
      state.reminders = [];
    }
    stopChime();
    saveSchedules();
    renderTimers();
    const cancelled = before - (state.timers.length + state.stopwatches.length + state.alarms.length + state.reminders.length);
    return cancelled ? { ok: true, cancelled } : { error: "No matching timer, stopwatch, alarm, or reminder found." };
  },

  async get_weather({ location }) {
    let lat, lon, name;
    if (location) {
      const place = await geocodeCity(location);
      if (!place) return { error: `Could not find a place called "${location}".` };
      ({ lat, lon } = place);
      name = place.label;
    } else if (state.prefs.homeLat != null && state.prefs.homeLon != null) {
      lat = state.prefs.homeLat;
      lon = state.prefs.homeLon;
      name = state.prefs.homeLabel || "home";
    } else {
      try {
        const pos = await new Promise((res, rej) =>
          navigator.geolocation.getCurrentPosition(res, rej, { timeout: 8000 })
        );
        lat = pos.coords.latitude;
        lon = pos.coords.longitude;
        name = "your location";
      } catch {
        return { error: "Location permission denied — ask the user which city they want the weather for." };
      }
    }
    const units = state.prefs.units === "celsius" ? "celsius" : "fahrenheit";
    const wx = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m` +
      `&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
      `&temperature_unit=${units}&wind_speed_unit=mph&timezone=auto&forecast_days=1`
    ).then(r => r.json());
    const cur = wx.current;
    const daily = wx.daily;
    const summary = {
      location: name,
      conditions: describeWeatherCode(cur.weather_code),
      units,
      temperature: Math.round(cur.temperature_2m),
      feels_like: Math.round(cur.apparent_temperature),
      humidity_pct: cur.relative_humidity_2m,
      wind_mph: Math.round(cur.wind_speed_10m),
      today_high: Math.round(daily.temperature_2m_max[0]),
      today_low: Math.round(daily.temperature_2m_min[0]),
      precipitation_chance_pct: daily.precipitation_probability_max[0],
    };
    renderWeather(summary);
    return summary;
  },

  async manage_list({ action, list = "shopping", item }) {
    const key = list.toLowerCase().replace(/\s+list$/, "").trim() || "shopping";
    // Optimistic local mutation — the voice flow must not wait on disk.
    const result = applyListAction(action, key, item);
    renderLists();
    if (!result.error && action !== "read") {
      const sync = await pushLists({ action, key, item });
      if (sync.warning) result.warning = sync.warning;
    }
    return result;
  },

  async control_device({ device, action, value }) {
    const d = (device || "").toLowerCase();
    const targets = [];
    if (d === "all lights" || d === "the lights" || d === "lights") {
      for (const [key, dev] of Object.entries(state.devices)) {
        if (appConfig.homeAssistant ? dev.domain === "light" : deviceName(key, dev).includes("light")) targets.push(key);
      }
    } else {
      // Duplicate friendly names match together and are acted on together —
      // that's the "all lights" semantics users expect.
      for (const [key, dev] of Object.entries(state.devices)) {
        const name = deviceName(key, dev);
        if (name.includes(d) || d.includes(name)) targets.push(key);
      }
    }
    if (!targets.length) return { error: `No device called "${device}". Devices: ${availableDeviceNames().join(", ")}.` };

    if (appConfig.homeAssistant) {
      for (const key of targets) {
        const dev = state.devices[key];
        let call;
        if (action === "on") call = { domain: dev.domain, service: "turn_on", entity_id: dev.entity_id };
        else if (action === "off") call = { domain: dev.domain, service: "turn_off", entity_id: dev.entity_id };
        else if (action === "set" && typeof value === "number") {
          if (dev.domain !== "climate") return { error: "I can only turn lights on and off for now." };
          call = { domain: "climate", service: "set_temperature", entity_id: dev.entity_id, data: { temperature: value } };
        } else {
          return { error: "Unsupported action for that device." };
        }
        const resp = await fetch("/api/ha/call", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(call),
        }).catch(() => null);
        // No silent simulated fallback — lying about real devices is worse
        // than failing.
        if (!resp || !resp.ok) return { error: "I couldn't reach the smart home hub." };
      }
      // HA is authoritative; don't trust optimistic state.
      await refreshHaStates().catch(() => {});
      return { ok: true, devices: targets.map(key => deviceName(key, state.devices[key])), action, value };
    }

    for (const key of targets) {
      const dev = state.devices[key];
      if (action === "on") dev.on = true;
      else if (action === "off") dev.on = false;
      else if (action === "set" && typeof value === "number") { dev.value = value; dev.on = true; }
    }
    localStorage.setItem("nova.devices", JSON.stringify(state.devices));
    renderDevices();
    return { ok: true, devices: targets.map(key => deviceName(key, state.devices[key])), action, value };
  },

  async play_ambient_sound({ sound }) {
    const name = (sound || "").toLowerCase();
    if (radioNames().includes(name)) {
      stopAmbient(); // radio and synthesized sounds are mutually exclusive
      startRadio(name);
      return { ok: true, playing: name, kind: "radio stream" };
    }
    stopRadio();
    startAmbient(name);
    return { ok: true, playing: name };
  },

  async stop_ambient_sound() {
    stopAmbient();
    stopRadio();
    return { ok: true };
  },

  async get_news({ topic }) {
    try {
      const resp = await fetch("/api/news" + (topic ? `?topic=${encodeURIComponent(topic)}` : ""));
      const body = await resp.json();
      if (!resp.ok) return { error: body.error || "Couldn't fetch the news right now." };
      return { headlines: body.headlines };
    } catch {
      return { error: "Couldn't fetch the news right now." };
    }
  },

  async get_calendar({ days }) {
    const n = Math.min(7, Math.max(1, Math.round(days || 1)));
    try {
      const resp = await fetch(`/api/calendar?days=${n}`);
      const body = await resp.json();
      if (!resp.ok) return { error: body.error || "Couldn't read the calendar right now." };
      // Speak times, not ISO strings — keep the model away from raw dates.
      // Google's event ids are opaque 26-character strings; a small integer
      // ref survives a voice model's working memory intact, and the mapping
      // is re-seeded on every read so a stale ref can't point at the wrong
      // event later.
      calendarRefs = new Map();
      const events = body.events.map((e, i) => {
        const start = new Date(e.start_iso);
        const day = start.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
        const ref = i + 1;
        if (e.id) calendarRefs.set(ref, e.id);
        return {
          ...(e.id ? { event_ref: ref } : {}),
          summary: e.summary,
          when: e.all_day ? `${day} (all day)` : `${day} at ${start.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`,
          ...(e.source === "ics" ? { read_only: true } : {}),
        };
      });
      renderCalendar(body.events);
      return { events, ...(body.note ? { note: body.note } : {}) };
    } catch {
      return { error: "Couldn't read the calendar right now." };
    }
  },

  async create_calendar_event({ summary, start, end, duration_minutes, all_day, location }) {
    if (!summary) return { error: "An event needs a title." };
    const shape = all_day ? /^\d{4}-\d{2}-\d{2}$/ : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;
    if (!shape.test(start || "")) {
      return { error: all_day
        ? "start must be a date like 2026-08-05."
        : "start must be a local datetime like 2026-08-05T15:00." };
    }
    try {
      const resp = await fetch("/api/calendar/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          summary, start, end, duration_minutes, all_day, location,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
      });
      const body = await resp.json();
      if (!resp.ok) return { error: body.error || "Couldn't add that to the calendar." };
      refreshCalendarCard();
      return { ok: true, summary: body.event.summary, when: spokenEventTime(body.event) };
    } catch {
      return { error: "Couldn't reach the calendar right now." };
    }
  },

  async update_calendar_event({ event_ref, ...patch }) {
    const id = calendarRefs.get(Math.round(event_ref));
    if (!id) return { error: "I don't have that event — read the calendar first." };
    try {
      const resp = await fetch(`/api/calendar/events/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...patch, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
      });
      const body = await resp.json();
      if (!resp.ok) return { error: body.error || "Couldn't change that event." };
      refreshCalendarCard();
      return { ok: true, summary: body.event.summary, when: spokenEventTime(body.event) };
    } catch {
      return { error: "Couldn't reach the calendar right now." };
    }
  },

  async cancel_calendar_event({ event_ref }) {
    const id = calendarRefs.get(Math.round(event_ref));
    if (!id) return { error: "I don't have that event — read the calendar first." };
    try {
      const resp = await fetch(`/api/calendar/events/${encodeURIComponent(id)}`, { method: "DELETE" });
      const body = await resp.json();
      if (!resp.ok) return { error: body.error || "Couldn't cancel that event." };
      calendarRefs.delete(Math.round(event_ref)); // one cancellation per ref
      refreshCalendarCard();
      return { ok: true, cancelled: body.summary || "that event" };
    } catch {
      return { error: "Couldn't reach the calendar right now." };
    }
  },

  async daily_summary() {
    const now = new Date();
    const spokenTime = (hhmm) => {
      const [h, m] = hhmm.split(":").map(Number);
      return new Date(2000, 0, 1, h, m).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    };
    const timers = state.timers
      .filter(t => !t.done)
      .slice(0, 5)
      .map(t => ({ label: t.label, remaining_minutes: Math.max(1, Math.round((t.endsAt - Date.now()) / 60000)) }));
    const stopwatches = state.stopwatches
      .slice(0, 5)
      .map(s => ({ label: s.label, elapsed: formatElapsedTime(Date.now() - s.startedAt) }));
    const alarms = state.alarms
      .filter(a => (a.days ? a.days.includes(now.getDay()) : !a.done))
      .slice(0, 5)
      .map(a => ({ label: a.label, time: spokenTime(a.time), repeats: a.days ? formatDays(a.days) : "one-time" }));
    const reminders = state.reminders
      .filter(r => !r.done && new Date(r.at).toDateString() === now.toDateString())
      .slice(0, 5)
      .map(r => ({ text: r.text, due: formatDueTime(r.at) }));
    return { timers, stopwatches, alarms, reminders };
  },

  async run_routine({ name }) {
    const wanted = String(name || "").toLowerCase().trim();
    const key = Object.keys(state.routines).find(k => k.toLowerCase() === wanted);
    if (!key) {
      return { error: `No routine called "${name}". Available: ${Object.keys(state.routines).join(", ") || "none"}.` };
    }
    // Steps run sequentially via the handlers directly (not new function-call
    // rounds): one function_call_output carries the composite result, so the
    // whole morning update costs a single model round-trip.
    const results = [];
    for (const step of state.routines[key]) {
      const tool = typeof step === "string" ? step : step?.tool;
      let args = (typeof step === "object" && step?.args) || {};
      if (tool === "manage_list") args = { ...args, action: "read" };
      if (!ROUTINE_ALLOWED_TOOLS.includes(tool)) {
        results.push({ step: String(tool), error: "This skill isn't allowed in routines." });
        continue;
      }
      // Steps run through the handlers directly, so runTool never sees them —
      // record each one here or the rollover filter would miss a news step.
      pendingTools.push(tool);
      try {
        results.push({ step: tool, result: await toolHandlers[tool](args) });
      } catch (err) {
        results.push({ step: tool, error: String(err.message || err) });
      }
    }
    // A habit Nova has noticed rides out on the end of an update the user
    // already asked for — she never opens a conversation to ask. The card
    // stays as the record either way, so ignoring the question loses nothing.
    const suggestion = await claimSuggestionToAsk();
    return { routine: key, results, ...(suggestion ? { suggestion } : {}) };
  },

  async manage_routine({ action, name, step_tool }) {
    const routines = state.routines;
    const key = name
      ? Object.keys(routines).find(k => k.toLowerCase() === name.toLowerCase().trim())
      : null;
    switch (action) {
      case "get":
        return {
          routines: Object.fromEntries(
            Object.entries(routines).map(([n, steps]) => [n, routineStepNames(steps)])
          ),
        };
      case "create": {
        if (!name) return { error: "Routine name required." };
        if (key) return { error: `Routine "${key}" already exists.` };
        routines[name.toLowerCase().trim()] = [];
        saveRoutines();
        return { ok: true, created: name.toLowerCase().trim() };
      }
      case "delete": {
        if (!key) return { error: `No routine called "${name}".` };
        delete routines[key];
        saveRoutines();
        return { ok: true, deleted: key };
      }
      case "add_step": {
        if (!key) return { error: `No routine called "${name}".` };
        if (!ROUTINE_ALLOWED_TOOLS.includes(step_tool)) {
          return { error: `"${step_tool}" can't run in a routine. Allowed: ${ROUTINE_ALLOWED_TOOLS.join(", ")}.` };
        }
        routines[key].push(step_tool === "manage_list" ? { tool: "manage_list", args: { action: "read" } } : step_tool);
        saveRoutines();
        return { ok: true, routine: key, steps: routineStepNames(routines[key]) };
      }
      case "remove_step": {
        if (!key) return { error: `No routine called "${name}".` };
        const idx = routines[key].findIndex(s => (typeof s === "string" ? s : s?.tool) === step_tool);
        if (idx === -1) return { error: `"${step_tool}" is not in the ${key} routine.` };
        routines[key].splice(idx, 1);
        saveRoutines();
        return { ok: true, routine: key, steps: routineStepNames(routines[key]) };
      }
      default:
        return { error: "Unknown action." };
    }
  },

  async manage_preferences({ action, name, home_city, units, voice }) {
    const speakable = () => ({
      name: state.prefs.name,
      home_city: state.prefs.homeLabel || state.prefs.homeCity,
      units: state.prefs.units,
      voice: state.prefs.voice || "default",
    });
    if (action === "get") return { prefs: speakable() };
    if (action === "clear") {
      state.prefs = { ...DEFAULT_PREFS };
      savePrefs();
      return { ok: true, cleared: true };
    }
    // action === "set": apply only the provided fields.
    let changed = false;
    let note;
    if (typeof name === "string" && name.trim()) {
      state.prefs.name = name.trim();
      changed = true;
    }
    if (units === "fahrenheit" || units === "celsius") {
      state.prefs.units = units;
      changed = true;
    }
    if (typeof voice === "string" && voice) {
      state.prefs.voice = voice;
      changed = true;
      // Voice is fixed once the model has spoken in a Realtime session.
      note = "The new voice takes effect next session.";
    }
    if (typeof home_city === "string" && home_city.trim()) {
      const place = await geocodeCity(home_city.trim());
      if (!place) return { error: `I couldn't find a city called "${home_city}" — nothing was saved.` };
      state.prefs.homeCity = home_city.trim();
      state.prefs.homeLat = place.lat;
      state.prefs.homeLon = place.lon;
      state.prefs.homeLabel = place.label;
      changed = true;
    }
    savePrefs();
    if (!changed) return { prefs: speakable(), note: "nothing changed" };
    return { ok: true, prefs: speakable(), ...(note ? { note } : {}) };
  },

  // Facts live server-side (Plan 9), unlike preferences: shared across every
  // device in the house, and never posted from the browser into the prompt.
  async remember({ action, text, replaces, id }) {
    const call = async (init) => {
      let resp;
      try {
        resp = await fetch("/api/memory/facts", init);
      } catch {
        return { error: "I can't reach my memory right now — nothing was saved." };
      }
      const body = await resp.json().catch(() => ({}));
      if (!resp.ok) return { error: body.error || `Memory is unavailable (HTTP ${resp.status}).` };
      return body;
    };
    if (action === "list") return call({});
    if (action === "add" || action === "forget") {
      return call({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, text, replaces, id }),
      });
    }
    // Answering the question Nova asked at the end of a routine. Accepting
    // goes through the suggestion, not through "add", so the resulting fact
    // keeps its "derived" provenance and the rule that lets it expire later.
    if (action === "accept" || action === "dismiss") {
      const result = await resolveSuggestion(id, action);
      if (result.ok) pollSuggestions();
      return result;
    }
    return { error: "Unknown action." };
  },

  async recall_memory({ query, kind, since, until }) {
    let body;
    try {
      const resp = await fetch("/api/memory/recall", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, kind, since, until }),
      });
      body = await resp.json();
      if (!resp.ok) return { error: body.error || "I couldn't search my memory just now." };
    } catch {
      return { error: "I couldn't reach my memory just now." };
    }
    // found:false rides straight through. It has to stay unambiguous all the
    // way to the model: an empty list reads as success, and the answer that
    // produces is a confident invention about the household's own past.
    if (!body.found) return { found: false };
    return {
      found: true,
      // Spoken dates, not ISO strings — same treatment as get_calendar.
      events: body.events.map(e => ({ when: spokenPastTime(e.at), what: e.summary || e.name })),
    };
  },

  async set_volume({ level, direction }) {
    if (direction === "up") state.volume = Math.min(10, state.volume + 2);
    else if (direction === "down") state.volume = Math.max(0, state.volume - 2);
    else if (typeof level === "number") state.volume = Math.max(0, Math.min(10, level));
    assistantAudio.volume = state.volume / 10;
    applyDucking(); // also scales radio + ambient to the new volume
    return { ok: true, volume: state.volume };
  },
};

// =====================================================================
// Home Assistant devices (Plan 7)
// =====================================================================

async function refreshHaStates() {
  const resp = await fetch("/api/ha/states");
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const entities = await resp.json();
  const devices = {};
  for (const e of entities) {
    devices[e.entity_id] = {
      name: String(e.name).toLowerCase(),
      entity_id: e.entity_id,
      domain: e.domain,
      on: e.state !== "off" && e.state !== "unavailable" && e.state !== "unknown",
      ...(typeof e.temp === "number" ? { value: e.temp } : {}),
    };
  }
  state.devices = devices; // real states replace the simulated set entirely
  renderDevices();
}

function initHaDevices() {
  refreshHaStates().catch(() => {});
  setInterval(() => {
    if (document.visibilityState === "visible") refreshHaStates().catch(() => {});
  }, 30000);
}

// =====================================================================
// Shared lists: server sync (Plan 3)
// =====================================================================

// Mutates state.lists and returns the speakable tool result. Kept separate
// from the tool handler so a 409 retry can re-apply the same single action
// on top of fresh server state (re-applying an add is always safe;
// remove/clear are idempotent).
function applyListAction(action, key, item) {
  state.lists[key] = state.lists[key] || [];
  const items = state.lists[key];
  switch (action) {
    case "add":
      if (!item) return { error: "No item given." };
      items.push(item);
      return { ok: true, list: key, added: item, count: items.length };
    case "remove": {
      const idx = items.findIndex(i => i.toLowerCase().includes((item || "").toLowerCase()));
      if (idx === -1) return { error: `"${item}" is not on the ${key} list.` };
      const [removed] = items.splice(idx, 1);
      return { ok: true, list: key, removed, count: items.length };
    }
    case "clear":
      state.lists[key] = [];
      return { ok: true, list: key, cleared: true };
    case "read":
    default:
      return { list: key, items: [...items] };
  }
}

function setListsOffline(offline) {
  state.listsOffline = offline;
  const badge = document.getElementById("listsOfflineBadge");
  if (badge) badge.hidden = !offline;
}

// PUT local lists to the server. On 409, adopt server state, re-apply the
// user's single action, and retry once.
async function pushLists(retryAction = null, retried = false) {
  try {
    const resp = await fetch("/api/lists", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rev: state.listsRev, lists: state.lists }),
    });
    if (resp.status === 409) {
      const cur = await resp.json();
      state.lists = cur.lists;
      state.listsRev = cur.rev;
      if (retryAction && !retried) {
        applyListAction(retryAction.action, retryAction.key, retryAction.item);
        renderLists();
        return pushLists(retryAction, true);
      }
      renderLists();
      return { warning: "saved locally, sync conflict" };
    }
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    state.listsRev = (await resp.json()).rev;
    setListsOffline(false);
    return {};
  } catch {
    // Voice flow shouldn't fail because the Wi-Fi blipped: keep local state,
    // mirror to localStorage as a crash backup, resync on the next good poll.
    localStorage.setItem("nova.lists", JSON.stringify(state.lists));
    setListsOffline(true);
    return {};
  }
}

async function initLists() {
  let local = null;
  try { local = JSON.parse(localStorage.getItem("nova.lists") || "null"); } catch {}
  try {
    const resp = await fetch("/api/lists");
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const cur = await resp.json();
    state.lists = cur.lists;
    state.listsRev = cur.rev;
    const serverEmpty = !Object.values(cur.lists).some(items => items.length);
    const localHasItems = local && Object.values(local).some(items => items?.length);
    if (serverEmpty && localHasItems) {
      state.lists = local; // one-time migration of pre-sync localStorage lists
      await pushLists();
      if (!state.listsOffline) localStorage.removeItem("nova.lists");
    }
  } catch {
    if (local) state.lists = local; // server unreachable: work offline
    setListsOffline(true);
  }
  renderLists();
}

// Poll for changes made by other devices — only while someone is looking.
let listsPollInFlight = false;
async function pollLists() {
  if (document.visibilityState !== "visible" || listsPollInFlight) return;
  listsPollInFlight = true;
  try {
    const resp = await fetch(`/api/lists?since=${state.listsRev}`);
    if (resp.status === 304) {
      // In sync; if we have offline edits, this is the moment to resync them.
      if (state.listsOffline) await pushLists();
    } else if (resp.ok) {
      const cur = await resp.json();
      if (state.listsOffline) {
        // Offline edits win the resync: adopt the server rev, keep local
        // items, push. (True conflicts here are rare enough not to merge.)
        state.listsRev = cur.rev;
        await pushLists();
      } else {
        state.lists = cur.lists;
        state.listsRev = cur.rev;
        setListsOffline(false);
        renderLists();
      }
    }
  } catch {
    setListsOffline(true);
  } finally {
    listsPollInFlight = false;
  }
}
setInterval(pollLists, 4000);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") pollLists();
});

// =====================================================================
// Realtime session (WebRTC)
// =====================================================================

// User-initiated session start (ring click, wake word, typed message):
// clears the intentional-stop flag and the reconnect budget. The mode sticks
// for the session, including across auto-reconnects.
function userStartSession(mode = "voice") {
  sessionMode = mode;
  userStopped = false;
  reconnectAttempts = 0;
  wasReconnect = false;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  startSession();
}

// Mint an ephemeral token, retrying once after 1 s so a server that is
// briefly restarting doesn't fail the whole session start.
async function fetchSessionToken() {
  const attempt = () => fetch("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prefs: {
        name: state.prefs.name,
        homeLabel: state.prefs.homeLabel,
        units: state.prefs.units,
        voice: state.prefs.voice,
      },
    }),
  });
  let resp = null;
  try { resp = await attempt(); } catch {}
  if (!resp || resp.status >= 500) {
    await new Promise(r => setTimeout(r, 1000));
    resp = await attempt();
  }
  return resp;
}

async function startSession() {
  setRingState("connecting", wasReconnect ? "Reconnecting…" : "Connecting…");
  try {
    // 1. Ephemeral client secret from our server (real API key never reaches
    //    the browser). Saved prefs ride along so the server can splice an
    //    "About this user" block into the instructions and pick the voice.
    const tokenResp = await fetchSessionToken();
    const tokenBody = await tokenResp.json();
    if (!tokenResp.ok) throw new Error(tokenBody.error || "Could not create session");
    const EPHEMERAL_KEY = tokenBody.value;
    // The tail of the last conversation, if it's recent enough to still be
    // worth replaying — the server decides that, and renders the text.
    pendingRollover = tokenBody.rollover || null;

    // 2. Peer connection: mic up, assistant audio down. A text session skips
    //    getUserMedia entirely — no permission prompt, no recording indicator
    //    — and offers a recvonly audio line so the SDP still carries the audio
    //    m-line the Realtime API expects.
    pc = new RTCPeerConnection();
    pc.ontrack = (e) => { assistantAudio.srcObject = e.streams[0]; };
    if (sessionMode === "text") {
      pc.addTransceiver("audio", { direction: "recvonly" });
    } else {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      pc.addTrack(micStream.getTracks()[0], micStream);
    }

    // 3. Data channel for JSON events
    dc = pc.createDataChannel("oai-events");
    dc.addEventListener("open", onDataChannelOpen);
    dc.addEventListener("message", (e) => handleServerEvent(JSON.parse(e.data)));

    const thisPc = pc;
    pc.onconnectionstatechange = () => {
      if (pc !== thisPc || !connected || userStopped) return;
      const st = thisPc.connectionState;
      if (st === "disconnected") {
        // "disconnected" can self-heal in WebRTC — give it 3 s before acting.
        setTimeout(() => {
          if (pc === thisPc && connected && !userStopped &&
              thisPc.connectionState === "disconnected") {
            handleConnectionLoss();
          }
        }, 3000);
      } else if (st === "failed" || st === "closed") {
        handleConnectionLoss();
      }
    };

    // 4. SDP exchange with the Realtime API
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const sdpResp = await fetch("https://api.openai.com/v1/realtime/calls", {
      method: "POST",
      body: offer.sdp,
      headers: {
        Authorization: `Bearer ${EPHEMERAL_KEY}`,
        "Content-Type": "application/sdp",
      },
    });
    if (!sdpResp.ok) throw new Error(`Realtime SDP exchange failed (HTTP ${sdpResp.status})`);
    await pc.setRemoteDescription({ type: "answer", sdp: await sdpResp.text() });

    connected = true;
    assistantAudio.volume = state.volume / 10;
    muteBtn.hidden = sessionMode !== "voice"; // nothing to mute without a mic
    stopWakeListening(); // wake word not needed while session is live
  } catch (err) {
    console.error(err);
    teardown();
    // A failed reconnect attempt (expired token, SDP failure, server still
    // down) counts against the same budget and retries the same way.
    if (wasReconnect && !userStopped && reconnectAttempts < 2) {
      scheduleReconnect();
      return;
    }
    const msg = /permission|notallowed/i.test(err.name + err.message)
      ? "Microphone blocked — allow mic access and tap the ring again"
      : `Error: ${err.message}`;
    stopSession(msg);
  }
}

function handleConnectionLoss() {
  teardown();
  scheduleReconnect();
}

function scheduleReconnect() {
  if (reconnectAttempts >= 2) {
    stopSession("Connection lost — tap the ring to reconnect");
    return;
  }
  const delay = 1000 * 2 ** reconnectAttempts;
  reconnectAttempts++;
  setRingState("connecting", "Reconnecting…");
  const fire = () => {
    reconnectTimer = null;
    if (connected || userStopped) return;
    if (document.visibilityState === "hidden") {
      // Don't burn tokens on a session in a tab nobody's looking at —
      // defer the attempt until the tab is visible again.
      const onVisible = () => {
        if (document.visibilityState !== "visible") return;
        document.removeEventListener("visibilitychange", onVisible);
        if (!connected && !userStopped) { wasReconnect = true; startSession(); }
      };
      document.addEventListener("visibilitychange", onVisible);
      return;
    }
    wasReconnect = true;
    startSession();
  };
  reconnectTimer = setTimeout(fire, delay);
}

async function onDataChannelOpen() {
  // Reset the reconnect budget only now — resetting in startSession's happy
  // path would let a mint-token failure loop spin forever.
  reconnectAttempts = 0;
  setReadyState();
  await configReady; // tool list depends on which integrations are live
  // Register tools + tuned audio settings now that the channel is live.
  sendEvent({
    type: "session.update",
    session: {
      type: "realtime",
      tools: buildTools(),
      tool_choice: "auto",
      // A text session has no mic feeding it, so there is no turn to detect
      // and nothing to transcribe — and every reply is written, not spoken.
      ...(sessionMode === "text"
        ? {
            output_modalities: ["text"],
            audio: { input: { turn_detection: null } },
          }
        : {
            audio: {
              input: {
                transcription: { model: "gpt-realtime-whisper" },
                // Semantic VAD: end-of-turn detection based on what is said,
                // not just silence — best practice for assistant UX.
                turn_detection: { type: "semantic_vad" },
              },
            },
          }),
    },
  });
  // Reminders that came due while the page was closed: announce once.
  const missed = state.reminders.filter(r => r.missed && !r.done);
  if (missed.length) {
    sendEvent({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{
          type: "input_text",
          text: `[system event] While Nova was off, ${missed.length === 1 ? "this reminder was" : "these reminders were"} missed: ` +
            missed.map(r => `"${r.text}"`).join(", ") + ". After greeting the user, mention this once, briefly.",
        }],
      },
    });
    for (const r of missed) r.done = true; // stays rendered as "missed", but only announced once
    saveSchedules();
  }
  // Where the last conversation left off (Plan 9), as one item rather than one
  // per turn: the token budget stays in one place, and a single framed block
  // keeps the model from adopting a replayed turn's modality.
  const rollover = pendingRollover;
  pendingRollover = null;
  if (rollover?.text) {
    sendEvent({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: ROLLOVER_ROLE,
        content: [{
          type: "input_text",
          text: ROLLOVER_ROLE === "user" ? `[system event] ${rollover.text}` : rollover.text,
        }],
      },
    });
  }
  const typed = pendingTypedMessage;
  pendingTypedMessage = null;
  const reconnected = wasReconnect;
  wasReconnect = false;
  if (typed) {
    // The user asked a question by keyboard; answering it IS the greeting.
    sendTypedMessage(typed);
  } else if (rollover?.text) {
    // Nova already has the context — no apology and no recap, just be ready.
    createResponse();
  } else if (reconnected) {
    createResponse({ instructions: "Say only: 'Sorry, I lost you for a second.'" });
  } else {
    // Have Nova greet the user, Alexa-style.
    createResponse({
      instructions: "Greet the user in one short sentence as Nova and invite them to ask for something.",
    });
  }
}

function sendEvent(evt) {
  if (dc && dc.readyState === "open") dc.send(JSON.stringify(evt));
}

// ---------- Text input (Plan 5) ----------
// Typed messages ride the same data channel as spoken ones — same tools, same
// conversation — but they answer in kind: type a question, read the answer.
const textForm = document.getElementById("textForm");
const textInput = document.getElementById("textInput");

// Every response.create funnels through here so reply modality is decided in
// one place. Text sessions and typed turns come back written; spoken turns
// come back as speech + transcript.
function createResponse({ textOnly = sessionMode === "text", instructions } = {}) {
  lastTurnTextOnly = textOnly;
  const response = {};
  if (textOnly) response.output_modalities = ["text"];
  if (instructions) response.instructions = instructions;
  sendEvent(Object.keys(response).length
    ? { type: "response.create", response }
    : { type: "response.create" });
}

function sendTypedMessage(text) {
  if (assistantSpeaking) sendEvent({ type: "response.cancel" }); // typed barge-in
  addMessage("user", text);
  recordTurn("user", text); // no transcription event fires for typed input
  sendEvent({
    type: "conversation.item.create",
    item: { type: "message", role: "user", content: [{ type: "input_text", text }] },
  });
  // Typed in, typed out — a keyboard question gets a written answer even in
  // the middle of a spoken session, where Nova would otherwise talk over you.
  createResponse({ textOnly: true });
  setRingState("thinking", "Thinking…");
}

textForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = textInput.value.trim();
  if (!text) return;
  textInput.value = "";
  if (connected && dc?.readyState === "open") {
    sendTypedMessage(text);
  } else {
    // No live session: the box wakes Nova in text mode. Typing must never open
    // the microphone — the ring is the only control that does that.
    // Last-write-wins while connecting is fine — it's one input box.
    pendingTypedMessage = text;
    if (!pc) userStartSession("text");
  }
});

// Release the session's resources without touching the idle UI or wake word
// — reused by the reconnect path, which immediately starts a new session.
function teardown() {
  connected = false;
  assistantSpeaking = false;
  // Get the tail on the server now — the next session may be seconds away.
  if (rolloverFlushTimer) { clearTimeout(rolloverFlushTimer); rolloverFlushTimer = null; }
  if (archiveFlushTimer) { clearTimeout(archiveFlushTimer); archiveFlushTimer = null; }
  pendingTools = [];
  flushRollover();
  flushArchive();
  try { dc?.close(); } catch {}
  try { pc?.close(); } catch {}
  micStream?.getTracks().forEach(t => t.stop());
  pc = dc = micStream = null;
  micMuted = false;
  muteBtn.hidden = true;
  muteBtn.textContent = "Mute mic";
}

function stopSession(message = "Tap the ring to wake Nova") {
  teardown();
  setRingState("idle", message);
  if (wakeEnabled) startWakeListening();
}

// ---------- Memory archive (Plan 10, Tier C) ----------
// An append-only record of what happened, written here and read only when the
// model explicitly asks for it. It never enters the prompt, so it costs
// nothing on a normal turn no matter how large it grows.
//
// The server sanitizes everything again on arrival; the trimming here is about
// what is worth recording at all, not about trusting the browser.

const ARCHIVE_FLUSH_MS = 5000;
const ARCHIVE_MAX_QUEUE = 60;

let archiveQueue = [];
let archiveFlushTimer = null;

function archive(event) {
  if (!event) return;
  archiveQueue.push(event);
  // A wedged server must not turn into unbounded memory growth in the tab.
  if (archiveQueue.length > ARCHIVE_MAX_QUEUE) archiveQueue = archiveQueue.slice(-ARCHIVE_MAX_QUEUE);
  if (!archiveFlushTimer) {
    archiveFlushTimer = setTimeout(() => { archiveFlushTimer = null; flushArchive(); }, ARCHIVE_FLUSH_MS);
  }
}

// Fire-and-forget: a failed flush is dropped, never retried into the voice
// path, never surfaced. History is worth less than a working conversation.
function flushArchive() {
  if (!archiveQueue.length) return;
  const events = archiveQueue;
  archiveQueue = [];
  fetch("/api/memory/archive", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ events }),
  }).catch(() => {});
}

// One row per tool call. Routine steps deliberately don't come through here —
// they bypass runTool, so a routine lands as a single event with its name
// rather than six near-identical rows that would skew every count in Tier D.
function archiveTool(name, args, output, source = "speech") {
  if (ARCHIVE_SKIP_TOOLS.includes(name)) return;
  archive({
    kind: "tool",
    name,
    args: redactArgs(name, args),
    ok: !output?.error,
    summary: summarizeToolResult(output),
    // External wins over the caller's source: a news step inside a routine is
    // still fetched text.
    source: EXTERNAL_TOOLS.includes(name) ? "external" : source,
  });
}

// ---------- Session rollover (Plan 9) ----------
// The tail of the conversation, mirrored to the server so a brand-new session
// — after a drop, a reload, or the Realtime API's hourly cap — can pick up
// where this one left off. Text only: assistant audio can't be loaded back
// into a session at all, and text costs roughly a tenth of the same audio.
//
// The buffer deliberately outlives a single session. A reconnect is a new
// Realtime session but the same conversation, and the browser is the only
// thing that sees both halves.

const ROLLOVER_TURNS = 8;
const ROLLOVER_FLUSH_MS = 5000;

let turnBuffer = [];        // { role, text, tools, mode }
let pendingTools = [];      // tools that ran while the current reply was being built
let rolloverFlushTimer = null;
let pendingRollover = null; // handed back by POST /api/session, injected on open

// The one place that decides whether the API accepts a system-role
// conversation item. OpenAI's own compaction cookbook uses one here, but this
// codebase has only ever sent user-role items (see the missed-reminders block
// in onDataChannelOpen). If the server rejects the item or the model ignores
// it, switch this to "user" — the text is written to work either way.
const ROLLOVER_ROLE = "system";

function recordTurn(role, text) {
  const clean = String(text || "").trim();
  if (!clean) return;
  // Never let a rollover open with Nova talking: the first thing she says is a
  // greeting or a "sorry, I lost you", neither of which is worth carrying.
  if (role === "assistant" && !turnBuffer.length) { pendingTools = []; return; }
  const turn = {
    role,
    text: clean,
    tools: role === "assistant" ? pendingTools : [],
    mode: sessionMode,
  };
  turnBuffer.push(turn);
  // Tier C keeps every turn; Tier B (turnBuffer, below) keeps only the tail.
  // A reply built on fetched text is marked external and stays out of recall
  // results — archived for completeness, not for reciting back.
  archive({
    kind: "turn",
    name: role,
    summary: clean,
    source: turn.tools.some(t => EXTERNAL_TOOLS.includes(t)) ? "external" : "speech",
  });
  if (role === "assistant") pendingTools = [];
  if (turnBuffer.length > ROLLOVER_TURNS) turnBuffer = turnBuffer.slice(-ROLLOVER_TURNS);
  if (!rolloverFlushTimer) {
    rolloverFlushTimer = setTimeout(() => { rolloverFlushTimer = null; flushRollover(); }, ROLLOVER_FLUSH_MS);
  }
}

// Fire-and-forget: a failed flush is dropped, never retried into the voice
// path. Debouncing is what makes this survive an *unclean* drop — by the time
// the connection dies the server already has everything but the last few
// seconds.
function flushRollover() {
  if (!turnBuffer.length) return; // never overwrite a good rollover with nothing
  fetch("/api/memory/rollover", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ turns: turnBuffer }),
  }).catch(() => {});
}

// A reload never reaches teardown(), and an in-flight fetch() dies with the
// page — sendBeacon is the one request the browser promises to finish.
addEventListener("pagehide", () => {
  if (!navigator.sendBeacon) return;
  const beacon = (url, payload) =>
    navigator.sendBeacon(url, new Blob([JSON.stringify(payload)], { type: "application/json" }));
  if (turnBuffer.length) beacon("/api/memory/rollover", { turns: turnBuffer });
  if (archiveQueue.length) {
    beacon("/api/memory/archive", { events: archiveQueue });
    archiveQueue = [];
  }
});


// ---------- Server event handling ----------

let currentAssistantMsg = null;
let currentUserMsg = null;

function handleServerEvent(evt) {
  switch (evt.type) {
    // The user's speech transcript (input side)
    case "conversation.item.input_audio_transcription.completed": {
      const said = evt.transcript?.trim() || "";
      addMessage("user", said || "…");
      recordTurn("user", said);
      break;
    }

    case "input_audio_buffer.speech_started":
      if (!assistantSpeaking) setRingState("listening", "Listening…");
      break;

    case "input_audio_buffer.speech_stopped":
      setRingState("thinking", "Thinking…");
      break;

    // Assistant speech transcript, streamed
    case "response.output_audio_transcript.delta":
      appendAssistantDelta(evt.delta);
      break;

    case "response.output_audio_transcript.done":
      recordTurn("assistant", evt.transcript);
      currentAssistantMsg = null;
      break;

    // Written reply, streamed — text sessions and typed turns take this path
    // instead of the transcript one, since nothing is spoken.
    case "response.output_text.delta":
      appendAssistantDelta(evt.delta);
      break;

    case "response.output_text.done":
      recordTurn("assistant", evt.text);
      currentAssistantMsg = null;
      break;

    case "output_audio_buffer.started":
      assistantSpeaking = true;
      applyDucking();
      setRingState("speaking", "Speaking…");
      break;

    case "output_audio_buffer.stopped":
    case "output_audio_buffer.cleared":
      assistantSpeaking = false;
      applyDucking();
      if (connected) setReadyState();
      break;

    case "response.function_call_arguments.done":
      runTool(evt.name, evt.call_id, evt.arguments);
      break;

    case "response.done":
      currentAssistantMsg = null;
      if (!assistantSpeaking && connected) setReadyState();
      break;

    case "error":
      console.error("Realtime error:", evt);
      addMessage("event", `⚠ ${evt.error?.message || "Realtime API error"}`);
      break;
  }
}

async function runTool(name, callId, argsJson) {
  let args = {};
  try { args = JSON.parse(argsJson || "{}"); } catch {}
  addMessage("event", `⚙ ${name}(${summarizeArgs(args)})`);
  pendingTools.push(name); // provenance for the rollover filter (Plan 9)
  let output;
  try {
    const handler = toolHandlers[name];
    output = handler ? await handler(args) : { error: `Unknown tool ${name}` };
  } catch (err) {
    output = { error: String(err.message || err) };
  }
  archiveTool(name, args, output); // Plan 10: one choke point covers every call
  sendEvent({
    type: "conversation.item.create",
    item: { type: "function_call_output", call_id: callId, output: JSON.stringify(output) },
  });
  // Answer in the same form as the turn that called the tool, so a typed
  // question doesn't get its answer read aloud just because a tool ran.
  createResponse({ textOnly: lastTurnTextOnly });
}

function summarizeArgs(args) {
  const s = Object.entries(args).map(([k, v]) => `${k}: ${v}`).join(", ");
  return s.length > 60 ? s.slice(0, 57) + "…" : s;
}

// =====================================================================
// Timers & alarms engine
// =====================================================================

setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const t of state.timers) {
    if (!t.done && now >= t.endsAt) {
      t.done = true;
      changed = true;
      onTimerFired(t);
    }
  }
  const clock = new Date();
  const hhmm = `${String(clock.getHours()).padStart(2, "0")}:${String(clock.getMinutes()).padStart(2, "0")}`;
  const todayStr = `${clock.getFullYear()}-${String(clock.getMonth() + 1).padStart(2, "0")}-${String(clock.getDate()).padStart(2, "0")}`;
  // Alarms compare wall-clock HH:MM strings, so they follow local DST shifts automatically.
  for (const a of state.alarms) {
    if (a.time !== hhmm) continue;
    if (a.days) {
      if (a.days.includes(clock.getDay()) && a.lastFiredOn !== todayStr) {
        a.lastFiredOn = todayStr;
        changed = true;
        onTimerFired(a);
      }
    } else if (!a.done) {
      a.done = true;
      changed = true;
      onTimerFired(a);
    }
  }
  for (const r of state.reminders) {
    if (!r.done && !r.missed && now >= r.at) {
      r.done = true;
      changed = true;
      onTimerFired(r);
    }
  }
  if (changed) saveSchedules();
  if (changed || state.timers.some(t => !t.done) || state.stopwatches.length) renderTimers();
}, 500);

let lastFired = null; // {kind, id, label, at} — most recent fired entry, consumed by the snooze tool

function onTimerFired(t) {
  lastFired = { kind: t.kind, id: t.id, label: t.kind === "reminder" ? t.text : t.label, at: Date.now() };
  playChime();
  // Tell Nova so it can announce it by voice, like Alexa does.
  if (connected) {
    const text = t.kind === "reminder"
      ? `[system event] The reminder "${t.text}" is due. Say: "This is your reminder to ${t.text}."`
      : `[system event] The ${t.kind} "${t.label}" just went off. Announce it briefly.`;
    sendEvent({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
      },
    });
    createResponse();
  }
  // Auto-clear finished entries after a while — recurring alarms and snoozed
  // reminders (done flipped back to false) stay.
  setTimeout(() => {
    state.timers = state.timers.filter(x => x.id !== t.id);
    state.alarms = state.alarms.filter(x => x.id !== t.id || x.days);
    state.reminders = state.reminders.filter(x => x.id !== t.id || !x.done);
    stopChime();
    saveSchedules();
    renderTimers();
  }, 30000);
}

// ---------- Persistence: schedules survive a page refresh ----------

function saveSchedules() {
  localStorage.setItem("nova.schedules", JSON.stringify({
    timers: state.timers, stopwatches: state.stopwatches,
    alarms: state.alarms, reminders: state.reminders,
  }));
}

function loadSchedules() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem("nova.schedules") || "null"); } catch {}
  if (!saved) return;
  const now = Date.now();
  for (const t of saved.timers || []) {
    // ≤60 s overdue: keep — the engine loop fires it immediately (chime only
    // while disconnected). Older: drop silently.
    if (!t.done && now - t.endsAt <= 60000) state.timers.push(t);
  }
  for (const s of saved.stopwatches || []) {
    if (s?.kind === "stopwatch" && typeof s.label === "string" &&
        Number.isFinite(s.startedAt) && s.startedAt <= now) {
      state.stopwatches.push(s);
    }
  }
  for (const a of saved.alarms || []) {
    if (a.days || !a.done) state.alarms.push(a); // recurring alarms always survive
  }
  for (const r of saved.reminders || []) {
    if (r.done) continue;
    if (now - r.at > 60000) r.missed = true; // announced once at next session start
    state.reminders.push(r);
  }
  saveSchedules();
}

// =====================================================================
// Web Audio: chime + ambient sounds (synthesized, no assets needed)
// =====================================================================

let audioCtx = null;
let chimeInterval = null;
let ambientNode = null;
let ambientGain = null;
let ambientLfo = null;

function ctx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
}

function playChime() {
  stopChime();
  const ding = () => {
    const c = ctx();
    [880, 1108.7].forEach((freq, i) => {
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.frequency.value = freq;
      osc.type = "sine";
      gain.gain.setValueAtTime(0.001, c.currentTime + i * 0.18);
      gain.gain.exponentialRampToValueAtTime(0.25 * (state.volume / 10 || 0.05), c.currentTime + i * 0.18 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, c.currentTime + i * 0.18 + 0.6);
      osc.connect(gain).connect(c.destination);
      osc.start(c.currentTime + i * 0.18);
      osc.stop(c.currentTime + i * 0.18 + 0.7);
    });
  };
  ding();
  chimeInterval = setInterval(ding, 2500);
  setTimeout(stopChime, 30000);
}

function stopChime() {
  if (chimeInterval) { clearInterval(chimeInterval); chimeInterval = null; }
}

function startAmbient(kind) {
  stopAmbient();
  const c = ctx();
  const bufferSize = 2 * c.sampleRate;
  const buffer = c.createBuffer(1, bufferSize, c.sampleRate);
  const data = buffer.getChannelData(0);
  // Pink-ish noise via Paul Kellet's filter
  let b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < bufferSize; i++) {
    const white = Math.random() * 2 - 1;
    b0 = 0.997 * b0 + 0.029591 * white;
    b1 = 0.985 * b1 + 0.0329 * white;
    b2 = 0.95 * b2 + 0.048 * white;
    data[i] = kind === "white noise" ? white * 0.3 : (b0 + b1 + b2 + white * 0.05) * 0.9;
  }
  ambientNode = c.createBufferSource();
  ambientNode.buffer = buffer;
  ambientNode.loop = true;
  ambientGain = c.createGain();
  ambientGain.gain.value = 0.12 * (state.volume / 10) * (assistantSpeaking ? 0.25 : 1);

  let chainIn = ambientNode;
  if (kind === "rain") {
    const hp = c.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 400;
    chainIn.connect(hp);
    chainIn = hp;
  }
  if (kind === "ocean") {
    // Slow LFO on gain → waves
    ambientLfo = c.createOscillator();
    const lfoGain = c.createGain();
    ambientLfo.frequency.value = 0.12;
    lfoGain.gain.value = 0.06;
    ambientLfo.connect(lfoGain).connect(ambientGain.gain);
    ambientLfo.start();
    const lp = c.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 600;
    chainIn.connect(lp);
    chainIn = lp;
  }
  chainIn.connect(ambientGain).connect(c.destination);
  ambientNode.start();
}

function stopAmbient() {
  try { ambientNode?.stop(); } catch {}
  try { ambientLfo?.stop(); } catch {}
  ambientNode = ambientGain = ambientLfo = null;
}

// ---------- Internet radio (Plan 7) ----------
// Stream URLs stay server-side: the client just points the audio element at
// /api/radio/<name> and the server 302s to the real stream.

const radioAudio = document.getElementById("radioAudio");
let radioPlaying = null; // stream name while playing

function startRadio(name) {
  radioPlaying = name;
  radioAudio.src = "/api/radio/" + encodeURIComponent(name);
  applyDucking();
  radioAudio.play().catch(() => {});
}

function stopRadio() {
  if (!radioPlaying && !radioAudio.src) return;
  radioPlaying = null;
  try { radioAudio.pause(); } catch {}
  radioAudio.removeAttribute("src");
  radioAudio.load();
}

// While Nova is speaking, background audio drops to 25% — talking over
// music should feel like it does on a real smart speaker.
function applyDucking() {
  const duck = assistantSpeaking ? 0.25 : 1;
  radioAudio.volume = (state.volume / 10) * duck;
  if (ambientGain) ambientGain.gain.value = 0.12 * (state.volume / 10) * duck;
}

// play() resolves before a stream 404/geo-block surfaces, so failures arrive
// here — inject a system event the same way timers do.
radioAudio.addEventListener("error", () => {
  if (!radioPlaying) return;
  const failed = radioPlaying;
  stopRadio();
  if (connected) {
    sendEvent({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{
          type: "input_text",
          text: `[system event] The "${failed}" radio stream failed to play. Tell the user briefly and offer a synthesized sound instead.`,
        }],
      },
    });
    createResponse();
  }
});

// =====================================================================
// Wake word ("Nova") — on-device browser speech recognition, used only to
// trigger the OpenAI session hands-free while idle.
// =====================================================================

let wakeEnabled = false;
let wakeRec = null;
const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;

function startWakeListening() {
  if (!SpeechRec || connected || wakeRec) return;
  wakeRec = new SpeechRec();
  wakeRec.continuous = true;
  wakeRec.interimResults = true;
  wakeRec.onresult = (e) => {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const text = e.results[i][0].transcript.toLowerCase();
      if (/\bnova\b|\bnoah\b/.test(text)) {
        stopWakeListening();
        userStartSession("voice");
        return;
      }
    }
  };
  wakeRec.onend = () => { wakeRec = null; if (wakeEnabled && !connected) startWakeListening(); };
  wakeRec.onerror = () => {};
  try { wakeRec.start(); wakeHint.hidden = false; } catch { wakeRec = null; }
}

function stopWakeListening() {
  wakeHint.hidden = true;
  if (wakeRec) {
    const r = wakeRec;
    wakeRec = null;
    try { r.onend = null; r.stop(); } catch {}
  }
}

wakeBtn.addEventListener("click", () => {
  if (!SpeechRec) {
    wakeBtn.textContent = "Wake word unsupported here";
    wakeBtn.disabled = true;
    return;
  }
  wakeEnabled = !wakeEnabled;
  wakeBtn.classList.toggle("active", wakeEnabled);
  wakeBtn.textContent = wakeEnabled ? "Wake word on" : "Enable wake word";
  if (wakeEnabled && !connected) startWakeListening();
  else stopWakeListening();
});

// =====================================================================
// UI
// =====================================================================

ring.addEventListener("click", () => {
  if (insecureContext) {
    setRingState(connected ? "texting" : "idle", "Needs HTTPS for the microphone — see README");
    return;
  }
  ctx(); // unlock audio on user gesture
  if (connected && sessionMode === "text") {
    // The ring is the microphone, so from a text session it opens voice rather
    // than hanging up. Realtime has no session resume, so this is a fresh
    // session — the on-screen transcript stays, the model's memory of it
    // doesn't, same as an auto-reconnect.
    teardown();
    userStartSession("voice");
    return;
  }
  if (connected || reconnectTimer) {
    // Intentional stop (also cancels a pending auto-reconnect).
    userStopped = true;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    stopSession();
  } else {
    userStartSession("voice");
  }
});

muteBtn.addEventListener("click", () => {
  micMuted = !micMuted;
  micStream?.getAudioTracks().forEach(t => (t.enabled = !micMuted));
  muteBtn.textContent = micMuted ? "Unmute mic" : "Mute mic";
  setReadyState();
});

// The "waiting on you" state depends on the mode: a voice session really is
// listening, a text session is not — and a muted one isn't either.
function setReadyState() {
  if (sessionMode === "text") setRingState("texting", "Text mode — tap the ring to talk out loud");
  else if (micMuted) setRingState("muted", "Mic muted");
  else setRingState("listening", "Listening — just talk");
}

function setRingState(cls, text) {
  ring.className = `ring ${cls}`;
  statusEl.textContent = text;
}

function appendAssistantDelta(delta) {
  if (!delta) return;
  if (!currentAssistantMsg) currentAssistantMsg = addMessage("assistant", "");
  currentAssistantMsg.querySelector(".message-text")
    ?.appendChild(document.createTextNode(delta));
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function addMessage(role, text) {
  const hint = transcriptEl.querySelector(".hint");
  if (hint) hint.remove();
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  if (role === "user" || role === "assistant") {
    const who = document.createElement("span");
    who.className = "who";
    who.textContent = role === "user" ? "You" : "Nova";
    div.appendChild(who);

    const messageText = document.createElement("span");
    messageText.className = "message-text";
    messageText.textContent = text;
    div.appendChild(messageText);
  } else {
    div.appendChild(document.createTextNode(text));
  }
  transcriptEl.appendChild(div);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
  return div;
}

function renderTimers() {
  const card = document.getElementById("timersCard");
  const ul = document.getElementById("timersList");
  const entries = [...state.stopwatches, ...state.timers, ...state.alarms, ...state.reminders];
  card.hidden = entries.length === 0;
  ul.innerHTML = "";
  for (const t of entries) {
    const li = document.createElement("li");
    const label = document.createElement("span");
    const icon = t.kind === "alarm" ? "⏰" : t.kind === "reminder" ? "🔔" : "⏱";
    label.textContent = `${icon} ${t.kind === "reminder" ? t.text : t.label}`;
    const time = document.createElement("span");
    time.className = "timer-time" + (t.done || t.missed ? " timer-done" : "");
    if (t.kind === "stopwatch") {
      time.textContent = formatElapsedTime(Date.now() - t.startedAt);
    } else if (t.kind === "alarm") {
      const days = t.days ? ` · ${formatDays(t.days)}` : "";
      time.textContent = t.done && !t.days ? "ringing!" : t.time + days;
    } else if (t.kind === "reminder") {
      time.textContent = t.missed ? "missed" : t.done ? "now!" : formatDueTime(t.at);
    } else if (t.done) {
      time.textContent = "done!";
    } else {
      const remain = Math.max(0, Math.round((t.endsAt - Date.now()) / 1000));
      time.textContent = `${Math.floor(remain / 60)}:${String(remain % 60).padStart(2, "0")}`;
    }
    li.append(label, time);
    ul.appendChild(li);
  }
}

function formatDueTime(at) {
  const d = new Date(at);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString()
    ? time
    : `${d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })} ${time}`;
}

function renderWeather(w) {
  const card = document.getElementById("weatherCard");
  const body = document.getElementById("weatherBody");
  card.hidden = false;
  body.innerHTML = "";
  const unitLabel = w.units === "celsius" ? "°C" : "°F";
  const temp = document.createElement("div");
  temp.className = "temp";
  temp.textContent = `${w.temperature}${unitLabel}`;
  const desc = document.createElement("div");
  desc.textContent = `${w.conditions} — ${w.location}`;
  const detail = document.createElement("div");
  detail.textContent = `H ${w.today_high}° / L ${w.today_low}° · feels like ${w.feels_like}° · ${w.precipitation_chance_pct}% rain · wind ${w.wind_mph} mph`;
  body.append(temp, desc, detail);
}

function renderLists() {
  const card = document.getElementById("listsCard");
  const body = document.getElementById("listsBody");
  const nonEmpty = Object.entries(state.lists).filter(([, items]) => items.length);
  card.hidden = nonEmpty.length === 0;
  body.innerHTML = "";
  for (const [name, items] of nonEmpty) {
    const h = document.createElement("div");
    h.className = "list-name";
    h.textContent = name;
    const ul = document.createElement("ul");
    ul.className = "list-items";
    for (const item of items) {
      const li = document.createElement("li");
      li.textContent = item;
      ul.appendChild(li);
    }
    body.append(h, ul);
  }
}

// ---------- Calendar card ----------
// The card exists to make writes visible: an event Nova created by voice
// should be something you can see it got right, without opening Google.

function spokenEventTime(event) {
  const start = new Date(event.start_iso);
  const day = start.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
  return event.all_day
    ? `${day} (all day)`
    : `${day} at ${start.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

function initCalendarCard() {
  const card = document.getElementById("calendarCard");
  if (!card) return;
  const connect = document.getElementById("calendarConnect");
  // Offer the connect link only when the server has credentials to use it.
  connect.hidden = !(appConfig.googleConfigured && !appConfig.calendarWritable);
  card.hidden = !appConfig.calendar && connect.hidden;
  if (appConfig.calendar) refreshCalendarCard();
}

async function refreshCalendarCard() {
  if (!appConfig.calendar) return;
  try {
    const resp = await fetch("/api/calendar?days=7");
    if (!resp.ok) return;
    const body = await resp.json();
    renderCalendar(body.events || []);
  } catch {
    // A card that fails to refresh is not worth interrupting anyone over.
  }
}

function renderCalendar(events = []) {
  const card = document.getElementById("calendarCard");
  const body = document.getElementById("calendarBody");
  if (!card || !body) return;
  card.hidden = false;
  body.innerHTML = "";
  if (!events.length) {
    const empty = document.createElement("p");
    empty.className = "devices-empty";
    empty.textContent = "Nothing on the calendar for the next week.";
    body.appendChild(empty);
    return;
  }
  const ul = document.createElement("ul");
  ul.className = "list-items";
  for (const e of events.slice(0, 8)) {
    const li = document.createElement("li");
    const title = document.createElement("span");
    title.textContent = e.summary;
    const when = document.createElement("span");
    when.className = "timer-time";
    when.textContent = spokenEventTime(e);
    li.append(title, when);
    ul.appendChild(li);
  }
  body.appendChild(ul);
}

// ---------- Habit suggestions (Plan 10, Tier D) ----------
// Nova counts patterns off-session and proposes; a person here decides. This
// card is the whole confirmation step — until someone taps Remember, a
// suggestion is a row in a file and nothing else, and in particular it is not
// in the system prompt.

const SUGGESTION_POLL_MS = 5 * 60 * 1000; // the scan behind these runs hourly at best

function renderSuggestions(suggestions = []) {
  const card = document.getElementById("suggestionsCard");
  const body = document.getElementById("suggestionsBody");
  card.hidden = suggestions.length === 0;
  body.innerHTML = "";
  for (const suggestion of suggestions) {
    const row = document.createElement("div");
    row.className = "suggestion";

    const text = document.createElement("p");
    text.className = "suggestion-text";
    text.textContent = suggestion.text;

    const actions = document.createElement("div");
    actions.className = "suggestion-actions";
    // The support ("8 of the last 21 days") is shown rather than hidden: a
    // suggestion the user can't check is one they can only guess about.
    if (suggestion.support) {
      const support = document.createElement("span");
      support.className = "suggestion-support";
      support.textContent = `seen ${suggestion.support}`;
      actions.appendChild(support);
    }
    for (const [action, label] of [["accept", "Remember"], ["dismiss", "No thanks"]]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = action === "accept" ? "pill" : "text-button";
      button.textContent = label;
      button.addEventListener("click", () => onSuggestionButton(suggestion.id, action, button));
      actions.appendChild(button);
    }
    row.append(text, actions);
    body.appendChild(row);
  }
}

// Shared by the card and by the spoken answer Nova gets after a routine —
// both end at the same endpoint, so a habit accepted by voice and one accepted
// by tap are the same fact with the same provenance.
async function resolveSuggestion(id, action) {
  try {
    const resp = await fetch("/api/memory/suggestions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, id }),
    });
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) return { error: body.error || `Memory is unavailable (HTTP ${resp.status}).` };
    return { ok: true, ...body };
  } catch {
    return { error: "I can't reach my memory right now — nothing was saved." };
  }
}

async function onSuggestionButton(id, action, button) {
  const buttons = button?.closest(".suggestion")?.querySelectorAll("button") || [];
  for (const b of buttons) b.disabled = true;
  const result = await resolveSuggestion(id, action);
  if (result.error) {
    for (const b of buttons) b.disabled = false;
    addMessage("event", "⚠ Couldn't save that just now.");
    return;
  }
  if (action === "accept") {
    // Facts are read at session start, so an accepted habit reaches Nova on
    // the next connection, not this one. Say so rather than implying it's
    // already in effect.
    addMessage("event", "✓ Saved — Nova will know that from the next time you talk.");
  }
  await pollSuggestions();
}

// The one place Nova is allowed to raise a suggestion out loud: at the end of
// a routine the user asked for. Claiming it server-side stamps it as asked, so
// she raises each one exactly once however many routines run.
async function claimSuggestionToAsk() {
  try {
    const resp = await fetch("/api/memory/suggestions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "ask" }),
      // The morning update is not allowed to wait on this. A slow or wedged
      // server costs the aside, not the routine.
      signal: AbortSignal.timeout(1500),
    });
    if (!resp.ok) return null;
    return (await resp.json()).suggestion || null;
  } catch {
    return null; // a routine must never fail over a nicety
  }
}

let suggestionsPollInFlight = false;
async function pollSuggestions() {
  if (suggestionsPollInFlight) return;
  suggestionsPollInFlight = true;
  try {
    const resp = await fetch("/api/memory/suggestions");
    if (resp.ok) renderSuggestions((await resp.json()).suggestions || []);
  } catch {
    // Offline is not an error worth a badge: there is nothing to act on.
  } finally {
    suggestionsPollInFlight = false;
  }
}
// Only the timer is gated on visibility. The load-time fetch is not: a tab
// that starts hidden — an installed PWA resuming, a preloaded page — would
// otherwise show an empty card until the next tick five minutes later.
setInterval(() => {
  if (document.visibilityState === "visible") pollSuggestions();
}, SUGGESTION_POLL_MS);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") pollSuggestions();
});
pollSuggestions();

function renderDevices() {
  const body = document.getElementById("devicesBody");
  const empty = document.getElementById("devicesEmpty");
  body.innerHTML = "";
  const availableByKey = new Map(Object.entries(state.devices));
  for (const key of state.pinnedDeviceKeys) {
    const dev = availableByKey.get(key);
    const name = deviceName(key, dev);
    const chip = document.createElement("div");
    chip.className = "device" + (dev?.on ? " on" : "") + (!dev ? " unavailable" : "");
    chip.setAttribute("aria-label", `${name}, ${dev ? (dev.on ? "on" : "off") : "unavailable"}`);
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.setAttribute("aria-hidden", "true");
    chip.appendChild(dot);
    chip.appendChild(document.createTextNode(name));
    if (typeof dev?.value === "number") {
      const val = document.createElement("span");
      val.className = "val";
      val.textContent = `${dev.value}°`;
      chip.appendChild(val);
    }
    const remove = document.createElement("button");
    remove.className = "device-remove";
    remove.type = "button";
    remove.setAttribute("aria-label", `Remove ${name} from Smart Home`);
    remove.title = `Remove ${name}`;
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      state.pinnedDeviceKeys = state.pinnedDeviceKeys.filter(pinned => pinned !== key);
      savePinnedDevices();
      renderDevices();
    });
    chip.appendChild(remove);
    body.appendChild(chip);
  }
  empty.hidden = state.pinnedDeviceKeys.length > 0;
  syncDevicePicker();
}

function syncDevicePicker() {
  const pinned = new Set(state.pinnedDeviceKeys);
  const unpinned = Object.entries(state.devices)
    .filter(([key]) => !pinned.has(key))
    .sort(([keyA, devA], [keyB, devB]) =>
      deviceName(keyA, devA).localeCompare(deviceName(keyB, devB))
    );
  deviceSelect.innerHTML = "";
  if (!unpinned.length) {
    const option = document.createElement("option");
    option.textContent = "All available entities are already shown";
    option.value = "";
    deviceSelect.appendChild(option);
  } else {
    for (const [key, dev] of unpinned) {
      const option = document.createElement("option");
      option.value = key;
      const name = deviceName(key, dev);
      option.textContent = dev.entity_id ? `${name} · ${dev.entity_id}` : name;
      deviceSelect.appendChild(option);
    }
  }
  deviceSelect.disabled = unpinned.length === 0;
  addDeviceBtn.disabled = unpinned.length === 0;
  devicePickerHint.textContent = unpinned.length
    ? `${unpinned.length} ${unpinned.length === 1 ? "entity" : "entities"} available`
    : "Remove an entity before adding another.";
}

function setDevicePickerOpen(open) {
  devicePicker.hidden = !open;
  manageDevicesBtn.textContent = open ? "Done" : "Add entity";
  manageDevicesBtn.setAttribute("aria-expanded", String(open));
  if (open) {
    syncDevicePicker();
    deviceSelect.focus();
  }
}

manageDevicesBtn.addEventListener("click", () => {
  setDevicePickerOpen(devicePicker.hidden);
});

devicePicker.addEventListener("submit", (event) => {
  event.preventDefault();
  const key = deviceSelect.value;
  if (!key || state.pinnedDeviceKeys.includes(key)) return;
  state.pinnedDeviceKeys.push(key);
  savePinnedDevices();
  renderDevices();
  if (!deviceSelect.disabled) deviceSelect.focus();
});

// =====================================================================
// PWA (Plan 6)
// =====================================================================

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");

// Mic (and wake word) need a secure context. A tablet on http://<lan-ip>
// would otherwise hit a misleading "microphone blocked" error — say the
// real reason and disable the ring instead.
const insecureContext = !window.isSecureContext;

// Initial paint
loadSchedules();
renderDevices();
initLists(); // async: adopts server lists (or offline fallback) and renders
renderTimers();
if (insecureContext) {
  setRingState("idle", "Needs HTTPS for the microphone — see README");
}
