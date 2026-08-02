# Nova wake-word service

Offline keyword spotting, so saying "Nova" starts a session hands-free.

## Why this isn't in the browser

It was, and it doesn't work. The browser's Web Speech API is the only wake-word
option available to a web page, and it fails on a Raspberry Pi for a reason no
amount of client-side work can fix: **Chromium has no speech backend**. The
recognizer attaches to the microphone, streams, and reports `no-speech`
forever. Even on desktop Chrome, where it does work, it always listens to the
*system default* input device and offers no API to choose another — so it can
hear silence while the session transcribes you perfectly.

This service owns the microphone directly instead. It is offline, needs no
account or API key, and never sends audio anywhere.

## How it works

[Vosk](https://alphacephei.com/vosk/) runs a small offline model with its
grammar restricted to the wake phrases, which turns a general speech recognizer
into a keyword spotter for an arbitrary word — no model training required,
which matters because "Nova" isn't in anyone's pretrained keyword set.

```
microphone → vosk (local) → POST /api/wake → SSE → browser starts a session
```

The server drops any wake that arrives while a session is already live, so Nova
never answers her own voice, and the browser only acts on wake events when the
device has the wake word switched on.

## Setup

```bash
cd wakeword
./setup.sh
```

That installs PortAudio, creates a virtualenv, installs `vosk` and
`sounddevice`, and downloads the ~40 MB model. Then find your microphone and
try it with Nova open in a browser:

```bash
./.venv/bin/python nova_wake.py --list-devices
./.venv/bin/python nova_wake.py --verbose
```

`--verbose` prints every transcript, which is the fastest way to see whether
the microphone is live and how the recognizer is hearing you. Say "Nova" and
the browser should start a session.

To run it at boot:

```bash
sudo cp nova-wake.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now nova-wake
journalctl -u nova-wake -f
```

## Options

| Flag | Default | Notes |
|---|---|---|
| `--server` | `https://localhost:3000` | Nova's base URL |
| `--device` | system default | Input device index from `--list-devices` |
| `--phrase` | `nova`, `hey nova`, `okay nova` | Repeatable |
| `--model` | `models/vosk-model-small-en-us-0.15` | Any Vosk model directory |
| `--verify-tls` | off | Off because the link is loopback and the certificate is usually mkcert's |
| `--verbose` | off | Print every transcript |
| `--self-test` | — | Check the matching rules; no mic, model or server needed |

## Troubleshooting

**Nothing happens when I say "Nova".** Run with `--verbose`. If no transcripts
appear at all, the microphone is wrong — `--list-devices` and pass `--device`.
The service says so itself after 30 seconds of digital silence.

**It fires on the wrong words.** Matching is deliberately loose, because the
recognizer is tuned for phrases rather than names and "Nova" comes back as
"no va" or "Noah" often enough that exact matching misses. A false trigger is
cheap: it opens a session, which closes itself after a minute of silence.
Narrow it in `WAKE_RE` in `nova_wake.py` if it bothers you.

**It works from a terminal but not under systemd.** Almost always
`XDG_RUNTIME_DIR` — PortAudio needs a session bus to reach PipeWire. The unit
file sets it for uid 1000; change it if your user isn't.

**`ignored: session-active` in the log.** Working as intended — Nova is already
listening, so the wake was dropped rather than restarting the session.

## Alternatives

If accuracy or CPU ever matters more than setup convenience,
[Porcupine](https://picovoice.ai/platform/porcupine/) is meaningfully better at
this specific job — but a custom "Nova" keyword needs a (free) Picovoice
account and a generated `.ppn` file, which is why it isn't the default here.
[openWakeWord](https://github.com/dscripka/openWakeWord) is the other good
option, though it would need a custom model trained for "Nova".
