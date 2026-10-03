"""A small async client for the local Ollama server (chat with tools, and the list of installed models and what they can do)."""
from __future__ import annotations

import json
import time
from collections.abc import AsyncIterator
from typing import Any

import httpx

from app.config import get_settings

_models_cache: tuple[float, list[dict[str, Any]]] | None = None
_caps_cache: dict[str, tuple[float, list[str]]] = {}


class OllamaError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code, self.message = code, message


def _client(timeout: float = 30) -> httpx.AsyncClient:
    return httpx.AsyncClient(base_url=get_settings().ollama_base_url, timeout=timeout)


async def list_models(force: bool = False) -> list[dict[str, Any]]:
    """Installed models with their abilities: [{name, size_gb, tools, thinking, vision}]. Cached briefly."""
    global _models_cache
    if not force and _models_cache and time.monotonic() - _models_cache[0] < 60:
        return _models_cache[1]
    try:
        async with _client() as c:
            tags = (await c.get("/api/tags")).json().get("models", [])
            out = []
            for m in tags:
                name = m["name"]
                hit = _caps_cache.get(name)
                if not hit or time.monotonic() - hit[0] > 600:
                    r = await c.post("/api/show", json={"model": name})
                    _caps_cache[name] = (time.monotonic(), (r.json().get("capabilities") or []) if r.status_code == 200 else [])
                caps = _caps_cache[name][1]
                out.append({"name": name, "size_gb": round(m.get("size", 0) / 1e9, 1), "tools": "tools" in caps, "thinking": "thinking" in caps, "vision": "vision" in caps})
    except (httpx.HTTPError, ValueError) as e:
        raise OllamaError("ollama_unreachable", "The AI model server isn't responding. Ask an admin to check that Ollama is running.") from e
    _models_cache = (time.monotonic(), out)
    return out


async def pick_model(requested: str | None) -> dict[str, Any]:
    """The model to use: the one asked for if installed, else the configured one, else the first that supports tools."""
    models = await list_models()
    if not models:
        raise OllamaError("no_model", "No AI models are installed on the server.")
    wanted = requested or get_settings().assistant_model
    if wanted:
        hit = next((m for m in models if m["name"] == wanted), None)
        if hit:
            return hit
        if requested:
            raise OllamaError("model_not_found", f"The model “{requested}” isn't installed.")
    return next((m for m in models if m["tools"]), models[0])


async def chat_stream(*, model: str, messages: list[dict[str, Any]], tools: list[dict[str, Any]] | None, think: bool, num_ctx: int, temperature: float = 0.3) -> AsyncIterator[dict[str, Any]]:
    """Yields the chunks of one streamed response: {content, thinking, tool_calls, done, prompt_tokens, eval_tokens}."""
    body: dict[str, Any] = {"model": model, "messages": messages, "stream": True, "think": think, "options": {"num_ctx": num_ctx, "temperature": temperature}}
    if tools:
        body["tools"] = tools
    try:
        async with _client(timeout=httpx.Timeout(600, connect=10)) as c:
            async with c.stream("POST", "/api/chat", json=body) as r:
                if r.status_code != 200:
                    detail = (await r.aread()).decode(errors="replace")[:300]
                    raise OllamaError("ollama_error", _friendly(r.status_code, detail))
                async for line in r.aiter_lines():
                    if not line.strip():
                        continue
                    d = json.loads(line)
                    if d.get("error"):
                        raise OllamaError("ollama_error", _friendly(500, str(d["error"])))
                    m = d.get("message") or {}
                    yield {"content": m.get("content") or "", "thinking": m.get("thinking") or "", "tool_calls": m.get("tool_calls") or [], "done": bool(d.get("done")),
                           "prompt_tokens": d.get("prompt_eval_count") or 0, "eval_tokens": d.get("eval_count") or 0}
    except httpx.ConnectError as e:
        raise OllamaError("ollama_unreachable", "The AI model server isn't responding. Ask an admin to check that Ollama is running.") from e
    except httpx.ReadTimeout as e:
        raise OllamaError("timeout", "The model took too long to answer. Try a shorter question.") from e


def _friendly(status: int, detail: str) -> str:
    d = detail.lower()
    if "memory" in d or "cuda" in d:
        return "The model couldn't be loaded because the GPU is short on memory. Free GPU memory in your notebook (or ask someone to), then try again."
    if status == 404 or "not found" in d:
        return "That model isn't installed."
    return "The AI model returned an error. Please try again."
