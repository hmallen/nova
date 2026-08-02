// Calendar read/write routes. The ICS half is read-only by nature; writes go
// to Google, so these boot the real server with a seeded refresh token and
// stub googleapis.com out from under it.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createNovaServer } from "../server.js";

function tmpDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nova-cal-"));
}

function listen(server) {
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`))
  );
}

// Intercept only Google; the server's own loopback requests must still work.
function withGoogleStub(t, handler) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    if (!href.includes("googleapis.com") && !href.includes("accounts.google.com")) {
      return real(url, init);
    }
    calls.push({ url: href, method: init.method || "GET", body: init.body });
    const out = handler(href, init) || {};
    return {
      ok: (out.status ?? 200) < 400,
      status: out.status ?? 200,
      json: async () => out.body ?? {},
    };
  };
  t.after(() => { globalThis.fetch = real; });
  return calls;
}

function seedGoogleToken(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, "google.json"),
    JSON.stringify({ google: { refresh_token: "rt-test" }, rev: 1 })
  );
  return dataDir;
}

const GOOGLE_ENV = {
  OPENAI_API_KEY: "sk-test",
  GOOGLE_CLIENT_ID: "test-client",
  GOOGLE_CLIENT_SECRET: "test-secret",
};

test("calendar: writes are refused until Google is connected", async (t) => {
  const server = createNovaServer({ env: GOOGLE_ENV, dataDir: tmpDataDir() });
  const base = await listen(server);
  t.after(() => server.close());

  await t.test("/api/config advertises the connect flow but not write access", async () => {
    const config = await (await fetch(base + "/api/config")).json();
    assert.equal(config.googleConfigured, true);
    assert.equal(config.calendarWritable, false);
    assert.equal(config.calendar, false, "no feed and no connection means no calendar tool");
  });

  await t.test("creating an event answers 409, not a silent failure", async () => {
    const resp = await fetch(base + "/api/calendar/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ summary: "Dentist", start: "2026-08-05T15:00" }),
    });
    assert.equal(resp.status, 409);
    assert.equal((await resp.json()).needs_connect, true);
  });

  await t.test("a server with no Google credentials at all answers 501", async () => {
    const bare = createNovaServer({ env: { OPENAI_API_KEY: "sk-test" }, dataDir: tmpDataDir() });
    const bareBase = await listen(bare);
    t.after(() => bare.close());
    const resp = await fetch(bareBase + "/api/calendar/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ summary: "x", start: "2026-08-05T15:00" }),
    });
    assert.equal(resp.status, 501);
  });
});

test("calendar: create, update, cancel against a connected calendar", async (t) => {
  const dataDir = seedGoogleToken(tmpDataDir());
  const stored = {
    id: "ev-1",
    summary: "Dentist",
    start: { dateTime: "2026-08-05T15:00:00-07:00" },
    end: { dateTime: "2026-08-05T16:00:00-07:00" },
  };
  const calls = withGoogleStub(t, (href, init) => {
    if (href.includes("oauth2.googleapis.com/token")) {
      return { body: { access_token: "at-test", expires_in: 3600 } };
    }
    if (init.method === "POST" || init.method === "PATCH") {
      return { body: { ...stored, ...JSON.parse(init.body) } };
    }
    if (init.method === "DELETE") return { status: 204 };
    if (href.includes("/events/ev-1")) return { body: stored };
    return { body: { items: [stored] } };
  });

  const server = createNovaServer({ env: GOOGLE_ENV, dataDir });
  const base = await listen(server);
  t.after(() => server.close());

  await t.test("/api/config reports the calendar as writable", async () => {
    const config = await (await fetch(base + "/api/config")).json();
    assert.equal(config.calendar, true);
    assert.equal(config.calendarWritable, true);
  });

  await t.test("GET /api/calendar returns events with ids", async () => {
    const body = await (await fetch(base + "/api/calendar?days=1")).json();
    assert.equal(body.writable, true);
    assert.equal(body.events[0].id, "ev-1");
    assert.equal(body.events[0].source, "google");
  });

  await t.test("POST creates the event with the caller's zone", async () => {
    const resp = await fetch(base + "/api/calendar/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        summary: "Dentist", start: "2026-08-05T15:00",
        duration_minutes: 30, timezone: "America/Los_Angeles",
      }),
    });
    assert.equal(resp.status, 201);
    const sent = JSON.parse(calls.at(-1).body);
    assert.equal(sent.start.dateTime, "2026-08-05T15:00:00-07:00");
    assert.equal(sent.end.dateTime, "2026-08-05T15:30:00-07:00");
    assert.equal(sent.start.timeZone, "America/Los_Angeles");
  });

  await t.test("POST validates before it reaches Google", async () => {
    const before = calls.length;
    const resp = await fetch(base + "/api/calendar/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ summary: "Bad", start: "sometime tomorrow" }),
    });
    assert.equal(resp.status, 400);
    assert.match((await resp.json()).error, /local datetime/);
    assert.equal(calls.length, before, "an invalid draft must not hit the API");
  });

  await t.test("PATCH keeps the untouched half of the event", async () => {
    const resp = await fetch(base + "/api/calendar/events/ev-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ start: "2026-08-05T17:00", timezone: "America/Los_Angeles" }),
    });
    assert.equal(resp.status, 200);
    const sent = JSON.parse(calls.at(-1).body);
    assert.equal(sent.summary, "Dentist", "the title carried over from the stored event");
    assert.equal(sent.start.dateTime, "2026-08-05T17:00:00-07:00");
    // An hour-long event moved by start alone keeps its length.
    assert.equal(sent.end.dateTime, "2026-08-05T18:00:00-07:00");
  });

  await t.test("DELETE names what it cancelled", async () => {
    const resp = await fetch(base + "/api/calendar/events/ev-1", { method: "DELETE" });
    assert.equal(resp.status, 200);
    assert.equal((await resp.json()).summary, "Dentist");
  });

  await t.test("calendar writes land in the archive", async () => {
    await server.novaMemory.settled();
    const hit = await (await fetch(base + "/api/memory/recall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "Dentist", kind: "calendar" }),
    })).json();
    assert.equal(hit.found, true);
    assert.ok(hit.events.length >= 2, "create and cancel both recorded");
  });
});

test("calendar: moving an event keeps its length, not the default hour", async (t) => {
  const short = {
    id: "ev-short",
    summary: "Standup",
    start: { dateTime: "2026-08-05T09:00:00-07:00" },
    end: { dateTime: "2026-08-05T09:15:00-07:00" },
  };
  const trip = {
    id: "ev-trip",
    summary: "Portland",
    start: { date: "2026-08-05" },
    end: { date: "2026-08-08" },   // exclusive: the 5th through the 7th
  };
  const sent = [];
  withGoogleStub(t, (href, init) => {
    if (href.includes("oauth2.googleapis.com/token")) {
      return { body: { access_token: "at-test", expires_in: 3600 } };
    }
    const stored = href.includes("ev-trip") ? trip : short;
    if (init.method === "PATCH") {
      const patch = JSON.parse(init.body);
      sent.push(patch);
      return { body: { ...stored, ...patch } };
    }
    return { body: stored };
  });

  const server = createNovaServer({ env: GOOGLE_ENV, dataDir: seedGoogleToken(tmpDataDir()) });
  const base = await listen(server);
  t.after(() => server.close());

  await t.test("a fifteen-minute meeting stays fifteen minutes", async () => {
    const resp = await fetch(base + "/api/calendar/events/ev-short", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ start: "2026-08-05T16:00", timezone: "America/Los_Angeles" }),
    });
    assert.equal(resp.status, 200);
    assert.equal(sent.at(-1).start.dateTime, "2026-08-05T16:00:00-07:00");
    assert.equal(sent.at(-1).end.dateTime, "2026-08-05T16:15:00-07:00");
  });

  await t.test("an explicit duration still wins", async () => {
    await fetch(base + "/api/calendar/events/ev-short", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        start: "2026-08-05T16:00", duration_minutes: 45, timezone: "America/Los_Angeles",
      }),
    });
    assert.equal(sent.at(-1).end.dateTime, "2026-08-05T16:45:00-07:00");
  });

  await t.test("a three-day trip moved to a new start day is still three days", async () => {
    const resp = await fetch(base + "/api/calendar/events/ev-trip", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ start: "2026-09-10", timezone: "America/Los_Angeles" }),
    });
    assert.equal(resp.status, 200);
    assert.deepEqual(sent.at(-1).start, { date: "2026-09-10" });
    assert.deepEqual(sent.at(-1).end, { date: "2026-09-13" }, "10th–12th inclusive");
  });
});

test("calendar: the OAuth callback refuses a request it did not start", async (t) => {
  const server = createNovaServer({ env: GOOGLE_ENV, dataDir: tmpDataDir() });
  const base = await listen(server);
  t.after(() => server.close());

  await t.test("/api/google/auth redirects to Google's consent screen", async () => {
    const resp = await fetch(base + "/api/google/auth", { redirect: "manual" });
    assert.equal(resp.status, 302);
    const location = new URL(resp.headers.get("location"));
    assert.equal(location.hostname, "accounts.google.com");
    assert.match(location.searchParams.get("redirect_uri"), /\/api\/google\/callback$/);
  });

  await t.test("a callback with no state is rejected", async () => {
    const resp = await fetch(base + "/api/google/callback?code=stolen");
    assert.equal(resp.status, 400);
    assert.match(await resp.text(), /stale or unexpected/);
  });

  await t.test("Google's own error is echoed escaped, not interpreted", async () => {
    const resp = await fetch(base + "/api/google/callback?error=" + encodeURIComponent("<img src=x>"));
    assert.equal(resp.status, 400);
    const html = await resp.text();
    assert.ok(!html.includes("<img src=x>"), "the parameter must not reach the page as markup");
    assert.match(html, /&lt;img/);
  });
});

test("calendar: a broken Google link does not black out a working ICS feed", async (t) => {
  const ics = [
    "BEGIN:VCALENDAR", "BEGIN:VEVENT", "SUMMARY:Feed only",
    "DTSTART:20260805T150000Z", "DTEND:20260805T160000Z", "END:VEVENT", "END:VCALENDAR",
  ].join("\r\n");
  const feed = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/calendar" });
    res.end(ics);
  });
  const feedBase = await listen(feed);
  t.after(() => feed.close());

  const dataDir = seedGoogleToken(tmpDataDir());
  withGoogleStub(t, (href) => {
    if (href.includes("oauth2.googleapis.com/token")) {
      return { body: { access_token: "at-test", expires_in: 3600 } };
    }
    return { status: 500, body: { error: { message: "Backend error" } } };
  });

  // The window has to cover the fixture's date for the feed to return it.
  const server = createNovaServer({
    env: { ...GOOGLE_ENV, ICS_URL: feedBase + "/cal.ics" },
    dataDir,
  });
  const base = await listen(server);
  t.after(() => server.close());

  const body = await (await fetch(base + "/api/calendar?days=7")).json();
  assert.match(body.note, /Google Calendar couldn't be reached/);
  assert.equal(body.writable, true, "the connection is still configured, just unreachable");
  // The point of the fallback: the feed's events still come back.
  const feedEvent = body.events.find(e => e.summary === "Feed only");
  assert.ok(feedEvent, "the ICS feed still answered");
  assert.equal(feedEvent.source, "ics");
  assert.equal(feedEvent.id, "", "feed events carry no id — they cannot be edited");
});
