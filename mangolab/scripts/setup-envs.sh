#!/usr/bin/env bash
# Creates the two Python environments outside the repo (so Next.js/Turbopack never scans them):
#   ~/.venvs/mangolab-api   FastAPI control plane (small)
#   ~/.venvs/mangolab-base  notebook kernel environment with CUDA PyTorch (shares PyTorch files with other uv environments via hard links)
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
API="${MANGOLAB_API_VENV:-$HOME/.venvs/mangolab-api}"
BASE="${MANGOLAB_BASE_VENV:-$HOME/.venvs/mangolab-base}"
[ -d "$API" ] || uv venv --python 3.12 "$API"
uv pip install --python "$API/bin/python" -r "$HERE/api/requirements.txt"
[ -d "$BASE" ] || uv venv --python 3.12 "$BASE"
uv pip install --python "$BASE/bin/python" torch torchvision --index-url https://download.pytorch.org/whl/cu128
uv pip install --python "$BASE/bin/python" -r "$HERE/runtime/requirements-base.txt"
echo SETUP_DONE
