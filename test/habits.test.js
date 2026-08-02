import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectHabits,
  detectTimeOfDay,
  detectRepeatedArg,
  detectRecurringPurchase,
  detectDeviceHabit,
  measureHabit,
  isDecayed,
  spokenTime,
  HABIT_RULES,
} from "../lib/habits.js";

const NOW = Date.parse("2026-08-02T12:00:00.000Z");

// Habits are counted in local time (the server shares a house with the
// household), so timestamps are built from a local Date rather than written as
// UTC literals — otherwise every assertion here would be timezone-dependent.
// Hours are set after the date so a DST crossing inside the window can't slide
// an observation out of its cluster.
function at(daysAgo, hour, minute = 0) {
  const d = new Date(NOW);
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}

const tool = (daysAgo, hour, minute, extra = {}) => ({
  at: at(daysAgo, hour, minute), kind: "tool", name: "get_weather",
  source: "speech", subject: "household", ...extra,
});

// One call per day at the given hour, for `days` consecutive days ending
// yesterday.
function daily(days, hour, minute = 0, extra = {}) {
  return Array.from({ length: days }, (_, i) => tool(i + 1, hour, minute, extra));
}

// ---- time of day ----

test("a time-of-day habit needs its threshold in distinct days", () => {
  const { minDays, ofDays } = HABIT_RULES.time_of_day;
  assert.deepEqual(detectTimeOfDay(daily(minDays - 1, 7), { now: NOW }), []);
  const [habit] = detectTimeOfDay(daily(minDays, 7), { now: NOW });
  assert.equal(habit.rule, "time_of_day");
  assert.equal(habit.key, "get_weather");
  assert.equal(habit.text, "You usually ask for the weather around 7am");
  assert.deepEqual(habit.support, { n: minDays, of: ofDays });
});

test("one busy day is not a habit", () => {
  // Twenty calls, all on the same day — raw counts would clear the bar easily.
  const rows = Array.from({ length: 20 }, (_, i) => tool(1, 7, i));
  assert.deepEqual(detectTimeOfDay(rows, { now: NOW }), []);
});

test("observations cluster inside the window and split outside it", () => {
  const { minDays } = HABIT_RULES.time_of_day;
  // Half at 6:50, half at 7:10 — 20 minutes apart, one habit.
  const tight = [
    ...daily(minDays, 6, 50).slice(0, minDays / 2),
    ...daily(minDays, 7, 10).slice(minDays / 2),
  ];
  assert.equal(detectTimeOfDay(tight, { now: NOW }).length, 1);

  // Same days, but morning and evening: neither half reaches the threshold.
  const split = daily(minDays, 7).map((r, i) =>
    (i % 2 ? { ...r, at: at(i + 1, 19) } : r));
  assert.deepEqual(detectTimeOfDay(split, { now: NOW }), []);
});

test("a habit straddling midnight counts as one, not two", () => {
  const { minDays } = HABIT_RULES.time_of_day;
  const rows = Array.from({ length: minDays }, (_, i) =>
    tool(i + 1, i % 2 ? 23 : 0, i % 2 ? 50 : 10, { name: "run_routine" }));
  const [habit] = detectTimeOfDay(rows, { now: NOW });
  assert.equal(habit.support.n, minDays);
});

test("plumbing tools and anything outside the window are ignored", () => {
  const { minDays, ofDays } = HABIT_RULES.time_of_day;
  assert.deepEqual(detectTimeOfDay(daily(minDays, 7, 0, { name: "get_current_datetime" }), { now: NOW }), []);
  const stale = Array.from({ length: minDays }, (_, i) => tool(ofDays + i + 1, 7));
  assert.deepEqual(detectTimeOfDay(stale, { now: NOW }), []);
});

test("failed calls and fetched content never become habits", () => {
  const { minDays } = HABIT_RULES.time_of_day;
  assert.deepEqual(detectTimeOfDay(daily(minDays, 7, 0, { ok: false }), { now: NOW }), []);
  assert.deepEqual(detectTimeOfDay(daily(minDays, 7, 0, { source: "external" }), { now: NOW }), []);
});

test("spokenTime says times the way a person would", () => {
  assert.equal(spokenTime(7 * 60), "7am");
  assert.equal(spokenTime(7 * 60 + 30), "7:30am");
  assert.equal(spokenTime(0), "12am");
  assert.equal(spokenTime(12 * 60), "12pm");
  assert.equal(spokenTime(19 * 60 + 5), "7:05pm");
});

// ---- repeated argument ----

test("a repeated argument needs both a count and a share", () => {
  const { minCalls } = HABIT_RULES.repeated_arg;
  const jazz = (n) => Array.from({ length: n }, (_, i) =>
    tool(i + 1, 20, 0, { name: "play_ambient_sound", args: { sound: "jazz" } }));
  const other = (n, offset) => Array.from({ length: n }, (_, i) =>
    tool(offset + i + 1, 20, 0, { name: "play_ambient_sound", args: { sound: `rain ${i}` } }));

  assert.deepEqual(detectRepeatedArg([...jazz(minCalls - 1), ...other(1, 10)], { now: NOW }), []);

  const [habit] = detectRepeatedArg([...jazz(minCalls), ...other(2, 10)], { now: NOW });
  assert.equal(habit.key, "play_ambient_sound|jazz");
  assert.equal(habit.text, "You usually play jazz");
  assert.deepEqual(habit.support, { n: minCalls, of: minCalls + 2 });

  // 6 of 9 is 67% — enough calls, not enough share.
  assert.deepEqual(detectRepeatedArg([...jazz(minCalls), ...other(3, 10)], { now: NOW }), []);
});

test("spellings are counted together but read back as written", () => {
  const { minCalls } = HABIT_RULES.repeated_arg;
  const rows = Array.from({ length: minCalls }, (_, i) =>
    tool(i + 1, 7, 0, { args: { location: i % 3 ? "Portland" : "portland" } }));
  const [habit] = detectRepeatedArg(rows, { now: NOW });
  assert.equal(habit.support.n, minCalls, "one habit, not two");
  assert.equal(habit.key, "get_weather|portland", "the key stays folded so decay still matches");
  assert.equal(habit.text, "You usually ask for the weather in Portland");
});

test("tools with no argument worth counting are skipped", () => {
  const rows = Array.from({ length: 10 }, (_, i) =>
    tool(i + 1, 18, 0, { name: "set_timer", args: { minutes: 8 } }));
  assert.deepEqual(detectRepeatedArg(rows, { now: NOW }), []);
});

// ---- recurring purchases ----

test("a recurring purchase counts distinct weeks, not adds", () => {
  const add = (daysAgo, item = "oat milk", list = "shopping") => ({
    at: at(daysAgo, 10), kind: "list", name: list, source: "speech",
    args: { action: "add", list, item }, summary: `added ${item} to ${list}`,
  });
  // Three adds inside one week clears no bar.
  assert.deepEqual(detectRecurringPurchase([add(1), add(2), add(3)], { now: NOW }), []);

  const [habit] = detectRecurringPurchase([add(1), add(9), add(16)], { now: NOW });
  assert.equal(habit.key, "shopping|oat milk");
  assert.equal(habit.text, "You buy oat milk most weeks");
  assert.deepEqual(habit.support, { n: 3, of: HABIT_RULES.recurring_purchase.ofWeeks });

  // Removals aren't purchases, and a non-shopping list reads differently.
  assert.deepEqual(detectRecurringPurchase([
    { ...add(1), args: { action: "remove", list: "shopping", item: "oat milk" } },
    add(9), add(16),
  ], { now: NOW }), []);
  assert.equal(
    detectRecurringPurchase([add(1, "bleach", "hardware"), add(9, "bleach", "hardware"), add(16, "bleach", "hardware")],
      { now: NOW })[0].text,
    "You add bleach to the hardware list most weeks"
  );
});

// ---- devices ----

test("a device habit is per entity and per action", () => {
  const { minDays, ofDays } = HABIT_RULES.device_habit;
  const flip = (days, action) => Array.from({ length: days }, (_, i) => ({
    at: at(i + 1, 18, 10), kind: "device", name: "porch light", source: "speech",
    args: { action }, summary: `porch light turn ${action}`,
  }));
  assert.deepEqual(detectDeviceHabit(flip(minDays - 1, "on"), { now: NOW }), []);
  const [habit] = detectDeviceHabit([...flip(minDays, "on"), ...flip(2, "off")], { now: NOW });
  assert.equal(habit.key, "porch light|on");
  assert.equal(habit.text, "You usually turn the porch light on around 6:10pm");
  assert.deepEqual(habit.support, { n: minDays, of: ofDays });
});

// ---- aggregation, decay ----

test("detectHabits is deterministic across identical inputs", () => {
  const rows = [
    ...daily(HABIT_RULES.time_of_day.minDays, 7),
    ...Array.from({ length: HABIT_RULES.repeated_arg.minCalls }, (_, i) =>
      tool(i + 1, 20, 0, { name: "play_ambient_sound", args: { sound: "jazz" } })),
  ];
  const once = detectHabits(rows, { now: NOW });
  const twice = detectHabits(rows.slice().reverse(), { now: NOW });
  assert.equal(once.length, 2);
  assert.deepEqual(once, twice);
});

test("measureHabit reads support below the threshold a detector would apply", () => {
  const rows = daily(3, 7); // well under 8/21
  assert.deepEqual(detectTimeOfDay(rows, { now: NOW }), []);
  assert.deepEqual(measureHabit({ rule: "time_of_day", key: "get_weather" }, rows, { now: NOW }), { n: 3, of: 21 });
  // A habit with no trace left at all still measures, as zero.
  assert.deepEqual(measureHabit({ rule: "time_of_day", key: "get_news" }, rows, { now: NOW }), { n: 0, of: 21 });
  assert.equal(measureHabit({ rule: "nonsense", key: "x" }, rows), null);
});

test("decay triggers below half the original threshold, not below it", () => {
  // time_of_day needs 8; 4 is still holding on, 3 has ended.
  assert.equal(isDecayed("time_of_day", { n: 8, of: 21 }), false);
  assert.equal(isDecayed("time_of_day", { n: 4, of: 21 }), false);
  assert.equal(isDecayed("time_of_day", { n: 3, of: 21 }), true);
  assert.equal(isDecayed("time_of_day", { n: 0, of: 21 }), true);
  assert.equal(isDecayed("recurring_purchase", { n: 2, of: 6 }), false);
  assert.equal(isDecayed("recurring_purchase", { n: 1, of: 6 }), true);
  assert.equal(isDecayed("nonsense", { n: 0, of: 1 }), false);
});
