import type { ErrorCode } from "@/types";

export class OllamaError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public status = 502,
  ) {
    super(message);
    this.name = "OllamaError";
  }
}

/** Turn a connection failure or an Ollama error body into a friendly error. */
export function toOllamaError(err: unknown, model?: string): OllamaError {
  if (err instanceof OllamaError) return err;
  const raw = err instanceof Error ? err.message : String(err);
  const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : "";
  const text = `${raw} ${cause}`.toLowerCase();

  if (text.includes("econnrefused") || text.includes("fetch failed") || text.includes("enotfound")) {
    return new OllamaError("ollama_offline", "Cannot reach Ollama. Check that `ollama serve` is running and OLLAMA_BASE_URL is correct.", 503);
  }
  return fromOllamaMessage(raw, model);
}

export function fromOllamaMessage(message: string, model?: string): OllamaError {
  const text = message.toLowerCase();
  if (text.includes("not found") || text.includes("try pulling")) {
    return new OllamaError("model_missing", `Model ${model ? `"${model}" ` : ""}is not installed. Run \`ollama pull ${model ?? "<model>"}\` on the server.`, 404);
  }
  if (text.includes("out of memory") || text.includes("insufficient") || text.includes("cuda error") || text.includes("requires more system memory")) {
    return new OllamaError("out_of_memory", "Not enough GPU memory for this model or context length. Try a smaller model or a shorter context in Settings.", 507);
  }
  if (text.includes("context") && (text.includes("exceed") || text.includes("too long") || text.includes("too large"))) {
    return new OllamaError("context_too_large", "The conversation is too long for the current context length. Start a new chat or raise the context length in Settings.", 413);
  }
  return new OllamaError("generation_failed", "The model failed to generate a response. Please try again.", 502);
}
