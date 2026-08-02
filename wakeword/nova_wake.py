#!/usr/bin/env python3
"""Nova wake-word service — offline keyword spotting for the Raspberry Pi.

Why this exists: the browser cannot do this job. Chromium on the Pi has no
speech backend wired up, so the Web Speech API attaches to the microphone,
streams, and reports "no-speech" forever; and even on desktop Chrome, where it
works, it always listens to the *system default* input device with no API to
choose another. This owns the microphone directly instead.

How it works: Vosk runs a small offline model with its grammar restricted to
the wake phrases, which turns a general recognizer into a keyword spotter for
an arbitrary word — no model training, no account, no cloud. When it hears one,
it POSTs to the Nova server, which pushes the event to whichever browser is
holding the page open.

    python3 nova_wake.py                     # talk to https://localhost:3000
    python3 nova_wake.py --list-devices      # find your microphone
    python3 nova_wake.py --device 2 --verbose
    python3 nova_wake.py --self-test         # no mic or model needed

Only two third-party packages (vosk, sounddevice); everything else is stdlib.
See setup.sh and README.md in this directory.
"""

from __future__ import annotations

import argparse
import json
import queue
import re
import ssl
import sys
import time
import urllib.error
import urllib.request

DEFAULT_SERVER = "https://localhost:3000"
DEFAULT_MODEL = "models/vosk-model-small-en-us-0.15"
DEFAULT_PHRASES = ["nova", "hey nova", "okay nova"]

# One utterance should fire once. Vosk emits a growing partial as you speak, so
# without this a single "Nova" reports two or three times.
REFRACTORY_S = 2.5
PING_EVERY_S = 10.0
SAMPLE_RATE = 16000
BLOCK_SIZE = 4000  # 0.25 s at 16 kHz — small enough to keep detection prompt


# ---- matching -------------------------------------------------------------
# Kept deliberately close to matchesWakeWord() in public/lib/helpers.js: the
# same homophones, for the same reason. The recognizer is tuned for phrases
# rather than names, so "nova" comes back as "no va" or "noah" often enough
# that an exact match misses. False positives are cheap — a wake only opens a
# session, and a session nobody talks to closes itself again.
WAKE_RE = re.compile(r"\b(?:no ?va[hs]?|noah|nowa|nofa)\b")


def matches_wake_word(text: str) -> bool:
    """True if a transcript contains the wake word in any of its usual shapes."""
    flattened = re.sub(r"[^a-z]+", " ", (text or "").lower())
    return bool(WAKE_RE.search(flattened))


def grammar_for(phrases: list[str]) -> str:
    """Vosk grammar JSON: the phrases we care about, plus a bucket for the rest.

    Restricting the grammar is what makes a general recognizer usable as a
    keyword spotter — it stops the model reaching for the whole language when
    all we ever need is one word.
    """
    words: list[str] = []
    for phrase in phrases:
        for word in phrase.lower().split():
            if word not in words:
                words.append(word)
    # A few near-misses, so the recognizer has somewhere to put what it heard
    # rather than forcing it onto the wake word.
    for word in ("noah", "novak", "over", "no"):
        if word not in words:
            words.append(word)
    return json.dumps(words + ["[unk]"])


# ---- server link ----------------------------------------------------------

class NovaLink:
    """POSTs to the Nova server. Never raises: a wake word that crashes on a
    restarting server is worse than one that misses an event."""

    def __init__(self, base: str, insecure: bool = True, verbose: bool = False):
        self.base = base.rstrip("/")
        self.verbose = verbose
        # Nova on a Pi is typically served over HTTPS with an mkcert
        # certificate that this process has no reason to have in its trust
        # store. The connection is loopback — it never leaves the machine.
        self.ctx = ssl._create_unverified_context() if insecure else None
        self._warned = False

    def post(self, path: str, payload: dict) -> dict | None:
        req = urllib.request.Request(
            self.base + path,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            kwargs = {"timeout": 5}
            if self.ctx is not None and self.base.startswith("https"):
                kwargs["context"] = self.ctx
            with urllib.request.urlopen(req, **kwargs) as resp:
                self._warned = False
                return json.loads(resp.read().decode("utf-8") or "{}")
        except Exception as err:  # noqa: BLE001 — every failure is the same here
            if not self._warned:
                print(f"  ! cannot reach Nova at {self.base}: {err}", file=sys.stderr)
                print("    (is the server running? --server to point elsewhere)", file=sys.stderr)
                self._warned = True
            return None

    def ping(self) -> dict | None:
        return self.post("/api/wake", {"event": "ping"})

    def wake(self, heard: str) -> dict | None:
        return self.post("/api/wake", {"event": "wake", "heard": heard})


# ---- main loop ------------------------------------------------------------

def run(args) -> int:
    try:
        import sounddevice as sd
        from vosk import KaldiRecognizer, Model, SetLogLevel
    except ImportError as err:
        print(f"Missing dependency: {err}", file=sys.stderr)
        print("Run ./setup.sh in this directory, then activate the venv.", file=sys.stderr)
        return 1

    if args.list_devices:
        print(sd.query_devices())
        return 0

    SetLogLevel(-1)  # Vosk is chatty on stderr and says nothing useful at boot
    try:
        model = Model(args.model)
    except Exception as err:  # noqa: BLE001
        print(f"Could not load the Vosk model at {args.model}: {err}", file=sys.stderr)
        print("Run ./setup.sh to download it, or pass --model.", file=sys.stderr)
        return 1

    phrases = args.phrase or DEFAULT_PHRASES
    recognizer = KaldiRecognizer(model, SAMPLE_RATE, grammar_for(phrases))
    link = NovaLink(args.server, insecure=not args.verify_tls, verbose=args.verbose)

    audio: queue.Queue = queue.Queue()

    def on_audio(indata, _frames, _time, status):
        if status and args.verbose:
            print(f"  audio status: {status}", file=sys.stderr)
        audio.put(bytes(indata))

    print(f"Nova wake word: listening for {', '.join(repr(p) for p in phrases)}")
    print(f"  model  {args.model}")
    print(f"  server {args.server}")
    link.ping()

    last_ping = time.monotonic()
    muted_until = 0.0
    heard_anything = False
    started = time.monotonic()

    with sd.RawInputStream(
        samplerate=SAMPLE_RATE,
        blocksize=BLOCK_SIZE,
        device=args.device,
        dtype="int16",
        channels=1,
        callback=on_audio,
    ):
        while True:
            chunk = audio.get()
            now = time.monotonic()

            if now - last_ping >= PING_EVERY_S:
                last_ping = now
                link.ping()

            # The same silence trap the browser fell into, reported rather than
            # left to look like a broken feature: if the stream is delivering
            # nothing but digital silence, the microphone is the wrong one.
            if not heard_anything:
                if any(chunk):  # int16 LE bytes; all-zero means digital silence
                    heard_anything = True
                elif now - started > 30:
                    print("  ! 30 s of pure silence — is --device the right microphone?",
                          file=sys.stderr)
                    print("    List them with --list-devices.", file=sys.stderr)
                    started = float("inf")  # say it once

            if now < muted_until:
                recognizer.Reset()
                continue

            text = ""
            if recognizer.AcceptWaveform(chunk):
                text = json.loads(recognizer.Result()).get("text", "")
            else:
                text = json.loads(recognizer.PartialResult()).get("partial", "")
            if not text:
                continue
            if args.verbose:
                print(f"  heard {text!r}")
            if not matches_wake_word(text):
                continue

            print(f"  wake ← {text!r}")
            reply = link.wake(text)
            if reply and reply.get("ignored"):
                print(f"    (ignored: {reply['ignored']})")
            elif reply and not reply.get("listeners"):
                print("    (no browser has Nova open)")
            muted_until = now + REFRACTORY_S
            recognizer.Reset()


def self_test() -> int:
    """Check the matching rules without a microphone, a model, or a server."""
    should_wake = ["nova", "Nova!", "hey nova", "no va", "novah", "noah", "OK NOVA",
                   "hey nova are you there"]
    should_not = ["november", "innovation", "not now", "supernova", "", "over there"]
    failures = []
    for text in should_wake:
        if not matches_wake_word(text):
            failures.append(f"should have woken on {text!r}")
    for text in should_not:
        if matches_wake_word(text):
            failures.append(f"should have ignored {text!r}")
    grammar = json.loads(grammar_for(["nova", "hey nova"]))
    if "nova" not in grammar or "[unk]" not in grammar:
        failures.append(f"grammar looks wrong: {grammar}")
    for line in failures:
        print("FAIL:", line, file=sys.stderr)
    print(f"self-test: {len(should_wake) + len(should_not) + 1 - len(failures)} passed, "
          f"{len(failures)} failed")
    return 1 if failures else 0


def main() -> int:
    p = argparse.ArgumentParser(description="Nova offline wake-word service")
    p.add_argument("--server", default=DEFAULT_SERVER, help=f"Nova base URL (default {DEFAULT_SERVER})")
    p.add_argument("--model", default=DEFAULT_MODEL, help="path to the Vosk model directory")
    p.add_argument("--device", type=int, default=None, help="input device index (--list-devices)")
    p.add_argument("--phrase", action="append", help="wake phrase; repeatable")
    p.add_argument("--verify-tls", action="store_true",
                   help="validate the server certificate (off by default: loopback + mkcert)")
    p.add_argument("--list-devices", action="store_true", help="list input devices and exit")
    p.add_argument("--self-test", action="store_true", help="check matching rules and exit")
    p.add_argument("--verbose", action="store_true", help="print every transcript")
    args = p.parse_args()

    if args.self_test:
        return self_test()
    try:
        return run(args)
    except KeyboardInterrupt:
        print("\nstopped")
        return 0


if __name__ == "__main__":
    sys.exit(main())
