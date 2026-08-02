#!/usr/bin/env bash
# One-shot setup for the Nova wake-word service on a Raspberry Pi (or any
# Debian-ish Linux). Safe to re-run: every step is skipped if already done.
set -euo pipefail

cd "$(dirname "$0")"

MODEL_NAME="vosk-model-small-en-us-0.15"
MODEL_URL="https://alphacephei.com/vosk/models/${MODEL_NAME}.zip"

echo "==> System packages (PortAudio for microphone capture, venv, unzip)"
if command -v apt-get >/dev/null 2>&1; then
  sudo apt-get update
  sudo apt-get install -y libportaudio2 python3-venv python3-dev unzip curl
else
  echo "    not a Debian system — install PortAudio, python3-venv and unzip yourself"
fi

echo "==> Python virtual environment (.venv)"
# Raspberry Pi OS marks the system Python externally-managed, so a venv is not
# optional here — pip refuses to install into the system interpreter.
[ -d .venv ] || python3 -m venv .venv
./.venv/bin/pip install --upgrade pip
./.venv/bin/pip install -r requirements.txt

echo "==> Speech model (~40 MB, downloaded once)"
mkdir -p models
if [ -d "models/${MODEL_NAME}" ]; then
  echo "    already present"
else
  curl -fL --progress-bar -o "models/${MODEL_NAME}.zip" "$MODEL_URL"
  unzip -q "models/${MODEL_NAME}.zip" -d models
  rm -f "models/${MODEL_NAME}.zip"
fi

echo
echo "Done. Find your microphone, then try it:"
echo
echo "    ./.venv/bin/python nova_wake.py --list-devices"
echo "    ./.venv/bin/python nova_wake.py --verbose"
echo
echo "Say \"Nova\" — the browser with Nova open should start a session."
echo "To run it at boot, see nova-wake.service and README.md in this directory."
