/* Nova — Alexa-style voice assistant on the OpenAI Realtime API (WebRTC).
 *
 * Flow (2026 best practice):
 *   1. POST /api/session → server mints an ephemeral client secret ("ek_...")
 *   2. Browser opens an RTCPeerConnection: mic track up, assistant audio down
 *   3. SDP offer is POSTed to https://api.openai.com/v1/realtime/calls
 *   4. JSON events flow over the "oai-events" data channel
 *   5. Tools are registered via session.update; function calls are executed
 *      locally and results returned as function_call_output items.
 */

"use strict";

// ---------- DOM ----------
const ring = document.getElementById("ring");
const statusEl = document.getElementById("status");
const muteBtn = document.getElementById("muteBtn");
const wakeBtn = document.getElementById("wakeBtn");
const wakeHint = document.getElementById("wakeHint");
const transcriptEl = document.getElementById("transcript");
const assistantAudio = document.getElementById("assistantAudio");

// ---------- Session state ----------
let pc = null;          // RTCPeerConnection
let dc = null;          // data channel
let micStream = null;
let micMuted = false;
let connected = false;
let assistantSpeaking = false;

// ---------- Assistant state (the "skills") ----------
const DEFAULT_PREFS = {
  name: null,          // "Sam"
  homeCity: null,      // "Portland" (as the user said it)
  homeLat: null, homeLon: null, homeLabel: null, // resolved+cached geocode
  units: "fahrenheit", // "fahrenheit" | "celsius"
  voice: null,         // null = server default
};

const state = {
  timers: [],    // {id, kind:"timer",    label, endsAt, done}
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
  volume: 8, // 0-10
  prefs: { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem("nova.prefs") || "null") },
};

function savePrefs() {
  localStorage.setItem("nova.prefs", JSON.stringify(state.prefs));
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

function routineStepNames(steps) {
  return steps.map(s => (typeof s === "string" ? s : s.tool));
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

// =====================================================================
// Tool definitions (sent to the model) + implementations (run locally)
// =====================================================================

const TOOLS = [
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
    description: "Cancel a timer, alarm, or reminder by its label or text, or all of them.",
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
    description: "Control a simulated smart-home device. Devices: living room light, bedroom light, kitchen light, fan, thermostat.",
    parameters: {
      type: "object",
      properties: {
        device: { type: "string", description: "Device name, or 'all lights'" },
        action: { type: "string", enum: ["on", "off", "set"] },
        value: { type: "number", description: "For thermostat 'set': temperature in °F" },
      },
      required: ["device", "action"],
    },
  },
  {
    type: "function",
    name: "play_ambient_sound",
    description: "Play a synthesized ambient sound. Options: rain, white noise, ocean. Use when the user asks for music, sleep sounds, or background noise.",
    parameters: {
      type: "object",
      properties: {
        sound: { type: "string", enum: ["rain", "white noise", "ocean"] },
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
    description: "Get today's schedule: running timers, today's alarms, and reminders due today. " +
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
    const before = state.timers.length + state.alarms.length + state.reminders.length;
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
      state.alarms = state.alarms.filter(a => !alarmMatches(a));
      state.reminders = state.reminders.filter(r => !r.text.toLowerCase().includes(l));
    } else {
      state.timers = [];
      state.alarms = [];
      state.reminders = [];
    }
    stopChime();
    saveSchedules();
    renderTimers();
    const cancelled = before - (state.timers.length + state.alarms.length + state.reminders.length);
    return cancelled ? { ok: true, cancelled } : { error: "No matching timer, alarm, or reminder found." };
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
      for (const name of Object.keys(state.devices)) if (name.includes("light")) targets.push(name);
    } else {
      const match = Object.keys(state.devices).find(name => name.includes(d) || d.includes(name));
      if (match) targets.push(match);
    }
    if (!targets.length) return { error: `No device called "${device}". Devices: ${Object.keys(state.devices).join(", ")}.` };
    for (const name of targets) {
      const dev = state.devices[name];
      if (action === "on") dev.on = true;
      else if (action === "off") dev.on = false;
      else if (action === "set" && typeof value === "number") { dev.value = value; dev.on = true; }
    }
    localStorage.setItem("nova.devices", JSON.stringify(state.devices));
    renderDevices();
    return { ok: true, devices: targets, action, value };
  },

  async play_ambient_sound({ sound }) {
    startAmbient(sound);
    return { ok: true, playing: sound };
  },

  async stop_ambient_sound() {
    stopAmbient();
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
    const alarms = state.alarms
      .filter(a => (a.days ? a.days.includes(now.getDay()) : !a.done))
      .slice(0, 5)
      .map(a => ({ label: a.label, time: spokenTime(a.time), repeats: a.days ? formatDays(a.days) : "one-time" }));
    const reminders = state.reminders
      .filter(r => !r.done && new Date(r.at).toDateString() === now.toDateString())
      .slice(0, 5)
      .map(r => ({ text: r.text, due: formatDueTime(r.at) }));
    return { timers, alarms, reminders };
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
      try {
        results.push({ step: tool, result: await toolHandlers[tool](args) });
      } catch (err) {
        results.push({ step: tool, error: String(err.message || err) });
      }
    }
    return { routine: key, results };
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

  async set_volume({ level, direction }) {
    if (direction === "up") state.volume = Math.min(10, state.volume + 2);
    else if (direction === "down") state.volume = Math.max(0, state.volume - 2);
    else if (typeof level === "number") state.volume = Math.max(0, Math.min(10, level));
    assistantAudio.volume = state.volume / 10;
    if (ambientGain) ambientGain.gain.value = 0.12 * (state.volume / 10);
    return { ok: true, volume: state.volume };
  },
};

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

async function startSession() {
  setRingState("connecting", "Connecting…");
  try {
    // 1. Ephemeral client secret from our server (real API key never reaches
    //    the browser). Saved prefs ride along so the server can splice an
    //    "About this user" block into the instructions and pick the voice.
    const tokenResp = await fetch("/api/session", {
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
    const tokenBody = await tokenResp.json();
    if (!tokenResp.ok) throw new Error(tokenBody.error || "Could not create session");
    const EPHEMERAL_KEY = tokenBody.value;

    // 2. Peer connection: mic up, assistant audio down
    pc = new RTCPeerConnection();
    pc.ontrack = (e) => { assistantAudio.srcObject = e.streams[0]; };
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    pc.addTrack(micStream.getTracks()[0], micStream);

    // 3. Data channel for JSON events
    dc = pc.createDataChannel("oai-events");
    dc.addEventListener("open", onDataChannelOpen);
    dc.addEventListener("message", (e) => handleServerEvent(JSON.parse(e.data)));

    pc.onconnectionstatechange = () => {
      if (["failed", "disconnected", "closed"].includes(pc.connectionState) && connected) {
        stopSession("Connection lost — tap the ring to reconnect");
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
    muteBtn.hidden = false;
    stopWakeListening(); // wake word not needed while session is live
  } catch (err) {
    console.error(err);
    const msg = /permission|notallowed/i.test(err.name + err.message)
      ? "Microphone blocked — allow mic access and tap the ring again"
      : `Error: ${err.message}`;
    stopSession(msg);
  }
}

function onDataChannelOpen() {
  setRingState("listening", "Listening — just talk");
  // Register tools + tuned audio settings now that the channel is live.
  sendEvent({
    type: "session.update",
    session: {
      type: "realtime",
      tools: TOOLS,
      tool_choice: "auto",
      audio: {
        input: {
          transcription: { model: "gpt-realtime-whisper" },
          // Semantic VAD: end-of-turn detection based on what is said, not
          // just silence — the current best practice for assistant UX.
          turn_detection: { type: "semantic_vad" },
        },
      },
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
  // Have Nova greet the user, Alexa-style.
  sendEvent({
    type: "response.create",
    response: {
      instructions: "Greet the user in one short sentence as Nova and invite them to ask for something.",
    },
  });
}

function sendEvent(evt) {
  if (dc && dc.readyState === "open") dc.send(JSON.stringify(evt));
}

function stopSession(message = "Tap the ring to wake Nova") {
  connected = false;
  try { dc?.close(); } catch {}
  try { pc?.close(); } catch {}
  micStream?.getTracks().forEach(t => t.stop());
  pc = dc = micStream = null;
  micMuted = false;
  muteBtn.hidden = true;
  muteBtn.textContent = "Mute mic";
  setRingState("idle", message);
  if (wakeEnabled) startWakeListening();
}

// ---------- Server event handling ----------

let currentAssistantMsg = null;
let currentUserMsg = null;

function handleServerEvent(evt) {
  switch (evt.type) {
    // The user's speech transcript (input side)
    case "conversation.item.input_audio_transcription.completed":
      addMessage("user", evt.transcript?.trim() || "…");
      break;

    case "input_audio_buffer.speech_started":
      if (!assistantSpeaking) setRingState("listening", "Listening…");
      break;

    case "input_audio_buffer.speech_stopped":
      setRingState("thinking", "Thinking…");
      break;

    // Assistant speech transcript, streamed
    case "response.output_audio_transcript.delta":
      if (!currentAssistantMsg) currentAssistantMsg = addMessage("assistant", "");
      currentAssistantMsg.textContent += evt.delta;
      transcriptEl.scrollTop = transcriptEl.scrollHeight;
      break;

    case "response.output_audio_transcript.done":
      currentAssistantMsg = null;
      break;

    case "output_audio_buffer.started":
      assistantSpeaking = true;
      setRingState("speaking", "Speaking…");
      break;

    case "output_audio_buffer.stopped":
    case "output_audio_buffer.cleared":
      assistantSpeaking = false;
      if (connected) setRingState("listening", "Listening — just talk");
      break;

    case "response.function_call_arguments.done":
      runTool(evt.name, evt.call_id, evt.arguments);
      break;

    case "response.done":
      if (!assistantSpeaking && connected) setRingState("listening", "Listening — just talk");
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
  let output;
  try {
    const handler = toolHandlers[name];
    output = handler ? await handler(args) : { error: `Unknown tool ${name}` };
  } catch (err) {
    output = { error: String(err.message || err) };
  }
  sendEvent({
    type: "conversation.item.create",
    item: { type: "function_call_output", call_id: callId, output: JSON.stringify(output) },
  });
  sendEvent({ type: "response.create" });
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
  if (changed || state.timers.some(t => !t.done)) renderTimers();
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
    sendEvent({ type: "response.create" });
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
    timers: state.timers, alarms: state.alarms, reminders: state.reminders,
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
  ambientGain.gain.value = 0.12 * (state.volume / 10);

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
        startSession();
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
  ctx(); // unlock audio on user gesture
  if (connected) stopSession();
  else startSession();
});

muteBtn.addEventListener("click", () => {
  micMuted = !micMuted;
  micStream?.getAudioTracks().forEach(t => (t.enabled = !micMuted));
  muteBtn.textContent = micMuted ? "Unmute mic" : "Mute mic";
  if (micMuted) setRingState("muted", "Mic muted");
  else setRingState("listening", "Listening — just talk");
});

function setRingState(cls, text) {
  ring.className = `ring ${cls}`;
  statusEl.textContent = text;
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
  }
  div.appendChild(document.createTextNode(text));
  transcriptEl.appendChild(div);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
  return div;
}

function renderTimers() {
  const card = document.getElementById("timersCard");
  const ul = document.getElementById("timersList");
  const entries = [...state.timers, ...state.alarms, ...state.reminders];
  card.hidden = entries.length === 0;
  ul.innerHTML = "";
  for (const t of entries) {
    const li = document.createElement("li");
    const label = document.createElement("span");
    const icon = t.kind === "alarm" ? "⏰" : t.kind === "reminder" ? "🔔" : "⏱";
    label.textContent = `${icon} ${t.kind === "reminder" ? t.text : t.label}`;
    const time = document.createElement("span");
    time.className = "timer-time" + (t.done || t.missed ? " timer-done" : "");
    if (t.kind === "alarm") {
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

function formatDays(days) {
  const sorted = [...days].sort((a, b) => a - b);
  if (sorted.length === 7) return "daily";
  if (sorted.join() === "1,2,3,4,5") return "M–F";
  if (sorted.join() === "0,6") return "weekends";
  return sorted.map(d => "SMTWTFS"[d]).join(" ");
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

function renderDevices() {
  const body = document.getElementById("devicesBody");
  body.innerHTML = "";
  for (const [name, dev] of Object.entries(state.devices)) {
    const chip = document.createElement("div");
    chip.className = "device" + (dev.on ? " on" : "");
    const dot = document.createElement("span");
    dot.className = "dot";
    chip.appendChild(dot);
    chip.appendChild(document.createTextNode(name));
    if (typeof dev.value === "number") {
      const val = document.createElement("span");
      val.className = "val";
      val.textContent = `${dev.value}°`;
      chip.appendChild(val);
    }
    body.appendChild(chip);
  }
}

function describeWeatherCode(code) {
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

// Initial paint
loadSchedules();
renderDevices();
initLists(); // async: adopts server lists (or offline fallback) and renders
renderTimers();
