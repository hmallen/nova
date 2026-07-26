# Plan 7 — Real integrations: Home Assistant, calendar, internet radio

## Goal

Graduate three simulated/absent capabilities into real ones, all optional and
env-gated, all keeping secrets server-side:

- A. `control_device` drives **Home Assistant** when configured (falls back
  to today's simulation when not).
- B. New `get_calendar` skill reads a private **ICS feed** ("what's on my
  calendar today?").
- C. `play_ambient_sound` gains **internet radio** streams ("play some
  jazz") alongside the synthesized sounds.

Each part is independent — they can ship as three PRs. They share one new
piece of plumbing, so build that first.

## Shared plumbing: `GET /api/config`

The client needs to know which integrations are live to register the right
tool descriptions (the model should only be told about devices/calendar/radio
that actually exist). New endpoint returning non-secret config:

```js
// server.js
GET /api/config → {
  homeAssistant: Boolean(HA_URL && HA_TOKEN),
  calendar: Boolean(ICS_URL),
  radio: [ { name: "jazz" }, { name: "lofi" }, ... ],  // names only
}
```

Client fetches it at boot **before** any session starts; `TOOLS` becomes a
function `buildTools(config)` evaluated once, and `onDataChannelOpen` sends
the built list. (Small refactor of app.js:50's const.)

## Part A — Home Assistant bridge

### .env

```
# HA_URL=http://homeassistant.local:8123
# HA_TOKEN=<long-lived access token from your HA profile page>
```

### Server proxy (`server.js`, ~+70 lines)

Never expose the token; the browser talks only to these:

- `GET /api/ha/states` → proxies `GET {HA_URL}/api/states`, filtered to
  domains `light`, `switch`, `fan`, `climate`, mapped to
  `[{ entity_id, name: attributes.friendly_name, domain, state,
  temp?: attributes.temperature }]`. 8 s timeout; upstream failure → 502.
- `POST /api/ha/call` body `{ domain, service, entity_id, data? }` →
  proxies `POST {HA_URL}/api/services/{domain}/{service}`.
  **Validate hard**: `domain` ∈ {light, switch, fan, climate}, `service` ∈
  {turn_on, turn_off, set_temperature}, `entity_id` matches
  `^(light|switch|fan|climate)\.[a-z0-9_]+$`, `data` allowlisted to
  `{ temperature: number }`. This proxy is the security boundary — HA tokens
  are full-admin, so the endpoint must not be a generic passthrough.

### Client (`public/app.js`)

- When `config.homeAssistant`:
  - Boot + every 30 s (visible only): fetch `/api/ha/states` into
    `state.devices` keyed by stable entity id:
    `{ name, entity_id, domain, on, value? }`.
  - The Smart Home card renders only entity ids explicitly pinned in the
    browser. The pin list starts empty, persists in localStorage, and does not
    limit which devices remain available to `control_device`.
  - `control_device` handler: same name-matching logic as today
    (substring both ways, "all lights" → all `light.` domain entities), then
    `POST /api/ha/call` per target:
    - on/off → `{ domain, service: "turn_on"|"turn_off", entity_id }`
      (climate "off" → `turn_off`; "on" → `turn_on`).
    - set + climate → `set_temperature` with `{ temperature: value }`.
    - set + light → v1: treat as brightness is **out of scope**; return
      `{ error: "I can only turn lights on and off for now." }` (honest
      beats wrong).
  - After calls, refetch states once (HA is authoritative; don't trust
    optimistic state) then `renderDevices()`.
  - Tool description becomes dynamic: `"Devices: " + names.join(", ")` so
    the model knows the real device names.
- When not configured: today's simulated path, unchanged.

## Part B — Calendar (read-only ICS)

### .env

```
# ICS_URL=https://calendar.google.com/calendar/ical/.../basic.ics
```

(Google/Outlook/iCloud all offer a "secret address in iCal format" — README
gets a how-to-find-it note per provider.)

### `lib/ics.js` (new, testable, ~100 lines)

`parseIcs(text)` → array of `{ summary, start: Date, end: Date, allDay }`:

- Unfold continuation lines (RFC 5545: CRLF + space/tab).
- Per VEVENT read `SUMMARY`, `DTSTART`, `DTEND` handling three date shapes:
  `YYYYMMDD` (all-day), `YYYYMMDDTHHMMSSZ` (UTC), and
  `DTSTART;TZID=...:YYYYMMDDTHHMMSS` — for TZID, format via
  `Intl.DateTimeFormat` with that IANA zone to convert to an epoch
  (implementation detail: compute via the timeZoneName offset trick; isolate
  in a helper `zonedTimeToEpoch(y,m,d,h,min,s,tz)` — this is the one genuinely
  fiddly function, unit-test it hard).
- **RRULE**: support `FREQ=DAILY|WEEKLY` (with `BYDAY`, `INTERVAL`, `UNTIL`,
  `COUNT`) expanded only within the query window; skip other FREQs and
  events with EXDATE (return them un-expanded with a `recurringUnsupported`
  flag so the server can drop them). Weekly-meeting coverage is the 90% case;
  say so in a comment.

### Server: `GET /api/calendar?days=1`

- Fetch ICS_URL (cache 15 min), parse, expand, filter to `[now-1h,
  now + days*24h]`, sort, cap 15, return
  `{ events: [{ summary, start_iso, end_iso, all_day }] }`.

### Client tool `get_calendar`

```js
{ name: "get_calendar",
  description: "Get the user's calendar events for today or the next few days.",
  parameters: { properties: { days: { type: "number", description: "1=today (default), up to 7" } }, required: [] } }
```

Registered only when `config.calendar`. Handler formats times client-side
into spoken-friendly strings (`"3:00 PM"`) before returning — keep the model
away from ISO strings. Add to the Plan 4 routine allowlist + default
"good morning" routine when present.

## Part C — Internet radio

### Server config

`RADIO_STREAMS` env (JSON: `{"jazz":"https://...","lofi":"https://..."}`)
with a built-in default map pointing at a few genre streams that permit
hotlinking (e.g. SomaFM's public MP3 streams — verify current stream URLs
and their terms at implementation time; they've historically allowed direct
players with attribution). Names flow to the client via `/api/config`;
**URLs stay server-side** and are served through `GET /api/radio/<name>` as
a 302 redirect — keeps the client generic and lets users swap streams
without touching JS.

### Client

- New `<audio id="radioAudio">` element (separate from `assistantAudio`).
- Extend `play_ambient_sound`'s enum dynamically:
  `["rain","white noise","ocean", ...radioNames]`; description says which
  are radio. Handler: radio name → `radioAudio.src = "/api/radio/" + name;
  radioAudio.play()`; synthesized name → existing `startAmbient`.
  Starting either stops the other; `stop_ambient_sound` stops both.
- `set_volume` also scales `radioAudio.volume`.
- **Ducking**: while `assistantSpeaking` (already tracked, app.js:29), lower
  `radioAudio.volume` to 25%; restore on `output_audio_buffer.stopped`. The
  synthesized ambient gets the same treatment via `ambientGain` — a free
  polish win that makes talking over music feel right.

## Files touched

| File | Change |
|------|--------|
| `server.js` | /api/config, HA proxy, calendar endpoint, radio redirect, env parsing (~+170 lines) |
| `lib/ics.js` | new (~100 lines + tests in Plan 8) |
| `public/app.js` | buildTools(config), HA device path, get_calendar, radio + ducking (~+180 lines) |
| `public/index.html` | radio audio element |
| `.env.example` | HA_URL, HA_TOKEN, ICS_URL, RADIO_STREAMS |
| `README.md` | three setup guides; move devices out of "simulated" caveat when HA configured |

## Edge cases

- HA unreachable mid-session: `/api/ha/call` 502 → handler returns
  `{ error: "I couldn't reach the smart home hub." }` — model apologizes;
  simulated fallback is **not** silently substituted (lying about real
  devices is worse than failing).
- Duplicate friendly names in HA: match returns all matches; act on all
  (matches "all lights" semantics users expect).
- ICS with only unsupported RRULEs: events list may be empty → tool returns
  `{ events: [], note: "some repeating events couldn't be read" }` when the
  parser flagged any.
- Radio stream 404/geo-blocked: `radioAudio.onerror` → return happens before
  the error (play is async) — so wire onerror to inject a system-event
  conversation item ("the stream failed") the same way timers do.

## Verification

1. No env vars set → behavior identical to today (regression check:
   simulated devices, no calendar/radio tools registered — inspect the
   session.update payload in devtools).
2. With HA: "turn on the office light" flips the real light; HA app shows
   it; devices card mirrors real state within 30 s of an external change.
3. Invalid entity injection attempt: `curl POST /api/ha/call` with
   `domain: "shell_command"` → 400.
4. With ICS: "what's on my calendar today?" reads real events in spoken
   times; a weekly recurring meeting appears on the right weekday.
5. "Play some jazz" → stream plays; Nova's replies duck the music; "stop" →
   silence; "play rain sounds" still uses the synthesizer.
