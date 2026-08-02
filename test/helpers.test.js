import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatElapsedTime,
  matchesWakeWord,
  normalizePinnedDeviceKeys,
  readIdleTimeoutMs,
  redactArgs,
  summarizeToolResult,
  spokenPastTime,
  DEFAULT_IDLE_TIMEOUT_MS,
} from "../public/lib/helpers.js";

test("formatElapsedTime renders stopwatch durations", () => {
  assert.equal(formatElapsedTime(0), "0:00");
  assert.equal(formatElapsedTime(65_999), "1:05");
  assert.equal(formatElapsedTime(3_661_000), "1:01:01");
  assert.equal(formatElapsedTime(-1_000), "0:00");
  assert.equal(formatElapsedTime(Number.NaN), "0:00");
});

test("normalizePinnedDeviceKeys keeps unique, usable entity keys", () => {
  assert.deepEqual(normalizePinnedDeviceKeys(null), []);
  assert.deepEqual(
    normalizePinnedDeviceKeys(["light.office", "", 42, " light.office ", "fan.bedroom"]),
    ["light.office", "fan.bedroom"]
  );
});

// ---- memory archive (Plan 10) ----

test("redactArgs keeps only the fields worth querying later", () => {
  assert.deepEqual(
    redactArgs("manage_list", { action: "add", list: "shopping", item: " oat milk ", secret: "x" }),
    { action: "add", list: "shopping", item: "oat milk" }
  );
  assert.deepEqual(redactArgs("control_device", { device: "porch light", action: "on", value: 0 }),
    { device: "porch light", action: "on", value: 0 });
  // Absent fields are omitted rather than stored as empty.
  assert.deepEqual(redactArgs("get_weather", { location: "  " }), {});
  // A tool with no allowlist archives with no arguments at all.
  assert.deepEqual(redactArgs("some_future_tool", { anything: "here" }), {});
});

test("redactArgs never copies what the user asked to be remembered", () => {
  // The text is already a fact in memory.json; a copy in an append-only log is
  // one "forget that" can't reach.
  assert.deepEqual(redactArgs("remember", { action: "add", text: "Allergic to shellfish" }),
    { action: "add" });
  assert.deepEqual(redactArgs("manage_preferences", { action: "set", home_city: "Portland" }),
    { action: "set" });
});

test("summarizeToolResult reads back as one short line", () => {
  assert.equal(summarizeToolResult({ ok: true, list: "shopping", added: "milk", count: 3 }),
    "list: shopping, added: milk, count: 3");
  assert.equal(summarizeToolResult({ error: "No device called \"lamp\"." }), 'No device called "lamp".');
  assert.equal(summarizeToolResult(null), "");
  assert.equal(summarizeToolResult({ ok: true }), "");
  assert.ok(summarizeToolResult({ note: "y".repeat(400) }).length <= 200);
});

test("summarizeToolResult leaves fetched third-party text out", () => {
  // Headlines arrive as objects, so nothing about their content survives —
  // the row records that news was fetched, not what it said.
  const news = { headlines: [{ title: "Something happened", source: "Wire" }] };
  assert.equal(summarizeToolResult(news), "");
  // Plain string arrays are still summarized, up to five.
  assert.equal(summarizeToolResult({ items: ["milk", "eggs"] }), "items: milk, eggs");
});

test("spokenPastTime says when, the way a person would", () => {
  const now = new Date(2026, 7, 2, 12, 0, 0).getTime(); // local noon, Aug 2
  const local = (day, hour) => new Date(2026, 7, day, hour, 5, 0).toISOString();
  assert.match(spokenPastTime(local(2, 9), now), /^today at /);
  assert.match(spokenPastTime(local(1, 9), now), /^yesterday at /);
  // Inside the week, the weekday carries it; past that, the date does.
  const july29 = new Date(2026, 6, 29, 9, 5);
  assert.match(spokenPastTime(july29.toISOString(), now),
    new RegExp(`^${july29.toLocaleDateString([], { weekday: "long" })} at `));
  assert.equal(spokenPastTime(new Date(2026, 6, 20, 9, 5).toISOString(), now).includes(" at "), false);
  assert.equal(spokenPastTime("not a date"), "at some point");
});

// ---- wake word & idle timeout ----

test("matchesWakeWord accepts what the recognizer actually returns", () => {
  // Exact, and the shapes browsers really hand back for "Nova".
  for (const heard of [
    "Nova",
    "nova",
    "hey nova, what's the weather",
    "Nova.",                 // final results arrive punctuated
    "no va",                 // two-word split is the most common miss
    "Novah",
    "noah",
    "OK NOVA",
  ]) {
    assert.equal(matchesWakeWord(heard), true, `should wake on ${JSON.stringify(heard)}`);
  }
});

test("matchesWakeWord ignores ordinary speech", () => {
  for (const heard of ["november", "innovation", "not now", "", null, undefined, "supernova"]) {
    assert.equal(matchesWakeWord(heard), false, `should ignore ${JSON.stringify(heard)}`);
  }
});

test("readIdleTimeoutMs falls back rather than listening forever", () => {
  assert.equal(readIdleTimeoutMs(null), DEFAULT_IDLE_TIMEOUT_MS);
  assert.equal(readIdleTimeoutMs(undefined), DEFAULT_IDLE_TIMEOUT_MS);
  assert.equal(readIdleTimeoutMs(""), DEFAULT_IDLE_TIMEOUT_MS);
  assert.equal(readIdleTimeoutMs("  "), DEFAULT_IDLE_TIMEOUT_MS);
  assert.equal(readIdleTimeoutMs("banana"), DEFAULT_IDLE_TIMEOUT_MS);
  assert.equal(readIdleTimeoutMs(-5), DEFAULT_IDLE_TIMEOUT_MS);
});

test("readIdleTimeoutMs reads seconds, clamped to something sane", () => {
  assert.equal(readIdleTimeoutMs("120"), 120_000);
  assert.equal(readIdleTimeoutMs(90), 90_000);
  assert.equal(readIdleTimeoutMs("45.5"), 45_500);
  // Too short would cut off a thinking pause; too long isn't a timeout at all.
  assert.equal(readIdleTimeoutMs("3"), 10_000);
  assert.equal(readIdleTimeoutMs("99999"), 30 * 60_000);
});

test("readIdleTimeoutMs lets a device opt out explicitly", () => {
  assert.equal(readIdleTimeoutMs("off"), 0);
  assert.equal(readIdleTimeoutMs("never"), 0);
  assert.equal(readIdleTimeoutMs("0"), 0);
  assert.equal(readIdleTimeoutMs("OFF"), 0);
});
