# Nova — an Alexa-style voice assistant on the OpenAI Realtime API

A hands-free household voice assistant in the spirit of Amazon Alexa, built
entirely on OpenAI's latest-generation voice stack. Speak naturally, interrupt
it mid-sentence, and ask it to set timers, check the weather, manage lists,
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
- "Set a pasta timer for 8 minutes" · "Cancel the pasta timer"
- "Set an alarm for 7:30 tomorrow morning"
- "Wake me at 7 on weekdays" — repeating alarms survive page refreshes
- "Remind me to take the chicken out at 5" · "Remind me to stretch in 20 minutes"
- "Snooze" — right after a timer, alarm, or reminder rings
- "What's the weather in Seattle?" (or just "What's the weather?" with location permission)
- "Add milk and eggs to my shopping list" · "What's on my shopping list?"
- "Turn on the living room light" · "Turn off all the lights" · "Set the thermostat to 72"
- "Play rain sounds" / "Play ocean sounds" · "Stop"
- "Turn the volume down"
- "Remember that I live in Portland" · "Call me Sam" · "Use celsius" —
  preferences persist and are honored next session ("What do you know about me?")
- "Change your voice to cedar" — takes effect on the next session
- "Tell me a joke" · "How many ounces in a cup?" — answered directly by the model

Optionally click **Enable wake word** to say "Nova" hands-free to start a
session (uses the browser's on-device speech recognition purely as a trigger;
everything after the wake word is OpenAI).

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
- **Skills (tools)** — `get_current_datetime`, `set_timer`, `set_alarm`
  (one-time or repeating on chosen weekdays), `set_reminder`, `snooze`,
  `cancel_timer_or_alarm`, `get_weather` (Open-Meteo, no key needed),
  `manage_list`, `control_device` (simulated smart home), `play_ambient_sound`
  (rain / white noise / ocean, synthesized with Web Audio), `stop_ambient_sound`,
  `set_volume`, `manage_preferences`. Device states, preferences, and
  timers/alarms/reminders persist in `localStorage`.
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
- **No session resume exists** — if the connection drops the session is gone,
  so the client detects `connectionstatechange` failures and returns to idle
  for a clean reconnect.

Sources:
- [Realtime guide](https://developers.openai.com/api/docs/guides/realtime) ·
  [WebRTC guide](https://developers.openai.com/api/docs/guides/realtime-webrtc) ·
  [gpt-realtime announcement](https://openai.com/index/introducing-gpt-realtime/) ·
  [gpt-realtime-2.1 release](https://community.openai.com/t/new-realtime-models-on-the-api-gpt-realtime-2-1-and-gpt-realtime-2-1-mini/1385896) ·
  [2026 voice agent guide](https://www.open.cx/blog/openai-realtime-api-voice-agent-guide-2026)

## Notes & limits

- Weather uses the free, keyless [Open-Meteo](https://open-meteo.com) API;
  everything AI is OpenAI.
- Smart-home devices are simulated (state shown in the UI) — swap the
  `control_device` handler for real Home Assistant / Hue calls to go live.
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
