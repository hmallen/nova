// Google Calendar read/write for the calendar skill.
//
// The ICS side of this feature (lib/ics.js) reads a subscription feed, which
// is HTTP GET and therefore permanently read-only. Writing to the calendar
// the household actually uses means the Google Calendar API, so this module
// is the write half: OAuth 2.0 authorization-code flow, a cached access
// token, and the four event calls.
//
// Zero dependencies, same as everything else here — `fetch` and node:crypto.
//
// Two things are deliberately not generic:
//   - Scope is calendar.events, not calendar. Nova creates and edits events;
//     it has no business creating calendars or reading anyone's ACLs.
//   - The refresh token never leaves the server. It lives in data/google.json
//     (gitignored) and /api/config reports only the boolean "connected".

import crypto from "node:crypto";
import { zonedTimeToEpoch } from "./ics.js";

const OAUTH_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const OAUTH_TOKEN = "https://oauth2.googleapis.com/token";
const OAUTH_REVOKE = "https://oauth2.googleapis.com/revoke";
const API_BASE = "https://www.googleapis.com/calendar/v3";

// Events only: create/read/update/delete on the user's own events. Asking for
// the broader `calendar` scope would also grant calendar creation and sharing.
export const GOOGLE_SCOPE = "https://www.googleapis.com/auth/calendar.events";

const TIMEOUT_MS = 10_000;
// Refresh a little before the hour is up; a token that expires mid-flight
// turns one voice request into a confusing 401.
const EXPIRY_SKEW_MS = 60_000;

export const MAX_SUMMARY = 200;
export const MAX_TEXT = 500;

// A local datetime with no zone, exactly like set_reminder's contract. The
// model resolves "tomorrow at 3" itself; this is the shape it must land on.
const LOCAL_DT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 24 * 60 * 60 * 1000;

export class GoogleCalendarError extends Error {
  constructor(message, { status = 0, needsReconnect = false } = {}) {
    super(message);
    this.name = "GoogleCalendarError";
    this.status = status;
    this.needsReconnect = needsReconnect;
  }
}

// ---------------------------------------------------------------- time ----

// Is `tz` something Intl will accept? Anything else must not reach Google —
// an invalid zone there fails the whole request with a 400.
export function isValidTimeZone(tz) {
  if (typeof tz !== "string" || !tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function offsetSuffix(ms) {
  const sign = ms >= 0 ? "+" : "-";
  const mins = Math.round(Math.abs(ms) / 60000);
  return `${sign}${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
}

// "2026-08-05T15:00" + "America/Los_Angeles" → "2026-08-05T15:00:00-07:00".
//
// Google accepts a naive dateTime alongside a timeZone, but an explicit offset
// removes the ambiguity entirely — and the offset comes from the same
// DST-correct helper the ICS reader already unit-tests, so both halves of the
// feature agree about what a wall-clock time means.
export function localToRfc3339(local, tz) {
  const m = LOCAL_DT_RE.exec(local || "");
  if (!m) return null;
  const [, y, mo, d, h, mi, s = "00"] = m;
  const wall = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  const epoch = zonedTimeToEpoch(+y, +mo, +d, +h, +mi, +s, tz);
  if (!Number.isFinite(epoch)) return null;
  return `${y}-${mo}-${d}T${h}:${mi}:${s}${offsetSuffix(wall - epoch)}`;
}

// The inverse of localToRfc3339: an absolute instant back to wall-clock in
// `tz`. Used when patching an event, where the half the user didn't mention
// has to be re-sent as a local time.
export function isoToLocal(iso, tz, { dateOnly = false } = {}) {
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts) || !isValidTimeZone(tz)) return null;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(new Date(ts)).map(p => [p.type, p.value])
  );
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  // Intl reports midnight as hour "24" in some ICU versions.
  const hour = parts.hour === "24" ? "00" : parts.hour;
  return dateOnly ? date : `${date}T${hour}:${parts.minute}`;
}

export function addMinutes(local, minutes) {
  const m = LOCAL_DT_RE.exec(local || "");
  if (!m) return null;
  const [, y, mo, d, h, mi, s = "00"] = m;
  const t = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi + minutes, +s));
  const p = (n) => String(n).padStart(2, "0");
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}` +
    `T${p(t.getUTCHours())}:${p(t.getUTCMinutes())}`;
}

function addDays(date, n) {
  const m = DATE_RE.exec(date || "");
  if (!m) return null;
  const t = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + n));
  const p = (x) => String(x).padStart(2, "0");
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}`;
}

// --------------------------------------------------------------- drafts ----

const clean = (v, max) =>
  typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "";

// Turn the tool's arguments into a Google Events resource, or explain why not.
// Returns { event } or { error }.
//
// Validation lives here rather than in the browser for the same reason the
// archive's does: the client is untrusted input even when it's ours, and this
// one writes to a real calendar.
export function buildEventResource(draft = {}, { timeZone, defaultDurationMinutes = 60 } = {}) {
  const summary = clean(draft.summary, MAX_SUMMARY);
  if (!summary) return { error: "An event needs a title." };
  if (!isValidTimeZone(timeZone)) return { error: "Unknown time zone." };

  const location = clean(draft.location, MAX_TEXT);
  const description = clean(draft.description, MAX_TEXT);
  const base = {
    summary,
    ...(location ? { location } : {}),
    ...(description ? { description } : {}),
  };

  if (draft.all_day) {
    const start = clean(draft.start, 32);
    if (!DATE_RE.test(start)) return { error: "For an all-day event, start must be a date like 2026-08-05." };
    // Google's all-day end date is exclusive; a one-day event ends the
    // following day. The tool's contract is the inclusive last day, which is
    // what a person means by "the 5th through the 7th".
    const lastDay = DATE_RE.test(clean(draft.end, 32)) ? clean(draft.end, 32) : start;
    if (lastDay < start) return { error: "The event ends before it starts." };
    return { event: { ...base, start: { date: start }, end: { date: addDays(lastDay, 1) } } };
  }

  const start = clean(draft.start, 32);
  if (!LOCAL_DT_RE.test(start)) {
    return { error: "start must be a local datetime like 2026-08-05T15:00." };
  }
  let end = clean(draft.end, 32);
  if (end && !LOCAL_DT_RE.test(end)) {
    return { error: "end must be a local datetime like 2026-08-05T16:00." };
  }
  if (!end) {
    const mins = Number.isFinite(draft.duration_minutes)
      ? Math.min(24 * 60, Math.max(1, Math.round(draft.duration_minutes)))
      : defaultDurationMinutes;
    end = addMinutes(start, mins);
  }
  const startIso = localToRfc3339(start, timeZone);
  const endIso = localToRfc3339(end, timeZone);
  if (!startIso || !endIso) return { error: "Could not read those times." };
  if (new Date(endIso).getTime() <= new Date(startIso).getTime()) {
    return { error: "The event ends before it starts." };
  }
  return {
    event: {
      ...base,
      start: { dateTime: startIso, timeZone },
      end: { dateTime: endIso, timeZone },
    },
  };
}

// Google Events resource → the small shape the rest of Nova speaks.
export function fromGoogleEvent(item) {
  if (!item || item.status === "cancelled") return null;
  const allDay = Boolean(item.start?.date);
  const startRaw = item.start?.dateTime || item.start?.date;
  if (!startRaw) return null;
  const start = allDay ? new Date(`${item.start.date}T00:00:00`) : new Date(startRaw);
  if (!Number.isFinite(start.getTime())) return null;
  // Undo the exclusive end date so "all day Wednesday" doesn't read as ending
  // on Thursday.
  const endRaw = item.end?.dateTime || item.end?.date;
  const end = allDay
    ? new Date((endRaw ? new Date(`${endRaw}T00:00:00`).getTime() : start.getTime() + DAY_MS) - 1)
    : endRaw ? new Date(endRaw) : new Date(start.getTime());
  return {
    id: String(item.id || ""),
    summary: clean(item.summary, MAX_SUMMARY) || "(untitled)",
    start_iso: start.toISOString(),
    end_iso: (Number.isFinite(end.getTime()) ? end : start).toISOString(),
    all_day: allDay,
    ...(item.location ? { location: clean(item.location, MAX_TEXT) } : {}),
    ...(item.htmlLink ? { html_link: String(item.htmlLink) } : {}),
    source: "google",
  };
}

// ----------------------------------------------------------------- client ----

async function postForm(url, params, fetchImpl) {
  const resp = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await resp.json().catch(() => ({}));
  return { resp, body };
}

// createGoogleCalendar({ clientId, clientSecret, calendarId, store })
//
// `store` is a lib/store.js store whose defaults include `google: {}`; the
// refresh token is the only thing persisted. Everything else — access token,
// its expiry — is in-memory and re-derived after a restart.
export function createGoogleCalendar({
  clientId = "",
  clientSecret = "",
  calendarId = "primary",
  store = null,
  // Resolved per call rather than captured, so a test can swap globalThis.fetch
  // after the server is already built.
  fetchImpl = (...args) => fetch(...args),
} = {}) {
  const configured = Boolean(clientId && clientSecret && store);
  let access = null;        // { token, expiresAt }
  let refreshing = null;    // in-flight refresh, shared by concurrent callers
  let pendingState = null;  // { value, at } — one-shot CSRF token for the flow

  const saved = () => (store?.get()?.google) || {};
  const connected = () => Boolean(configured && saved().refresh_token);

  function requireConfigured() {
    if (!configured) {
      throw new GoogleCalendarError(
        "Google Calendar isn't configured on this server.", { status: 501 }
      );
    }
  }

  // One-shot state parameter. Generated at /api/google/auth, required and
  // consumed at the callback — without it the callback would accept a code
  // from any page that could get the browser to visit it.
  function beginAuth(redirectUri) {
    requireConfigured();
    pendingState = { value: crypto.randomBytes(16).toString("hex"), at: Date.now() };
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: GOOGLE_SCOPE,
      access_type: "offline",   // we need a refresh token
      prompt: "consent",        // ...and Google only re-issues one when asked
      include_granted_scopes: "true",
      state: pendingState.value,
    });
    return `${OAUTH_AUTH}?${params}`;
  }

  function checkState(value) {
    const expected = pendingState;
    pendingState = null; // single use, success or failure
    if (!expected || !value) return false;
    if (Date.now() - expected.at > 10 * 60 * 1000) return false;
    const a = Buffer.from(String(value));
    const b = Buffer.from(expected.value);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  async function connect(code, redirectUri) {
    requireConfigured();
    const { resp, body } = await postForm(OAUTH_TOKEN, {
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }, fetchImpl);
    if (!resp.ok || !body.access_token) {
      throw new GoogleCalendarError(
        body.error_description || body.error || `Google returned HTTP ${resp.status}`,
        { status: 502 }
      );
    }
    if (!body.refresh_token) {
      // Happens when the account was already authorized and Google saw no
      // reason to mint another one. Without it we cannot survive a restart.
      throw new GoogleCalendarError(
        "Google didn't return a refresh token. Remove Nova at " +
        "myaccount.google.com/permissions and connect again.",
        { status: 502 }
      );
    }
    access = { token: body.access_token, expiresAt: Date.now() + (body.expires_in || 3600) * 1000 };
    await store.update(cur => ({
      ...cur,
      google: {
        refresh_token: body.refresh_token,
        scope: String(body.scope || GOOGLE_SCOPE),
        connected_at: new Date().toISOString(),
      },
    }));
    return { ok: true };
  }

  async function disconnect() {
    const token = saved().refresh_token;
    access = null;
    if (store) await store.update(cur => ({ ...cur, google: {} }));
    if (token) {
      // Best-effort: local state is already gone, so a revoke failure must not
      // leave the household unable to reconnect.
      try { await postForm(OAUTH_REVOKE, { token }, fetchImpl); } catch {}
    }
    return { ok: true };
  }

  async function accessToken() {
    requireConfigured();
    if (access && Date.now() < access.expiresAt - EXPIRY_SKEW_MS) return access.token;
    if (refreshing) return refreshing;
    const refreshToken = saved().refresh_token;
    if (!refreshToken) {
      throw new GoogleCalendarError("Google Calendar isn't connected yet.", {
        status: 401, needsReconnect: true,
      });
    }
    refreshing = (async () => {
      const { resp, body } = await postForm(OAUTH_TOKEN, {
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "refresh_token",
      }, fetchImpl);
      if (!resp.ok || !body.access_token) {
        // invalid_grant means revoked or expired: the stored token is dead
        // weight and keeping it would retry forever. Drop it and say so.
        const dead = body.error === "invalid_grant";
        if (dead && store) await store.update(cur => ({ ...cur, google: {} }));
        throw new GoogleCalendarError(
          dead
            ? "Nova's access to Google Calendar was revoked — reconnect it."
            : body.error_description || body.error || `Google returned HTTP ${resp.status}`,
          { status: dead ? 401 : 502, needsReconnect: dead }
        );
      }
      access = { token: body.access_token, expiresAt: Date.now() + (body.expires_in || 3600) * 1000 };
      return access.token;
    })().finally(() => { refreshing = null; });
    return refreshing;
  }

  async function api(pathname, { method = "GET", body, query } = {}) {
    const token = await accessToken();
    const url = new URL(API_BASE + pathname);
    for (const [k, v] of Object.entries(query || {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    const resp = await fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (resp.status === 204) return {};
    const payload = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const message = payload?.error?.message || `Google returned HTTP ${resp.status}`;
      throw new GoogleCalendarError(message, {
        status: resp.status === 404 ? 404 : 502,
        needsReconnect: resp.status === 401,
      });
    }
    return payload;
  }

  const cal = () => encodeURIComponent(calendarId);

  return {
    get configured() { return configured; },
    connected,
    calendarId,
    beginAuth,
    checkState,
    connect,
    disconnect,

    // singleEvents=true makes Google expand recurrence for us — the one place
    // where the API beats lib/ics.js outright, which only handles DAILY and
    // WEEKLY and gives up on EXDATE.
    async listEvents({ timeMin, timeMax, maxResults = 15 } = {}) {
      const body = await api(`/calendars/${cal()}/events`, {
        query: {
          timeMin: new Date(timeMin).toISOString(),
          timeMax: new Date(timeMax).toISOString(),
          singleEvents: "true",
          orderBy: "startTime",
          maxResults: Math.min(50, Math.max(1, maxResults)),
        },
      });
      return (body.items || []).map(fromGoogleEvent).filter(Boolean);
    },

    async createEvent(resource) {
      return fromGoogleEvent(await api(`/calendars/${cal()}/events`, {
        method: "POST", body: resource,
      }));
    },

    async getEvent(id) {
      return fromGoogleEvent(await api(`/calendars/${cal()}/events/${encodeURIComponent(id)}`));
    },

    // PATCH, not PUT: a partial update leaves fields the user didn't mention
    // (guests, conferencing, reminders) exactly as they were.
    async updateEvent(id, resource) {
      return fromGoogleEvent(await api(`/calendars/${cal()}/events/${encodeURIComponent(id)}`, {
        method: "PATCH", body: resource,
      }));
    },

    async deleteEvent(id) {
      await api(`/calendars/${cal()}/events/${encodeURIComponent(id)}`, { method: "DELETE" });
      return { ok: true };
    },
  };
}
