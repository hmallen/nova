import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  sanitizeEvent,
  appendEvents,
  scanArchive,
  readRange,
  sweepArchive,
  archiveMonths,
  archiveStats,
  monthOf,
  MAX_SUMMARY_CHARS,
  MAX_ARGS_CHARS,
} from "../lib/archive.js";

function tmpArchive() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nova-archive-")), "archive");
}

// Rows are hand-written for reads so the at-stamps are exact — the write path
// deliberately ignores caller-supplied timestamps (see sanitizeEvent).
function row(at, extra = {}) {
  return {
    at, kind: "tool", name: "get_weather", summary: "72F, partly cloudy",
    source: "speech", subject: "household", ...extra,
  };
}

function seed(dir, rows) {
  fs.mkdirSync(dir, { recursive: true });
  const byMonth = new Map();
  for (const r of rows) {
    const month = monthOf(r.at);
    byMonth.set(month, (byMonth.get(month) || "") + JSON.stringify(r) + "\n");
  }
  for (const [month, text] of byMonth) fs.appendFileSync(path.join(dir, `${month}.jsonl`), text);
  return dir;
}

// ---- sanitize ----

test("sanitizeEvent stamps its own time and normalizes provenance", () => {
  const event = sanitizeEvent(
    { kind: "tool", name: " get_weather ", summary: "72F", source: "nonsense", at: "1999-01-01T00:00:00Z" },
    { now: () => Date.parse("2026-08-02T15:04:05Z") }
  );
  assert.equal(event.at, "2026-08-02T15:04:05.000Z"); // caller's `at` ignored
  assert.equal(event.name, "get_weather");
  assert.equal(event.source, "speech");
  assert.equal(event.subject, "household");
});

test("sanitizeEvent rejects rows with nothing queryable in them", () => {
  assert.equal(sanitizeEvent(null), null);
  assert.equal(sanitizeEvent({ kind: "nope", name: "x" }), null);
  assert.equal(sanitizeEvent({ kind: "tool", name: "  ", summary: "" }), null);
  assert.ok(sanitizeEvent({ kind: "turn", name: "user", summary: "what's the weather" }));
});

test("sanitizeEvent bounds text and drops non-scalar arguments", () => {
  const event = sanitizeEvent({
    kind: "tool",
    name: "manage_list",
    summary: "x".repeat(500),
    args: { list: "shopping", nested: { a: 1 }, items: [1, 2], big: "y".repeat(400), n: 3, bad: NaN },
  });
  assert.equal(event.summary.length, MAX_SUMMARY_CHARS);
  assert.deepEqual(Object.keys(event.args).sort(), ["big", "list", "n"]);
  assert.equal(event.args.big.length, 120);
  assert.ok(JSON.stringify(event.args).length <= MAX_ARGS_CHARS + 16);
});

test("sanitizeEvent keeps ok only when it is a real boolean", () => {
  assert.equal(sanitizeEvent({ kind: "tool", name: "x", ok: false }).ok, false);
  assert.equal("ok" in sanitizeEvent({ kind: "tool", name: "x", ok: "yes" }), false);
});

// ---- append / read round-trip ----

test("appendEvents creates the directory and round-trips through readRange", async () => {
  const dir = tmpArchive();
  assert.deepEqual(archiveMonths(dir), []); // missing directory is a normal state
  const written = await appendEvents(dir, [
    row("2026-08-01T09:00:00.000Z"),
    row("2026-08-02T09:00:00.000Z", { name: "get_news", source: "external" }),
  ]);
  assert.equal(written, 2);
  assert.deepEqual(archiveMonths(dir), ["2026-08"]);
  assert.equal(archiveStats(dir)[0].month, "2026-08");
  assert.ok(archiveStats(dir)[0].bytes > 0);
  const rows = await readRange(dir, null, null);
  assert.equal(rows.length, 2);
});

test("appendEvents splits a batch that straddles a month boundary", async () => {
  const dir = tmpArchive();
  await appendEvents(dir, [row("2026-07-31T23:59:00.000Z"), row("2026-08-01T00:01:00.000Z")]);
  assert.deepEqual(archiveMonths(dir), ["2026-07", "2026-08"]);
});

test("a malformed line is skipped, not fatal", async () => {
  const dir = seed(tmpArchive(), [row("2026-08-01T09:00:00.000Z")]);
  fs.appendFileSync(path.join(dir, "2026-08.jsonl"), "{not json\n\n");
  const result = await scanArchive(dir, { query: "weather" });
  assert.equal(result.found, true);
  assert.equal(result.events.length, 1);
});

// ---- recall ----

test("scanArchive returns found:false rather than an empty array", async () => {
  const dir = seed(tmpArchive(), [row("2026-08-01T09:00:00.000Z")]);
  const result = await scanArchive(dir, { query: "thermostat" });
  assert.equal(result.found, false);
  assert.deepEqual(result.events, []);
});

test("a missing archive is an honest no-record, not a throw", async () => {
  const result = await scanArchive(path.join(tmpArchive(), "gone"), { query: "anything" });
  assert.equal(result.found, false);
});

test("every query token has to appear, in any field", async () => {
  const dir = seed(tmpArchive(), [
    { ...row("2026-08-01T09:00:00.000Z"), kind: "list", name: "shopping",
      args: { action: "add", list: "shopping", item: "oat milk" }, summary: "added oat milk to shopping" },
  ]);
  // Phrase order and field boundaries don't matter; presence does.
  assert.equal((await scanArchive(dir, { query: "shopping milk" })).found, true);
  assert.equal((await scanArchive(dir, { query: "OAT" })).found, true);
  assert.equal((await scanArchive(dir, { query: "milk bread" })).found, false);
});

test("results cross the month boundary and come back newest first", async () => {
  const dir = seed(tmpArchive(), [
    row("2026-07-28T09:00:00.000Z", { summary: "weather in Portland: cold" }),
    row("2026-07-30T09:00:00.000Z", { summary: "weather in Portland: rain" }),
    row("2026-08-01T09:00:00.000Z", { summary: "weather in Portland: warm" }),
  ]);
  const result = await scanArchive(dir, { query: "portland" });
  assert.deepEqual(result.events.map(e => e.at), [
    "2026-08-01T09:00:00.000Z",
    "2026-07-30T09:00:00.000Z",
    "2026-07-28T09:00:00.000Z",
  ]);
});

test("the newest matches win when a month holds more than the limit", async () => {
  const rows = Array.from({ length: 25 }, (_, i) =>
    row(`2026-08-${String(i + 1).padStart(2, "0")}T09:00:00.000Z`, { summary: `weather day ${i + 1}` }));
  const result = await scanArchive(seed(tmpArchive(), rows), { query: "weather", limit: 10 });
  assert.equal(result.events.length, 10);
  assert.equal(result.events[0].summary, "weather day 25");
  assert.equal(result.events[9].summary, "weather day 16");
});

test("since/until bound by day, not by instant", async () => {
  const dir = seed(tmpArchive(), [
    row("2026-07-19T23:00:00.000Z", { summary: "weather before" }),
    row("2026-07-20T18:00:00.000Z", { summary: "weather during" }),
    row("2026-07-21T01:00:00.000Z", { summary: "weather after" }),
  ]);
  const result = await scanArchive(dir, { query: "weather", since: "2026-07-20", until: "2026-07-20" });
  assert.deepEqual(result.events.map(e => e.summary), ["weather during"]);
});

test("kind narrows the scan", async () => {
  const dir = seed(tmpArchive(), [
    row("2026-08-01T09:00:00.000Z", { kind: "turn", name: "user", summary: "milk please" }),
    row("2026-08-01T09:00:01.000Z", { kind: "list", name: "shopping", summary: "added milk to shopping" }),
  ]);
  assert.equal((await scanArchive(dir, { query: "milk", kind: "list" })).events.length, 1);
  assert.equal((await scanArchive(dir, { query: "milk" })).events.length, 2);
});

test("external rows are archived but stay out of recall by default", async () => {
  const dir = seed(tmpArchive(), [
    row("2026-08-01T09:00:00.000Z", { kind: "turn", name: "assistant", summary: "here's the news", source: "external" }),
    row("2026-08-01T09:05:00.000Z", { kind: "turn", name: "user", summary: "news about the garden" }),
  ]);
  assert.deepEqual(
    (await scanArchive(dir, { query: "news" })).events.map(e => e.summary),
    ["news about the garden"]
  );
  assert.equal((await scanArchive(dir, { query: "news", includeExternal: true })).events.length, 2);
  assert.equal((await readRange(dir, null, null)).length, 2); // still on disk
});

// ---- retention ----

test("the sweep drops expired turns and leaves structured events alone", async () => {
  const now = Date.parse("2026-08-02T12:00:00.000Z");
  const dir = seed(tmpArchive(), [
    { ...row("2026-07-01T09:00:00.000Z"), kind: "turn", name: "user", summary: "old chatter" },
    { ...row("2026-07-01T09:00:01.000Z"), kind: "list", name: "shopping", summary: "added milk to shopping" },
    { ...row("2026-08-02T09:00:00.000Z"), kind: "turn", name: "user", summary: "fresh chatter" },
  ]);
  const result = await sweepArchive(dir, { now, turnRetentionDays: 1 });
  assert.equal(result.removed, 1);
  const kept = (await readRange(dir, null, null)).map(r => r.summary).sort();
  assert.deepEqual(kept, ["added milk to shopping", "fresh chatter"]);
});

test("a month left with nothing is deleted outright", async () => {
  const now = Date.parse("2026-08-02T12:00:00.000Z");
  const dir = seed(tmpArchive(), [
    { ...row("2026-06-01T09:00:00.000Z"), kind: "turn", name: "user", summary: "june chatter" },
    { ...row("2026-08-02T09:00:00.000Z"), kind: "turn", name: "user", summary: "today" },
  ]);
  const result = await sweepArchive(dir, { now, turnRetentionDays: 1 });
  assert.equal(result.deleted, 1);
  assert.deepEqual(archiveMonths(dir), ["2026-08"]);
});

test("retention 0 keeps turns forever", async () => {
  const dir = seed(tmpArchive(), [
    { ...row("2020-01-01T09:00:00.000Z"), kind: "turn", name: "user", summary: "ancient" },
  ]);
  assert.deepEqual(await sweepArchive(dir, { turnRetentionDays: 0 }), { removed: 0, months: 0, deleted: 0 });
  assert.equal((await readRange(dir, null, null)).length, 1);
});
