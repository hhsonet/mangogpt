"""Local image-generation service (SDXL-Turbo). Binds to loopback only; the Next.js app is its only client.

GPU memory is shared with Ollama, so the pipeline is loaded on demand, freed after IDLE_SECONDS,
and can be freed immediately via POST /unload.
"""
import asyncio
import gc
import io
import os
import random
import re
import time

import torch
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

MODEL_ID = os.environ.get("IMAGE_MODEL", "stabilityai/sdxl-turbo")
IDLE_SECONDS = int(os.environ.get("IMAGE_IDLE_SECONDS", "120"))
MAX_QUEUE = int(os.environ.get("IMAGE_MAX_QUEUE", "3"))
SIZES = {"square": (512, 512), "portrait": (512, 768), "landscape": (768, 512)}

# Conservative prompt filter. This model has no built-in safety checker, so refuse the obvious cases.
BLOCKED = re.compile(
    r"\b(nude|nudes|naked|nsfw|porn\w*|explicit|sexual\w*|erotic\w*|genital\w*|topless|lingerie|"
    r"gore|gory|beheading|child\s*abuse|loli\w*|underage)\b",
    re.I,
)

app = FastAPI(title="image-service", docs_url=None, redoc_url=None)
_pipe = None
_last_used = 0.0
_lock = asyncio.Lock()  # one generation at a time
_waiting = 0


class GenerateRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=500)
    size: str = "square"
    steps: int = Field(default=4, ge=1, le=8)
    seed: int | None = None


def _load():
    global _pipe
    if _pipe is None:
        from diffusers import AutoPipelineForText2Image

        _pipe = AutoPipelineForText2Image.from_pretrained(MODEL_ID, torch_dtype=torch.float16, variant="fp16")
        _pipe.to("cuda")
        _pipe.set_progress_bar_config(disable=True)
    return _pipe


def _free():
    global _pipe
    if _pipe is not None:
        _pipe = None
        gc.collect()
        torch.cuda.empty_cache()


def _generate(req: GenerateRequest, seed: int) -> bytes:
    pipe = _load()
    w, h = SIZES[req.size]
    gen = torch.Generator("cuda").manual_seed(seed)
    img = pipe(prompt=req.prompt, width=w, height=h, num_inference_steps=req.steps, guidance_scale=0.0, generator=gen).images[0]
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


@app.on_event("startup")
async def _janitor():
    async def loop():
        while True:
            await asyncio.sleep(15)
            if _pipe is not None and not _lock.locked() and time.time() - _last_used > IDLE_SECONDS:
                _free()

    asyncio.create_task(loop())


@app.get("/health")
def health():
    return {"ok": True, "model": MODEL_ID, "loaded": _pipe is not None, "queued": _waiting, "busy": _lock.locked(), "cuda": torch.cuda.is_available()}


@app.post("/unload")
async def unload():
    """Free GPU memory now (called before the chat model needs it). Waits for any running job."""
    async with _lock:
        _free()
    return {"loaded": False}


@app.post("/generate")
async def generate(req: GenerateRequest):
    global _waiting, _last_used
    if req.size not in SIZES:
        raise HTTPException(400, "Unknown size")
    if BLOCKED.search(req.prompt):
        raise HTTPException(422, "That prompt isn't allowed. Try describing something else.")
    if _waiting >= MAX_QUEUE:
        raise HTTPException(503, "The image generator is busy. Try again in a moment.")
    seed = req.seed if req.seed is not None else random.randint(0, 2**31 - 1)
    _waiting += 1
    try:
        async with _lock:
            started = time.time()
            try:
                png = await asyncio.to_thread(_generate, req, seed)
            except torch.cuda.OutOfMemoryError:
                _free()
                raise HTTPException(507, "Not enough GPU memory right now. Try again in a minute.")
            _last_used = time.time()
    finally:
        _waiting -= 1
    return Response(png, media_type="image/png", headers={"X-Seed": str(seed), "X-Seconds": f"{time.time() - started:.2f}"})
