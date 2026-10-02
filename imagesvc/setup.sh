#!/usr/bin/env bash
# Creates imagesvc/venv and downloads the model (fp16 files only, ~7 GB). Safe to re-run.
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$HOME/.local/bin:$PATH"
# The venv lives outside the project folder: Next.js/Turbopack must not scan it.
VENV="${IMAGESVC_VENV:-$HOME/.venvs/mangogpt-imagesvc}"
[ -d "$VENV" ] || uv venv "$VENV"
uv pip install --python "$VENV/bin/python" torch --index-url https://download.pytorch.org/whl/cu128
uv pip install --python "$VENV/bin/python" -r requirements.txt
"$VENV/bin/python" - <<'PY'
from huggingface_hub import snapshot_download
p = snapshot_download("stabilityai/sdxl-turbo", allow_patterns=["model_index.json", "*/config.json", "*.json", "*.txt", "*fp16.safetensors"], ignore_patterns=["sd_xl_turbo_1.0*"])
print("model at", p)
PY
echo SETUP_DONE
