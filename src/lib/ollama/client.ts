import "server-only";
import type { GenerationOptions, ModelInfo, OllamaStatus } from "@/types";
import { OllamaError, fromOllamaMessage, toOllamaError } from "./errors";

const BASE_URL = (process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434").replace(/\/$/, "");

export interface OllamaChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
  /** base64-encoded images (vision models only) */
  images?: string[];
}

export interface OllamaChunk {
  content?: string;
  thinking?: string;
  done: boolean;
  evalCount?: number;
  evalDurationNs?: number;
  promptEvalCount?: number;
}

async function request(path: string, init?: RequestInit & { timeoutMs?: number }): Promise<Response> {
  const { timeoutMs, ...rest } = init ?? {};
  const signals = [rest.signal, timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined].filter(Boolean) as AbortSignal[];
  try {
    return await fetch(`${BASE_URL}${path}`, { ...rest, signal: signals.length ? AbortSignal.any(signals) : undefined });
  } catch (err) {
    throw toOllamaError(err);
  }
}

async function failIfNotOk(res: Response, model?: string) {
  if (res.ok) return;
  let message = res.statusText;
  try {
    const body = (await res.json()) as { error?: string };
    if (body.error) message = body.error;
  } catch {
    /* non-JSON body */
  }
  throw fromOllamaMessage(message, model);
}

const capCache = new Map<string, { vision: boolean; at: number }>();

/** Whether a model can read images, from Ollama's /api/show capabilities (cached 5 min). */
export async function modelSupportsVision(model: string): Promise<boolean> {
  const hit = capCache.get(model);
  if (hit && Date.now() - hit.at < 300_000) return hit.vision;
  try {
    const res = await request("/api/show", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model }), timeoutMs: 5000 });
    if (!res.ok) return false;
    const vision = (((await res.json()) as { capabilities?: string[] }).capabilities ?? []).includes("vision");
    capCache.set(model, { vision, at: Date.now() });
    return vision;
  } catch {
    return false;
  }
}

export async function listModels(): Promise<ModelInfo[]> {
  const res = await request("/api/tags", { timeoutMs: 5000, cache: "no-store" });
  await failIfNotOk(res);
  const data = (await res.json()) as {
    models: { name: string; size: number; details?: { parameter_size?: string; quantization_level?: string; family?: string } }[];
  };
  const vision = await Promise.all(data.models.map((m) => modelSupportsVision(m.name)));
  return data.models.map((m, i) => ({
    name: m.name,
    vision: vision[i] ?? false,
    sizeBytes: m.size,
    parameterSize: m.details?.parameter_size ?? null,
    quantization: m.details?.quantization_level ?? null,
    family: m.details?.family ?? null,
  }));
}

export async function getStatus(): Promise<OllamaStatus> {
  try {
    const [versionRes, psRes] = await Promise.all([
      request("/api/version", { timeoutMs: 3000, cache: "no-store" }),
      request("/api/ps", { timeoutMs: 3000, cache: "no-store" }),
    ]);
    const version = ((await versionRes.json()) as { version?: string }).version;
    const ps = (await psRes.json()) as { models?: { name: string; size_vram: number; context_length?: number; expires_at?: string }[] };
    return {
      online: true,
      version,
      loadedModels: (ps.models ?? []).map((m) => ({ name: m.name, sizeVram: m.size_vram, contextLength: m.context_length, expiresAt: m.expires_at })),
    };
  } catch (err) {
    return { online: false, loadedModels: [], error: toOllamaError(err).message };
  }
}

interface ChatParams {
  model: string;
  messages: OllamaChatMessage[];
  options?: GenerationOptions;
  /** false disables reasoning on thinking-capable models. Left undefined = model default. */
  think?: boolean;
  signal?: AbortSignal;
}

function buildBody(p: ChatParams, stream: boolean, think = p.think) {
  return JSON.stringify({
    model: p.model,
    messages: p.messages,
    stream,
    ...(think !== undefined ? { think } : {}),
    options: {
      ...(p.options?.temperature !== undefined ? { temperature: p.options.temperature } : {}),
      ...(p.options?.topP !== undefined ? { top_p: p.options.topP } : {}),
      ...(p.options?.numCtx !== undefined ? { num_ctx: p.options.numCtx } : {}),
    },
  });
}

/** Stream a chat completion. Yields content/thinking deltas; cancel via `signal`. */
export async function* chatStream(params: ChatParams): AsyncGenerator<OllamaChunk> {
  const post = (think: boolean | undefined) =>
    request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: buildBody(params, true, think),
      signal: params.signal,
    });

  let res = await post(params.think);
  // Models without reasoning support reject the `think` flag; retry without it.
  if (res.status === 400 && params.think !== undefined) {
    const body = await res.clone().text();
    if (body.toLowerCase().includes("think")) res = await post(undefined);
  }
  await failIfNotOk(res, params.model);
  if (!res.body) throw new OllamaError("generation_failed", "Ollama returned an empty response.");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        const obj = JSON.parse(line) as {
          error?: string;
          message?: { content?: string; thinking?: string };
          done?: boolean;
          eval_count?: number;
          eval_duration?: number;
          prompt_eval_count?: number;
        };
        if (obj.error) throw fromOllamaMessage(obj.error, params.model);
        yield {
          content: obj.message?.content || undefined,
          thinking: obj.message?.thinking || undefined,
          done: obj.done ?? false,
          evalCount: obj.eval_count,
          evalDurationNs: obj.eval_duration,
          promptEvalCount: obj.prompt_eval_count,
        };
      }
    }
  } catch (err) {
    if (params.signal?.aborted) return;
    throw toOllamaError(err, params.model);
  } finally {
    reader.cancel().catch(() => undefined);
  }
}

/** One-shot completion, used for title generation. */
export async function chatOnce(params: Omit<ChatParams, "signal"> & { timeoutMs?: number }): Promise<string> {
  const res = await request("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: buildBody({ ...params, think: false }, false, false),
    timeoutMs: params.timeoutMs ?? 30000,
  });
  await failIfNotOk(res, params.model);
  const data = (await res.json()) as { message?: { content?: string } };
  return data.message?.content?.trim() ?? "";
}

/** Evict every loaded model from GPU memory (used before image generation). */
export async function unloadAllModels(): Promise<void> {
  try {
    const res = await request("/api/ps", { timeoutMs: 3000, cache: "no-store" });
    const ps = (await res.json()) as { models?: { name: string }[] };
    await Promise.all(
      (ps.models ?? []).map((m) =>
        request("/api/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: m.name, keep_alive: 0 }),
          timeoutMs: 10000,
        }).catch(() => undefined),
      ),
    );
    // Eviction is asynchronous; wait until the GPU is actually free.
    for (let i = 0; i < 20; i++) {
      const r = await request("/api/ps", { timeoutMs: 3000, cache: "no-store" });
      if (!(((await r.json()) as { models?: unknown[] }).models ?? []).length) return;
      await new Promise((r2) => setTimeout(r2, 250));
    }
  } catch {
    /* Ollama offline: nothing to unload */
  }
}
