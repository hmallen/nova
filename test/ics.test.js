import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseIcs, expandEvents, zonedTimeToEpoch } from "../lib/ics.js";

const fixture = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "sample.ics"),
  "utf8"
);

test("zonedTimeToEpoch handles EST vs EDT (America/New_York)", () => {
  // 2:30 PM wall clock: UTC-5 in January, UTC-4 in July.
  const winter = zonedTimeToEpoch(2026, 1, 15, 14, 30, 0, "America/New_York");
  assert.equal(new Date(winter).toISOString(), "2026-01-15T19:30:00.000Z");
  const summer = zonedTimeToEpoch(2026, 7, 15, 14, 30, 0, "America/New_York");
  assert.equal(new Date(summer).toISOString(), "2026-07-15T18:30:00.000Z");
});

test("zonedTimeToEpoch across the fall-back boundary stays consistent", () => {
  // 2026-11-01: US clocks fall back at 2:00. 01:30 is ambiguous — accept
  // either offset, but the result must round-trip to the requested wall time.
  const ts = zonedTimeToEpoch(2026, 11, 1, 1, 30, 0, "America/New_York");
  const wall = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(ts));
  assert.equal(wall, "01:30");
});

test("parseIcs: folded summary lines, TZID datetimes, all-day events", () => {
  const events = parseIcs(fixture);
  assert.equal(events.length, 3);
  const [sync, birthday, monthly] = events;
  assert.equal(sync.summary, "Team sync with a very long name folded across lines");
  // 14:30 America/New_York on 2026-01-06 = 19:30 UTC (EST)
  assert.equal(new Date(sync.start).toISOString(), "2026-01-06T19:30:00.000Z");
  assert.equal(sync.allDay, false);
  assert.equal(birthday.summary, "Birthday");
  assert.equal(birthday.allDay, true);
  assert.ok(monthly.recurringUnsupported, "FREQ=MONTHLY should be flagged unsupported");
});

test("weekly RRULE with BYDAY expands to Tuesdays inside the window (EDT shifts the hour)", () => {
  const events = parseIcs(fixture);
  const { events: out, unsupported } = expandEvents(
    events,
    Date.UTC(2026, 5, 1),      // June 1 2026
    Date.UTC(2026, 5, 30, 23, 59)
  );
  assert.ok(unsupported, "monthly event should surface the unsupported flag");
  const syncs = out.filter(e => e.summary.startsWith("Team sync"));
  // Tuesdays in June 2026: 2, 9, 16, 23, 30
  assert.equal(syncs.length, 5);
  for (const s of syncs) {
    const d = new Date(s.start);
    assert.equal(d.getUTCDay(), 2, "must land on a Tuesday");
    // 14:30 EDT = 18:30 UTC — recurrence keeps local wall time across DST.
    assert.equal(d.getUTCHours(), 18);
    assert.equal(d.getUTCMinutes(), 30);
  }
});

test("UNTIL cuts the recurrence off", () => {
  const events = parseIcs(fixture);
  const { events: out } = expandEvents(
    events,
    Date.UTC(2026, 6, 1),      // July 2026 — after UNTIL=20260701
    Date.UTC(2026, 6, 31)
  );
  assert.equal(out.filter(e => e.summary.startsWith("Team sync")).length, 0);
});

test("COUNT limits total occurrences from DTSTART", () => {
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "SUMMARY:Three mornings",
    "DTSTART:20260720T080000Z",
    "DTEND:20260720T081500Z",
    "RRULE:FREQ=DAILY;COUNT=3",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  const { events: out } = expandEvents(parseIcs(ics), Date.UTC(2026, 6, 1), Date.UTC(2026, 7, 1));
  assert.deepEqual(
    out.map(e => new Date(e.start).toISOString().slice(0, 10)),
    ["2026-07-20", "2026-07-21", "2026-07-22"]
  );
});

test("EXDATE makes a recurring event unsupported rather than wrong", () => {
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "SUMMARY:Standup",
    "DTSTART:20260701T090000Z",
    "RRULE:FREQ=DAILY",
    "EXDATE:20260703T090000Z",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  const parsed = parseIcs(ics);
  assert.ok(parsed[0].recurringUnsupported);
  const { events: out, unsupported } = expandEvents(parsed, Date.UTC(2026, 6, 1), Date.UTC(2026, 6, 10));
  assert.equal(out.length, 0);
  assert.ok(unsupported);
});
