import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStore } from "../lib/store.js";
import {
  buildEventResource,
  fromGoogleEvent,
  localToRfc3339,
  isoToLocal,
  addMinutes,
  isValidTimeZone,
  createGoogleCalendar,
  GoogleCalendarError,
} from "../lib/gcal.js";

const LA = "America/Los_Angeles";

function tmpStore(initial) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nova-gcal-"));
  const file = path.join(dir, "google.json");
  if (initial) fs.writeFileSync(file, JSON.stringify(initial));
  return createStore(file, { google: {} });
}

// A fetch stub that answers from a queue and records what it was asked.
function stubFetch(responses) {
  const calls = [];
  const queue = [...responses];
  const impl = async (url, init = {}) => {
    const body = init.body instanceof URLSearchParams || typeof init.body === "string"
      ? String(init.body)
      : undefined;
    calls.push({ url: String(url), method: init.method || "GET", body });
    const next = queue.shift();
    if (!next) throw new Error(`unexpected fetch: ${url}`);
    return {
      ok: next.status === undefined ? true : next.status < 400,
      status: next.status ?? 200,
      json: async () => next.body ?? {},
    };
  };
  impl.calls = calls;
  return impl;
}

// ------------------------------------------------------------- time ----

test("localToRfc3339 stamps the zone's real offset on both sides of DST", () => {
  assert.equal(localToRfc3339("2026-01-15T14:30", LA), "2026-01-15T14:30:00-08:00");
  assert.equal(localToRfc3339("2026-07-15T14:30", LA), "2026-07-15T14:30:00-07:00");
  assert.equal(localToRfc3339("not a datetime", LA), null);
});

test("isoToLocal is the inverse of localToRfc3339", () => {
  for (const local of ["2026-01-15T14:30", "2026-07-15T09:05", "2026-11-01T23:00"]) {
    assert.equal(isoToLocal(localToRfc3339(local, LA), LA), local);
  }
  assert.equal(isoToLocal("2026-08-05T12:00:00Z", LA, { dateOnly: true }), "2026-08-05");
  assert.equal(isoToLocal("nonsense", LA), null);
});

test("addMinutes rolls over hours, days and months", () => {
  assert.equal(addMinutes("2026-08-05T15:00", 60), "2026-08-05T16:00");
  assert.equal(addMinutes("2026-08-05T23:30", 45), "2026-08-06T00:15");
  assert.equal(addMinutes("2026-08-31T23:00", 120), "2026-09-01T01:00");
});

test("isValidTimeZone accepts IANA zones and rejects junk", () => {
  assert.ok(isValidTimeZone(LA));
  assert.ok(isValidTimeZone("UTC"));
  assert.ok(!isValidTimeZone("Mars/Olympus"));
  assert.ok(!isValidTimeZone(""));
  assert.ok(!isValidTimeZone(undefined));
});

// ------------------------------------------------------------ drafts ----

test("buildEventResource: a timed event defaults to an hour", () => {
  const { event, error } = buildEventResource(
    { summary: "Dentist", start: "2026-08-05T15:00" }, { timeZone: LA }
  );
  assert.equal(error, undefined);
  assert.equal(event.summary, "Dentist");
  assert.equal(event.start.dateTime, "2026-08-05T15:00:00-07:00");
  assert.equal(event.end.dateTime, "2026-08-05T16:00:00-07:00");
  assert.equal(event.start.timeZone, LA);
});

test("buildEventResource: duration_minutes and an explicit end both work", () => {
  const byDuration = buildEventResource(
    { summary: "Standup", start: "2026-08-05T09:00", duration_minutes: 15 }, { timeZone: LA }
  ).event;
  assert.equal(byDuration.end.dateTime, "2026-08-05T09:15:00-07:00");

  const byEnd = buildEventResource(
    { summary: "Workshop", start: "2026-08-05T09:00", end: "2026-08-05T17:30" }, { timeZone: LA }
  ).event;
  assert.equal(byEnd.end.dateTime, "2026-08-05T17:30:00-07:00");
});

test("buildEventResource: all-day end date is exclusive on the wire, inclusive in the contract", () => {
  const oneDay = buildEventResource(
    { summary: "Birthday", start: "2026-08-05", all_day: true }, { timeZone: LA }
  ).event;
  assert.deepEqual(oneDay.start, { date: "2026-08-05" });
  assert.deepEqual(oneDay.end, { date: "2026-08-06" }, "a one-day event ends the next day");

  const trip = buildEventResource(
    { summary: "Trip", start: "2026-08-05", end: "2026-08-07", all_day: true }, { timeZone: LA }
  ).event;
  assert.deepEqual(trip.end, { date: "2026-08-08" }, "the 5th through the 7th is three days");
});

test("buildEventResource rejects drafts that would corrupt the calendar", () => {
  const cases = [
    [{ start: "2026-08-05T15:00" }, /needs a title/],
    [{ summary: "x", start: "tomorrow" }, /local datetime/],
    [{ summary: "x", start: "2026-08-05T15:00", end: "2026-08-05T14:00" }, /ends before it starts/],
    [{ summary: "x", start: "2026-08-05", all_day: true, end: "2026-08-01" }, /ends before it starts/],
    [{ summary: "x", start: "2026-08-05T15:00", end: "nope" }, /local datetime/],
    [{ summary: "x", all_day: true, start: "2026-08-05T15:00" }, /date like/],
  ];
  for (const [draft, re] of cases) {
    const { event, error } = buildEventResource(draft, { timeZone: LA });
    assert.equal(event, undefined, `${JSON.stringify(draft)} should not build`);
    assert.match(error, re);
  }
  assert.match(
    buildEventResource({ summary: "x", start: "2026-08-05T15:00" }, { timeZone: "Mars/Olympus" }).error,
    /time zone/
  );
});

test("buildEventResource trims and caps free text", () => {
  const { event } = buildEventResource(
    { summary: "  Team   sync  ", start: "2026-08-05T15:00", location: "x".repeat(900) },
    { timeZone: LA }
  );
  assert.equal(event.summary, "Team sync");
  assert.equal(event.location.length, 500);
});

// ------------------------------------------------------------ reading ----

test("fromGoogleEvent maps timed, all-day and cancelled events", () => {
  const timed = fromGoogleEvent({
    id: "abc", summary: "Dentist",
    start: { dateTime: "2026-08-05T15:00:00-07:00" },
    end: { dateTime: "2026-08-05T16:00:00-07:00" },
    htmlLink: "https://calendar.google.com/x",
  });
  assert.equal(timed.id, "abc");
  assert.equal(timed.all_day, false);
  assert.equal(timed.start_iso, "2026-08-05T22:00:00.000Z");
  assert.equal(timed.source, "google");
  assert.equal(timed.html_link, "https://calendar.google.com/x");

  const allDay = fromGoogleEvent({
    id: "d1", summary: "Birthday",
    start: { date: "2026-08-05" }, end: { date: "2026-08-06" },
  });
  assert.equal(allDay.all_day, true);
  // The exclusive end is folded back so the event doesn't read as two days.
  assert.equal(new Date(allDay.end_iso).getDate(), 5);

  assert.equal(fromGoogleEvent({ id: "z", status: "cancelled" }), null);
  assert.equal(fromGoogleEvent({ id: "z", summary: "no start" }), null);
  assert.equal(fromGoogleEvent(null), null);
});

// ------------------------------------------------------------- oauth ----

test("an unconfigured client is inert rather than half-working", async () => {
  const cal = createGoogleCalendar({});
  assert.equal(cal.configured, false);
  assert.equal(cal.connected(), false);
  await assert.rejects(() => cal.listEvents({ timeMin: 0, timeMax: 1 }), /isn't configured/);
});

test("the auth URL asks for offline access and a fresh consent", () => {
  const cal = createGoogleCalendar({ clientId: "id", clientSecret: "secret", store: tmpStore() });
  const url = new URL(cal.beginAuth("http://localhost:3000/api/google/callback"));
  assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.equal(url.searchParams.get("prompt"), "consent");
  assert.equal(url.searchParams.get("scope"), "https://www.googleapis.com/auth/calendar.events");
  assert.ok(url.searchParams.get("state"));
});

test("the callback's state parameter is required, single-use, and compared exactly", () => {
  const cal = createGoogleCalendar({ clientId: "id", clientSecret: "secret", store: tmpStore() });
  const state = new URL(cal.beginAuth("http://x/cb")).searchParams.get("state");
  assert.equal(cal.checkState("something-else"), false, "a wrong state is rejected");

  const fresh = new URL(cal.beginAuth("http://x/cb")).searchParams.get("state");
  assert.equal(cal.checkState(fresh), true);
  assert.equal(cal.checkState(fresh), false, "the same state cannot be replayed");
  assert.equal(cal.checkState(state), false, "a superseded state is dead");
  assert.equal(cal.checkState(undefined), false);
});

test("connect stores only the refresh token, and refuses a grant without one", async () => {
  const store = tmpStore();
  const fetchImpl = stubFetch([
    { body: { access_token: "at1", refresh_token: "rt1", expires_in: 3600, scope: "s" } },
  ]);
  const cal = createGoogleCalendar({ clientId: "id", clientSecret: "secret", store, fetchImpl });
  await cal.connect("code-1", "http://x/cb");
  assert.equal(cal.connected(), true);
  assert.equal(store.get().google.refresh_token, "rt1");
  assert.equal(store.get().google.access_token, undefined, "access tokens are not persisted");
  assert.match(fetchImpl.calls[0].body, /grant_type=authorization_code/);

  const noRefresh = createGoogleCalendar({
    clientId: "id", clientSecret: "secret", store: tmpStore(),
    fetchImpl: stubFetch([{ body: { access_token: "at", expires_in: 3600 } }]),
  });
  await assert.rejects(() => noRefresh.connect("c", "http://x/cb"), /refresh token/);
});

test("the access token is cached and reused across calls", async () => {
  const fetchImpl = stubFetch([
    { body: { access_token: "at1", expires_in: 3600 } },   // one refresh
    { body: { items: [] } },                                // two API calls
    { body: { items: [] } },
  ]);
  const cal = createGoogleCalendar({
    clientId: "id", clientSecret: "secret",
    store: tmpStore({ google: { refresh_token: "rt1" } }), fetchImpl,
  });
  await cal.listEvents({ timeMin: 0, timeMax: 1000 });
  await cal.listEvents({ timeMin: 0, timeMax: 1000 });
  const refreshes = fetchImpl.calls.filter(c => c.url.includes("oauth2.googleapis.com/token"));
  assert.equal(refreshes.length, 1, "the second call reused the cached token");
  assert.match(refreshes[0].body, /grant_type=refresh_token/);
});

test("a revoked grant clears the stored token and asks for a reconnect", async () => {
  const store = tmpStore({ google: { refresh_token: "rt-dead" } });
  const cal = createGoogleCalendar({
    clientId: "id", clientSecret: "secret", store,
    fetchImpl: stubFetch([{ status: 400, body: { error: "invalid_grant" } }]),
  });
  await assert.rejects(
    () => cal.listEvents({ timeMin: 0, timeMax: 1 }),
    (err) => {
      assert.ok(err instanceof GoogleCalendarError);
      assert.equal(err.needsReconnect, true);
      assert.match(err.message, /revoked/);
      return true;
    }
  );
  // Keeping a dead token would retry forever and never recover.
  assert.equal(store.get().google.refresh_token, undefined);
  assert.equal(cal.connected(), false);
});

test("listEvents asks Google to expand recurrence, and create/delete hit the right verbs", async () => {
  const fetchImpl = stubFetch([
    { body: { access_token: "at1", expires_in: 3600 } },
    { body: { items: [{ id: "e1", summary: "Sync", start: { dateTime: "2026-08-05T15:00:00Z" }, end: { dateTime: "2026-08-05T16:00:00Z" } }] } },
    { body: { id: "new1", summary: "Dentist", start: { dateTime: "2026-08-05T15:00:00Z" }, end: { dateTime: "2026-08-05T16:00:00Z" } } },
    { status: 204, body: {} },
  ]);
  const cal = createGoogleCalendar({
    clientId: "id", clientSecret: "secret", calendarId: "primary",
    store: tmpStore({ google: { refresh_token: "rt1" } }), fetchImpl,
  });

  const events = await cal.listEvents({ timeMin: Date.UTC(2026, 7, 5), timeMax: Date.UTC(2026, 7, 6) });
  assert.equal(events.length, 1);
  const listUrl = new URL(fetchImpl.calls[1].url);
  assert.equal(listUrl.searchParams.get("singleEvents"), "true");
  assert.equal(listUrl.searchParams.get("orderBy"), "startTime");

  const created = await cal.createEvent({ summary: "Dentist" });
  assert.equal(created.id, "new1");
  assert.equal(fetchImpl.calls[2].method, "POST");

  await cal.deleteEvent("new1");
  assert.equal(fetchImpl.calls[3].method, "DELETE");
  assert.match(fetchImpl.calls[3].url, /events\/new1$/);
});

test("updateEvent patches rather than replaces", async () => {
  const fetchImpl = stubFetch([
    { body: { access_token: "at1", expires_in: 3600 } },
    { body: { id: "e1", summary: "Moved", start: { dateTime: "2026-08-05T18:00:00Z" }, end: { dateTime: "2026-08-05T19:00:00Z" } } },
  ]);
  const cal = createGoogleCalendar({
    clientId: "id", clientSecret: "secret",
    store: tmpStore({ google: { refresh_token: "rt1" } }), fetchImpl,
  });
  await cal.updateEvent("e1", { summary: "Moved" });
  // PUT would silently drop guests and reminders the user never mentioned.
  assert.equal(fetchImpl.calls[1].method, "PATCH");
});

test("disconnect revokes upstream and forgets locally even if the revoke fails", async () => {
  const store = tmpStore({ google: { refresh_token: "rt1" } });
  const cal = createGoogleCalendar({
    clientId: "id", clientSecret: "secret", store,
    fetchImpl: async () => { throw new Error("network down"); },
  });
  await cal.disconnect();
  assert.equal(cal.connected(), false);
  assert.equal(store.get().google.refresh_token, undefined);
});
