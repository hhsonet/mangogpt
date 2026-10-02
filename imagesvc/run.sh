#!/usr/bin/env bash
# Starts the image service on 127.0.0.1:8100 (loopback only).
cd "$(dirname "$0")"
VENV="${IMAGESVC_VENV:-$HOME/.venvs/mangogpt-imagesvc}"
exec "$VENV/bin/python" -m uvicorn server:app --host 127.0.0.1 --port "${IMAGE_PORT:-8100}"
