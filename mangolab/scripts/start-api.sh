#!/usr/bin/env bash
# Start the MangoLab control plane on 127.0.0.1:8200 (loopback only; the gateway exposes it as /lab-api).
cd "$(dirname "$0")/../api"
exec "${MANGOLAB_API_VENV:-$HOME/.venvs/mangolab-api}/bin/uvicorn" app.main:app --host 127.0.0.1 --port "${MANGOLAB_API_PORT:-8200}" --log-level warning
