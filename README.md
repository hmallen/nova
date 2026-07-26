# Nova — an Alexa-style voice assistant on the OpenAI Realtime API

A hands-free household voice assistant in the spirit of Amazon Alexa, built
entirely on OpenAI's latest-generation voice stack. Speak naturally, interrupt
it mid-sentence, and ask it to start stopwatches, set timers, check the weather, manage lists,
control (simulated) smart-home devices, play ambient sounds, or just chat.

## Quick start

```bash
# 1. Configure your API key
copy .env.example .env      # then edit .env and paste your OPENAI_API_KEY

# 2. Run (no npm install needed — zero dependencies, Node 18+)
npm start

# 3. Open http://localhost:3000, tap the ring, allow the microphone, and talk.
```

Try:

- "What time is it?" / "What's the date?"
- "Start a stopwatch" · "Stop the stopwatch"
- "Set a pasta timer for 8 minutes" · "Cancel the pasta timer"
- "Set an alarm for 7:30 tomorrow morning"
- "Wake me at 7 on weekdays" — repeating alarms survive page refreshes
- "Remind me to take the chicken out at 5" · "Remind me to stretch in 20 minutes"
- "Snooze" — right after a timer, alarm, or reminder rings
- "What's the weather in Seattle?" (or just "What's the weather?" with location permission)
- "Add milk and eggs to my shopping list" · "What's on my shopping list?"
- "Turn on the living room light" · "Turn off all the lights" · "Set the thermostat to 72"
- "Play rain sounds" / "Play ocean sounds" · "Play some jazz" (internet radio) · "Stop"
- "What's on my calendar today?" (with `ICS_URL` configured)
- "Turn the volume down"
- "Good morning" — runs a routine: weather, today's schedule, and a short
  news briefing as one flowing update ("Good night" ends with rain sounds)
- "What's in the news?" · "Any news about space?" — keyless RSS headlines
- "What does my day look like?" — running stopwatches and timers, today's alarms, reminders due today
- "Add the news to my good night routine" · "What are my routines?"
- "Remember that I live in Portland" · "Call me Sam" · "Use celsius" —
  preferences persist and are honored next session ("What do you know about me?")
- "Change your voice to cedar" — takes effect on the next session
- "Tell me a joke" · "How many ounces in a cup?" — answered directly by the model

Optionally click **Enable wake word** to say "Nova" hands-free to start a
session (uses the browser's on-device speech recognition purely as a trigger;
everything after the wake word is OpenAI).

You can also **type to Nova** — the box under the transcript answers in kind:
type a question, read the answer. Typing never opens the microphone. Submitting
while idle starts a **text session** (no mic permission, no recording
indicator, no spoken replies) and answers your question in place of the
greeting; the ring glows dim to show Nova is connected but not listening. Tap
the ring to switch to talking out loud — that starts a fresh voice session, so
Nova won't remember the typed exchange, the same as after a reconnect.

Typing *during* a voice session works too: the answer comes back written
instead of spoken, and it interrupts Nova if she's mid-sentence. Tools behave
identically either way — "set a pasta timer for 9 minutes" works typed or
spoken.

## Architecture

```
Browser ──(mic audio via WebRTC)──────────► OpenAI Realtime API
        ◄─(assistant speech via WebRTC)──   model: gpt-realtime-2.1
        ◄─(JSON events on data channel)─►
        │
        └──POST /api/session──► Node server ──POST /v1/realtime/client_secrets──► OpenAI
                                (holds the real API key; mints ephemeral ek_ tokens)
```

- **`server.js`** — zero-dependency Node server. Serves the static client and
  exposes `POST /api/session`, which calls
  `POST https://api.openai.com/v1/realtime/client_secrets` with the session
  config (model, voice, Alexa-style persona instructions) and returns the
  short-lived `ek_...` client secret. The real API key never reaches the browser.
- **`public/app.js`** — the assistant. Opens an `RTCPeerConnection`, sends the
  SDP offer to `https://api.openai.com/v1/realtime/calls`, exchanges JSON
  events over the `oai-events` data channel, registers tools via
  `session.update`, executes function calls locally, and returns results as
  `function_call_output` items followed by `response.create`.
- **Skills (tools)** — `get_current_datetime`, `start_stopwatch`, `set_timer`, `set_alarm`
  (one-time or repeating on chosen weekdays), `set_reminder`, `snooze`,
  `cancel_timer_or_alarm`, `get_weather` (Open-Meteo, no key needed),
  `manage_list`, `control_device` (simulated smart home), `play_ambient_sound`
  (rain / white noise / ocean, synthesized with Web Audio), `stop_ambient_sound`,
  `set_volume`, `manage_preferences`. Device states, preferences, and
  stopwatches/timers/alarms/reminders persist in `localStorage`.
- **Routines** — saved skill sequences in `localStorage` (seeded with
  "good morning" and "good night"), editable by voice via `manage_routine`.
  `run_routine` executes the steps locally and returns one composite result,
  so the whole morning update costs a single model round-trip. Only
  non-interactive skills are allowed as steps. News comes from a server-side
  RSS proxy (`GET /api/news`, Google News by default, 10-minute cache).
- **Lists are shared across devices** — stored server-side in `data/state.json`
  behind `GET/PUT /api/lists` and polled every 4 s by visible clients, so the
  item a phone adds shows up on the kitchen tablet within seconds. Edits made
  while the server is unreachable are kept locally (an "offline" badge shows on
  the Lists card) and resynced automatically.
- **Timers, alarms & reminders** ring with a synthesized chime *and* inject a
  conversation item so Nova announces them by voice, like Alexa does —
  reminders as "This is your reminder to …". They survive page refreshes;
  reminders that come due while the page is closed show as "missed" and are
  announced once at the start of the next session.
- **Stopwatches** count upward in the same timekeeping card and survive page
  refreshes until stopped.

## Real integrations (all optional, env-gated)

Nova runs fully simulated out of the box; each of these graduates a
capability into a real one when its env vars are set. Secrets stay in `.env`
and are only used inside `server.js` proxy endpoints — the browser never sees
them. The client asks `GET /api/config` at boot which integrations are live
and only registers the matching tools.

### Home Assistant

Set `HA_URL` and `HA_TOKEN` (a long-lived access token from your HA profile
page). `control_device` then drives real `light` / `switch` / `fan` /
`climate` entities by friendly name ("turn on the office light", "set the
thermostat to 21"). The Smart Home card starts empty; use **Add entity** to
pin only the states you want visible. Those choices stay in this browser and
their states refresh every 30 s. Pinning only affects the dashboard — Nova
can still control every available entity by voice. The server proxy validates
every call hard — domains, services, entity ids, and data are allowlisted, so
the browser can never use the full-admin token as a generic passthrough.
Light brightness is out of scope for now: Nova says she can only switch
lights on and off. Without the env vars, devices stay simulated exactly as
before and can be pinned the same way.

### Calendar (read-only ICS)

Set `ICS_URL` to a private iCal feed URL (Google: calendar settings → "Secret
address in iCal format"; Outlook: "Publish calendar" ICS link; iCloud: public
calendar link). "What's on my calendar today?" reads upcoming events with a
hand-rolled RFC 5545 parser supporting TZID zones, all-day events, and
daily/weekly RRULEs (weekly meetings — the 90% case). Other recurrence forms
are skipped and Nova mentions some repeating events couldn't be read. The
feed is cached for 15 minutes. When configured, the "good morning" routine
gains a calendar step automatically.

### Internet radio

"Play some jazz" streams internet radio (defaults: a few
[SomaFM](https://somafm.com) channels — listener-supported, commercial-free;
please support them if you listen a lot). Nova's replies duck the music to
25% volume while she speaks, like a real smart speaker. Override or extend
the streams with the `RADIO_STREAMS` env var; names appear in the tool enum,
URLs stay server-side behind a `302` redirect at `/api/radio/<name>`.
"Play rain sounds" still uses the Web Audio synthesizer.

## Use it on a tablet or phone

Nova is a PWA: it installs to a home screen and launches full-screen like a
real assistant appliance. The one real blocker for a second device is that
**microphone access requires HTTPS** (only `localhost` is exempt), so:

1. Install [mkcert](https://github.com/FiloSottile/mkcert) on the machine
   running the server, then:

   ```bash
   mkcert -install
   mkdir certs
   cd certs && mkcert <your-lan-ip> localhost
   ```

2. Point `.env` at the two generated files (`HTTPS_CERT=./certs/<...>.pem`,
   `HTTPS_KEY=./certs/<...>-key.pem`) and restart — the server now prints its
   LAN `https://` URLs at boot. Both variables are required together. If a
   path is missing, unreadable, or not valid PEM, Nova exits with a focused
   setup error that tells you whether to regenerate/fix the files or remove
   both settings to run locally over HTTP.
3. Install the mkcert root CA on the tablet/phone (mkcert's documented mobile
   flow: `mkcert -CAROOT`, copy `rootCA.pem` over, trust it in settings).
   A plain self-signed cert without a trusted CA fails silently for service
   workers — don't bother.
4. Open `https://<lan-ip>:3000` on the device, allow the mic, and use
   **Add to Home Screen** for the full-screen app.

`.env` and the entire `certs/` directory are ignored by Git. Keep generated
certificates—especially private keys—machine-local; never force-add them.

Loading over plain `http://` from a second device shows "Needs HTTPS for the
microphone" instead of a dead mic prompt. The service worker only pre-caches
the static shell (network-first, so development always serves fresh files
while the server is up); if it ever gets in your way, unregister it via
DevTools → Application → Service workers.

## Testing

```bash
npm test        # node:test — zero dev dependencies, Node 18+
```

Unit tests cover the extracted server modules (`lib/env.js`, `lib/store.js`,
`lib/rss.js`, `lib/ics.js`, `lib/prefs.js`) and the shared browser helpers in
`public/lib/helpers.js`; an HTTP smoke test boots the real server
(`createNovaServer({ env, dataDir })`) on an ephemeral port with a temp data
dir and exercises static serving, path-traversal rejection, the lists
PUT/GET/409 cycle, and the Home Assistant call validation. CI
(`.github/workflows/ci.yml`) runs the suite on Node 18/20/22 × Ubuntu/Windows.

## Docker

```bash
docker build -t nova .
docker run -d -p 3000:3000 --env-file .env -v nova-data:/app/data nova
# or: docker compose up -d
```

No install or build stage — the image is copy-and-run. The named volume
persists `data/state.json` (shared lists) across restarts. If you bind-mount
a host directory instead of a named volume, make sure it's writable by the
container's `node` user (uid 1000) — bind mounts don't inherit the image's
ownership. For HTTPS in Docker, either mount your certs directory and set
`HTTPS_CERT`/`HTTPS_KEY`, or (recommended) terminate TLS at your reverse
proxy (Caddy/Traefik) in front of the container.

## Research notes: OpenAI voice APIs, July 2026

Findings from researching the current generation before building:

- **Latest models** — `gpt-realtime-2.1` and `gpt-realtime-2.1-mini` (released
  July 6, 2026) are the current speech-to-speech generation, cutting p95 voice
  latency ≥25% vs. the prior generation, with better alphanumeric read-back,
  noise handling, and interruption behavior. `gpt-realtime-2` (May 2026) added
  a 128K context window and companion models `gpt-realtime-translate` and
  `gpt-realtime-whisper` (used here for input transcription).
- **Speech-to-speech beats STT→LLM→TTS pipelines** for assistants: one model
  hears audio and speaks audio directly, preserving tone and enabling natural
  barge-in interruption with far lower latency.
- **WebRTC for browsers, WebSocket for servers, SIP for telephony.** WebRTC
  handles echo cancellation, jitter, and audio capture/playback natively —
  the recommended browser transport.
- **Ephemeral client secrets** — browsers must never hold the real API key.
  A backend mints a short-lived token via `POST /v1/realtime/client_secrets`;
  the browser uses the `ek_` value only for the SDP handshake.
- **Semantic VAD** (`turn_detection: { type: "semantic_vad" }`) ends turns
  based on *what* is said rather than silence length — current best practice
  for assistant UX.
- **Tools in realtime sessions** work like Chat Completions function calling:
  define tools in the session, receive `response.function_call_arguments.done`,
  reply with a `function_call_output` conversation item plus `response.create`.
- **No session resume exists** — if the connection drops the session is gone.
  The client auto-reconnects (two attempts with backoff, skipped for
  intentional stops and hidden tabs) by starting a *new* session; Nova says
  "Sorry, I lost you for a second" instead of re-greeting, but conversation
  history does not survive a reconnect.

Sources:
- [Realtime guide](https://developers.openai.com/api/docs/guides/realtime) ·
  [WebRTC guide](https://developers.openai.com/api/docs/guides/realtime-webrtc) ·
  [gpt-realtime announcement](https://openai.com/index/introducing-gpt-realtime/) ·
  [gpt-realtime-2.1 release](https://community.openai.com/t/new-realtime-models-on-the-api-gpt-realtime-2-1-and-gpt-realtime-2-1-mini/1385896) ·
  [2026 voice agent guide](https://www.open.cx/blog/openai-realtime-api-voice-agent-guide-2026)

## Notes & limits

- Weather uses the free, keyless [Open-Meteo](https://open-meteo.com) API;
  everything AI is OpenAI.
- Smart-home devices are simulated by default — set `HA_URL`/`HA_TOKEN` to
  drive real Home Assistant devices (see "Real integrations").
- The wake word runs on-device via the Web Speech API (Chrome/Edge) and only
  *starts* a session; keeping a Realtime session always-on just to detect a
  wake word would stream audio (and billing) continuously.
- List sync has no auth — anyone on your LAN can read or edit lists (the same
  trust level as a smart speaker on your network). Timers, alarms, and
  reminders stay per-device on purpose: a timer set on the kitchen tablet
  should ring on the kitchen tablet, and cross-device ringing would need push.
- Preferences (name, home city, units, voice) are a single per-browser profile —
  multiple people sharing one browser share one set of preferences.
- Realtime audio is billed per audio token; use `REALTIME_MODEL=gpt-realtime-2.1-mini`
  in `.env` for cheaper experimentation.
