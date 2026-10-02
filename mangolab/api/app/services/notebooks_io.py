"""Reading, validating and writing Jupyter notebooks (nbformat 4.x). The .ipynb file stays the source of truth."""
from __future__ import annotations

import hashlib
import re
import secrets

import nbformat
from nbformat import NotebookNode, ValidationError

from app.errors import ApiError

MAX_NOTEBOOK_BYTES = 50 * 1024 * 1024
_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
KERNELSPEC = {"display_name": "Python 3 (MangoLab)", "language": "python", "name": "python3"}


def new_cell_id() -> str:
    return secrets.token_hex(4)


def etag(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()[:32]


def _md(source: str) -> dict:
    return {"cell_type": "markdown", "metadata": {}, "source": source}


def _code(source: str) -> dict:
    return {"cell_type": "code", "metadata": {}, "source": source, "outputs": [], "execution_count": None}


def blank_notebook() -> NotebookNode:
    return normalize({
        "nbformat": 4, "nbformat_minor": 5,
        "metadata": {"kernelspec": KERNELSPEC, "language_info": {"name": "python"}},
        "cells": [_code("")],
    })


def welcome_notebook() -> NotebookNode:
    return normalize({
        "nbformat": 4, "nbformat_minor": 5,
        "metadata": {"kernelspec": KERNELSPEC, "language_info": {"name": "python"}},
        "cells": [
            _md("# Welcome to MangoLab\n\nNotebooks on your own GPU. Code cells run in a real Jupyter kernel with **CUDA PyTorch** ready to use.\n\n"
                "Press **Shift+Enter** in a cell to run it (the first run connects a runtime, which takes a second or two). **Ctrl+Enter** runs without moving on, and **Esc** then **I I** stops a running cell."),
            _code("import torch\n\nprint('PyTorch', torch.__version__)\nprint('CUDA available:', torch.cuda.is_available())\nif torch.cuda.is_available():\n    print(torch.cuda.get_device_name(0))"),
            _md("## A quick plot"),
            _code("import numpy as np\nimport matplotlib.pyplot as plt\n\nx = np.linspace(0, 6, 200)\nplt.plot(x, np.sin(x), label='sin')\nplt.plot(x, np.cos(x), label='cos')\nplt.legend()\nplt.show()"),
            _md("## Matrix multiply on the GPU"),
            _code("x = torch.randn(4096, 4096, device='cuda')\n(x @ x).sum().item()"),
        ],
    })


def normalize(raw: dict | NotebookNode) -> NotebookNode:
    """Accept a notebook, make it valid nbformat 4.5 (unique cell ids), and reject anything malformed with a clear message."""
    try:
        nb = nbformat.from_dict(raw)
        if nb.get("nbformat") != 4:
            raise ApiError(422, "invalid_notebook", "Only Jupyter notebook format 4 is supported.")
        if not isinstance(nb.get("cells"), list):
            raise ApiError(422, "invalid_notebook", "This file isn't a valid notebook (no cells).")
        nb.setdefault("metadata", {})
        nb["nbformat_minor"] = max(int(nb.get("nbformat_minor", 0)), 5)
        seen: set[str] = set()
        for cell in nb.cells:
            cid = cell.get("id")
            if not isinstance(cid, str) or not _ID_RE.match(cid) or cid in seen:
                cell["id"] = new_cell_id()
            seen.add(cell["id"])
            if cell.get("cell_type") == "code":
                cell.setdefault("outputs", [])
                cell.setdefault("execution_count", None)
            cell.setdefault("metadata", {})
        nbformat.validate(nb)
        return nb
    except ApiError:
        raise
    except ValidationError as e:
        raise ApiError(422, "invalid_notebook", f"This isn't a valid notebook: {str(e.message)[:160]}") from e
    except (ValueError, TypeError, KeyError, AttributeError) as e:
        raise ApiError(422, "invalid_notebook", "This file isn't a valid notebook.") from e


def parse(data: bytes) -> NotebookNode:
    if len(data) > MAX_NOTEBOOK_BYTES:
        raise ApiError(413, "too_large", "That notebook is larger than 50 MB.")
    try:
        text = data.decode("utf-8")
        nb = nbformat.reads(text, as_version=4)  # upgrades older formats
    except (UnicodeDecodeError, ValueError, ValidationError, AttributeError) as e:
        raise ApiError(422, "invalid_notebook", "This file isn't a valid notebook.") from e
    return normalize(nb)


def dumps(nb: NotebookNode) -> bytes:
    """Serialize like Jupyter does (sources split into lines, sorted keys, trailing newline) so diffs stay small."""
    out = nbformat.writes(nb).encode("utf-8")
    if not out.endswith(b"\n"):
        out += b"\n"
    return out
