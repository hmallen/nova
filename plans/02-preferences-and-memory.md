# Plan 2 — Preferences & memory

## Goal

Nova remembers who it's talking to: name, home city, temperature units, and
preferred voice — set by voice ("Nova, remember that I live in Portland",
"call me Sam", "use Celsius"), persisted in `localStorage`, injected into the
model's context at session start, and honored by the weather skill and the
server-minted voice.

## Design

### 1. Data model

```js
// in state (app.js:32), loaded like lists/devices:
prefs: JSON.parse(localStorage.getItem("nova.prefs") || "null") || {
  name: null,          // "Sam"
  homeCity: null,      // "Portland"
  homeLat: null, homeLon: null, homeLabel: null,  // resolved+cached geocode
  units: "fahrenheit", // "fahrenheit" | "celsius"
  voice: null,         // null = server default
},
```

`homeLat/Lon/Label` are cached at *set* time by running the same Open-Meteo
geocoding call `get_weather` already uses, so later weather lookups skip a
network round-trip and "weather" works with geolocation denied.

### 2. New tool: `manage_preferences`

```js
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
}
```

Handler:

- `set`: apply only the provided fields. For `home_city`, geocode immediately;
  on geocode failure return `{ error: "I couldn't find <city>…" }` and don't
  save. Persist, then return the full prefs object so the model can confirm.
- `get`: return prefs (model uses this for "what do you know about me?").
- `clear`: reset to defaults ("forget everything about me").
- A voice change **cannot take effect mid-session** (voice is fixed once the
  model has spoken in a Realtime session) — save it and return
  `{ ok: true, voice, note: "takes effect next session" }` so Nova says so.

### 3. Injecting prefs into the session

The session config is built server-side (`sessionConfig()` in server.js:71),
but prefs live in the browser. Change `POST /api/session` to accept a small
JSON body:

```js
// client (startSession, app.js:345):
fetch("/api/session", { method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ prefs: {
    name: state.prefs.name, homeLabel: state.prefs.homeLabel,
    units: state.prefs.units, voice: state.prefs.voice } }) })
```

Server (`server.js`):

- Read and JSON-parse the request body (add a tiny `readBody(req)` helper —
  also needed by Plan 3, write it once here in `server.js`).
- **Validate hard**: `voice` against `ALLOWED_VOICES = ["marin","cedar","alloy"]`;
  `units` against the two values; `name`/`homeLabel` truncated to 60 chars and
  stripped of newlines (they get spliced into the prompt — treat as untrusted).
- `sessionConfig(prefs)` appends an "About the user" block to INSTRUCTIONS:

  ```
  About this user (from saved preferences):
  - Name: Sam — address them by name occasionally, not every turn.
  - Home: Portland, Oregon, US — assume this for weather/time-of-day context.
  - Units: celsius.
  ```

  and sets `audio.output.voice = prefs.voice || VOICE`.

### 4. Skills honor prefs

- **`get_weather`** (app.js:220): when no `location` arg —
  1. use cached `homeLat/homeLon` if set (name = `homeLabel`),
  2. else fall back to geolocation as today,
  3. else the existing error.
  Request `&temperature_unit=${state.prefs.units}` and adjust the summary
  field names (`temperature_f` → `temperature` plus a `units` field) so the
  model reads the right unit. Update `renderWeather` to print `°F`/`°C`
  accordingly.
- **`set_volume` / others**: no change.

### 5. Instructions (base INSTRUCTIONS in server.js)

Add:

> If the user tells you something to remember about themselves (name, city,
> units, voice), call manage_preferences to save it — don't just acknowledge.

## Files touched

| File | Change |
|------|--------|
| `public/app.js` | prefs state, `manage_preferences` tool+handler, weather changes, session body (~+120 lines) |
| `server.js` | `readBody` helper, prefs validation, `sessionConfig(prefs)`, allowlist (~+50 lines) |
| `README.md` | "Try:" lines ("Remember that I live in…", "Call me…", "Use celsius") |
| `.env.example` | comment noting REALTIME_VOICE is only the default; users can override by voice |

## Edge cases & decisions

- **Prompt injection via prefs**: name/city text goes into the system prompt.
  The truncation + newline-strip in §3 plus phrasing them inside a clearly
  labeled block is sufficient for a self-hosted app; note it in a comment.
- **Multiple people in a household** share one browser profile: out of scope
  (single prefs object). Mention in README limits section.
- Prefs set mid-session affect the *current* session only via tool results
  (the model has seen them); the system-prompt injection catches the *next*
  session. That's fine — the model was told in the same conversation.
- `manage_preferences` with `action:"set"` and no fields: return the current
  prefs with `{ note: "nothing changed" }` rather than an error.

## Verification

1. "Remember that I live in Portland and use Celsius" → prefs saved (check
   localStorage), Nova confirms both.
2. "What's the weather?" with location permission **blocked** → Portland
   weather in °C, card shows °C.
3. "Call me Sam", reconnect → greeting uses the name; server log or a temp
   `console.log` shows the About-this-user block was sent.
4. "Change your voice to cedar" → Nova says it'll change next time; reconnect
   → new voice audibly different.
5. "Forget everything about me" → prefs reset, next session greeting generic.
