// Tier D — learned habits (Plan 10).
//
// Pure functions over archive rows. No model call anywhere in this tier, and
// that is the point: an LLM asked to spot these patterns would be slower,
// costlier, non-reproducible, and worse at counting.
//
// Everything here only ever *proposes*. Promotion into a Tier A fact — which
// means the system prompt — requires an explicit human accept, because a
// component that writes to the prompt automatically is precisely the
// aggressive-write pattern that measures roughly twice the memory-poisoning
// exposure of a conservative one, and this tier reads from an archive partly
// populated by external content.
//
// Times are read in the server's local timezone. Nova is LAN-local and
// self-hosted, so that is the household's timezone by construction — the same
// assumption the alarm engine already makes about wall-clock HH:MM.

// Every rule requires distinct days or weeks, never raw counts — otherwise one
// long Saturday of fiddling with the lights manufactures a lifelong habit.
//
// These thresholds are guesses. They live in one object so they can be tuned
// from real data without hunting through the logic, and every detector takes
// them as overridable options so decay can measure below threshold (see
// measureHabit).
export const HABIT_RULES = {
  time_of_day: { minDays: 8, ofDays: 21, windowMin: 30 },
  repeated_arg: { minCalls: 6, ofDays: 21, minShare: 0.7 },
  recurring_purchase: { minWeeks: 3, ofWeeks: 6 },
  device_habit: { minDays: 6, ofDays: 21, windowMin: 45 },
};

// Plumbing, not habits. These fire as a side effect of other requests
// ("what time is it" before every reminder) or are about memory itself, and
// counting them would bury the patterns worth noticing.
export const HABIT_IGNORED_TOOLS = [
  "get_current_datetime",
  "daily_summary",
  "snooze",
  "cancel_timer_or_alarm",
  "remember",
  "recall_memory",
  "manage_preferences",
  "manage_routine",
  "set_volume",
  "stop_ambient_sound",
];

// The one argument per tool worth counting. Tools absent from this map have no
// argument a repeat would mean anything about — repeating "8 minutes" across
// timers says nothing, repeating "jazz" across sounds says a lot.
const PRIMARY_ARG = {
  get_weather: "location",
  get_news: "topic",
  manage_list: "list",
  run_routine: "name",
  play_ambient_sound: "sound",
  control_device: "device",
};

const TOOL_PHRASE = {
  get_weather: "ask for the weather",
  get_news: "ask for the news",
  manage_list: "check a list",
  run_routine: "run a routine",
  play_ambient_sound: "put on background sound",
  set_timer: "set a timer",
  set_alarm: "set an alarm",
  set_reminder: "set a reminder",
  get_calendar: "check your calendar",
  start_stopwatch: "start a stopwatch",
};

const ARG_PHRASE = {
  get_weather: (v) => `You usually ask for the weather in ${v}`,
  get_news: (v) => `You usually ask for news about ${v}`,
  manage_list: (v) => `You mostly use the ${v} list`,
  run_routine: (v) => `You usually run the ${v} routine`,
  play_ambient_sound: (v) => `You usually play ${v}`,
  control_device: (v) => `The device you control most is the ${v}`,
};

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

// Local calendar day, so "8 of the last 21 days" counts days the way a person
// living in the house would count them.
function dayKey(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function minutesOfDay(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.getHours() * 60 + d.getMinutes();
}

// Circular, so a "good night" habit straddling midnight clusters as one thing
// instead of splitting into two that each miss the threshold.
function apart(a, b) {
  const d = Math.abs(a - b) % 1440;
  return Math.min(d, 1440 - d);
}

export function spokenTime(minutes) {
  const h24 = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const suffix = h24 < 12 ? "am" : "pm";
  return m ? `${h12}:${String(m).padStart(2, "0")}${suffix}` : `${h12}${suffix}`;
}

function withinDays(rows, now, days) {
  const from = now - days * DAY_MS;
  return rows.filter(r => {
    const at = Date.parse(r?.at);
    return Number.isFinite(at) && at >= from && at <= now;
  });
}

// External content never becomes a habit: a week of news headlines is a
// pattern in the world, not a pattern in this household. Failed calls don't
// count either — asking twice because it broke the first time isn't a habit.
const usable = (row) => row && row.source !== "external" && row.ok !== false;

// The tightest cluster of times in one set of observations: the candidate
// center covering the most distinct days. Candidates are the observed times
// themselves, tried in sorted order, so the result is deterministic.
function bestCluster(observations, windowMin) {
  let best = { days: 0, center: null };
  const centers = [...new Set(observations.map(o => o.minutes))].sort((a, b) => a - b);
  for (const center of centers) {
    const days = new Set(
      observations.filter(o => apart(o.minutes, center) <= windowMin).map(o => o.day)
    ).size;
    if (days > best.days) best = { days, center };
  }
  return best;
}

function groupObservations(rows, keyOf) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    if (key == null) continue;
    const day = dayKey(row.at);
    const minutes = minutesOfDay(row.at);
    if (day == null || minutes == null) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ day, minutes });
  }
  return groups;
}

const splitKey = (key) => [key.slice(0, key.indexOf("|")), key.slice(key.indexOf("|") + 1)];

// ---- Detectors ----
// Each returns [{ rule, key, text, support: { n, of } }], sorted by key.
// Thresholds default from HABIT_RULES and are overridable so measureHabit can
// read raw support for a habit that has fallen below the bar.

export function detectTimeOfDay(rows = [], {
  now = Date.now(),
  minDays = HABIT_RULES.time_of_day.minDays,
  ofDays = HABIT_RULES.time_of_day.ofDays,
  windowMin = HABIT_RULES.time_of_day.windowMin,
} = {}) {
  const eligible = withinDays(rows, now, ofDays)
    .filter(r => r.kind === "tool" && usable(r) && !HABIT_IGNORED_TOOLS.includes(r.name));
  const out = [];
  for (const [tool, observations] of groupObservations(eligible, r => r.name)) {
    const { days, center } = bestCluster(observations, windowMin);
    if (days < minDays) continue;
    const phrase = TOOL_PHRASE[tool] || `use ${tool.replace(/_/g, " ")}`;
    out.push({
      rule: "time_of_day",
      key: tool,
      text: `You usually ${phrase} around ${spokenTime(center)}`,
      support: { n: days, of: ofDays },
    });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

export function detectRepeatedArg(rows = [], {
  now = Date.now(),
  minCalls = HABIT_RULES.repeated_arg.minCalls,
  ofDays = HABIT_RULES.repeated_arg.ofDays,
  minShare = HABIT_RULES.repeated_arg.minShare,
} = {}) {
  const eligible = withinDays(rows, now, ofDays)
    .filter(r => r.kind === "tool" && usable(r) && PRIMARY_ARG[r.name]);
  const byTool = new Map();
  for (const row of eligible) {
    const value = row.args?.[PRIMARY_ARG[row.name]];
    if (typeof value !== "string" || !value.trim()) continue;
    if (!byTool.has(row.name)) byTool.set(row.name, []);
    byTool.get(row.name).push(value.trim());
  }
  const out = [];
  for (const [tool, values] of byTool) {
    // Counted case-insensitively, but every spelling seen is kept: "Portland"
    // and "portland" are one habit, and the one read back out loud should be
    // the one a person actually used.
    const counts = new Map(); // lowercased value → Map(exact spelling → count)
    for (const value of values) {
      const key = value.toLowerCase();
      if (!counts.has(key)) counts.set(key, new Map());
      const spellings = counts.get(key);
      spellings.set(value, (spellings.get(value) || 0) + 1);
    }
    const total = (spellings) => [...spellings.values()].reduce((a, b) => a + b, 0);
    // Ties break on the value, not on Map insertion order, so a rescan of
    // unchanged rows proposes the same thing.
    const commonest = (entries) => [...entries].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
    const [value, spellings] = [...counts.entries()]
      .sort((a, b) => total(b[1]) - total(a[1]) || a[0].localeCompare(b[0]))[0];
    const n = total(spellings);
    if (n < minCalls || n / values.length < minShare) continue;
    const phrase = ARG_PHRASE[tool] || ((v) => `You usually use ${tool.replace(/_/g, " ")} with ${v}`);
    out.push({
      rule: "repeated_arg",
      // The key stays lowercased so decay re-measures across spellings.
      key: `${tool}|${value}`,
      text: phrase(commonest(spellings)),
      support: { n, of: values.length },
    });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

export function detectRecurringPurchase(rows = [], {
  now = Date.now(),
  minWeeks = HABIT_RULES.recurring_purchase.minWeeks,
  ofWeeks = HABIT_RULES.recurring_purchase.ofWeeks,
} = {}) {
  const byItem = new Map();
  for (const row of rows) {
    if (row?.kind !== "list" || !usable(row)) continue;
    if (row.args?.action !== "add" || typeof row.args?.item !== "string") continue;
    const at = Date.parse(row.at);
    if (!Number.isFinite(at)) continue;
    const week = Math.floor((now - at) / WEEK_MS);
    if (week < 0 || week >= ofWeeks) continue;
    const list = String(row.args.list || row.name || "shopping").toLowerCase();
    const item = row.args.item.trim().toLowerCase();
    if (!item) continue;
    const key = `${list}|${item}`;
    if (!byItem.has(key)) byItem.set(key, new Set());
    byItem.get(key).add(week);
  }
  const out = [];
  for (const [key, weeks] of byItem) {
    if (weeks.size < minWeeks) continue;
    const [list, item] = splitKey(key);
    out.push({
      rule: "recurring_purchase",
      key,
      text: list === "shopping"
        ? `You buy ${item} most weeks`
        : `You add ${item} to the ${list} list most weeks`,
      support: { n: weeks.size, of: ofWeeks },
    });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

export function detectDeviceHabit(rows = [], {
  now = Date.now(),
  minDays = HABIT_RULES.device_habit.minDays,
  ofDays = HABIT_RULES.device_habit.ofDays,
  windowMin = HABIT_RULES.device_habit.windowMin,
} = {}) {
  const eligible = withinDays(rows, now, ofDays)
    .filter(r => r.kind === "device" && usable(r) && r.name && r.args?.action);
  const out = [];
  for (const [key, observations] of groupObservations(eligible, r => `${r.name}|${r.args.action}`)) {
    const { days, center } = bestCluster(observations, windowMin);
    if (days < minDays) continue;
    const [device, action] = splitKey(key);
    out.push({
      rule: "device_habit",
      key,
      text: action === "on" || action === "off"
        ? `You usually turn the ${device} ${action} around ${spokenTime(center)}`
        : `You usually set the ${device} around ${spokenTime(center)}`,
      support: { n: days, of: ofDays },
    });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

const DETECTORS = {
  time_of_day: detectTimeOfDay,
  repeated_arg: detectRepeatedArg,
  recurring_purchase: detectRecurringPurchase,
  device_habit: detectDeviceHabit,
};

// Sorted so a rescan of unchanged rows produces an identical list.
export function detectHabits(rows = [], { now = Date.now() } = {}) {
  return Object.values(DETECTORS)
    .flatMap(detect => detect(rows, { now }))
    .sort((a, b) => a.rule.localeCompare(b.rule) || a.key.localeCompare(b.key));
}

// Re-measure one known habit against the current window — the input to decay.
// Detectors only emit above threshold, so a habit that has fallen to 3/21
// wouldn't come back from one at all; the minimums are dropped to zero here so
// the raw support is readable either way.
export function measureHabit({ rule, key } = {}, rows = [], { now = Date.now() } = {}) {
  const detect = DETECTORS[rule];
  if (!detect || !key) return null;
  const found = detect(rows, { now, minDays: 0, minCalls: 0, minWeeks: 0, minShare: 0 })
    .find(s => s.key === key);
  if (found) return found.support;
  const rules = HABIT_RULES[rule];
  return { n: 0, of: rules.ofDays ?? rules.ofWeeks ?? 0 };
}

// A habit that has fallen below half its original threshold has ended. Below
// *half* rather than below threshold, so one hovering at the line doesn't flip
// a fact in and out of the prompt on every scan.
export function isDecayed(rule, support) {
  const rules = HABIT_RULES[rule];
  if (!rules || !support) return false;
  const threshold = rules.minDays ?? rules.minCalls ?? rules.minWeeks;
  return support.n < threshold / 2;
}
