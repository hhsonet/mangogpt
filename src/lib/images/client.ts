import "server-only";
import { OllamaError } from "@/lib/ollama/errors";
import type { ImageSize } from "@/types";

const BASE = (process.env.IMAGE_SERVICE_URL ?? "http://127.0.0.1:8100").replace(/\/$/, "");

export interface ImageHealth {
  ok: boolean;
  model?: string;
  loaded?: boolean;
  busy?: boolean;
  queued?: number;
}

export async function imageHealth(): Promise<ImageHealth> {
  try {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000), cache: "no-store" });
    return res.ok ? ((await res.json()) as ImageHealth) : { ok: false };
  } catch {
    return { ok: false };
  }
}

/** Free the image model's GPU memory so the chat model can load. Never throws. */
export async function unloadImageModel(): Promise<void> {
  try {
    await fetch(`${BASE}/unload`, { method: "POST", signal: AbortSignal.timeout(15000) });
  } catch {
    /* service not running: nothing to free */
  }
}

export async function generateImage(input: { prompt: string; size: ImageSize; steps: number; seed?: number; signal?: AbortSignal }) {
  let res: Response;
  try {
    res = await fetch(`${BASE}/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: input.prompt, size: input.size, steps: input.steps, seed: input.seed }),
      signal: input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(300_000)]) : AbortSignal.timeout(300_000),
    });
  } catch {
    throw new OllamaError("image_unavailable", "The image generator isn't running. Ask an admin to start it.", 503);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { detail?: string } | null;
    const status = res.status === 422 ? 422 : res.status === 503 ? 503 : res.status === 507 ? 507 : 502;
    throw new OllamaError("image_unavailable", body?.detail ?? "Image generation failed. Please try again.", status);
  }
  return { png: Buffer.from(await res.arrayBuffer()), seed: Number(res.headers.get("x-seed") ?? 0) };
}
