import { generateImage } from "@/lib/images/client";
import { acquireUserSlot, beginActivity, MAX_PER_USER } from "@/lib/monitor/activity";
import { logEvent } from "@/services/usage";
import { unloadAllModels } from "@/lib/ollama/client";
import { OllamaError } from "@/lib/ollama/errors";
import { getImagesEnabled } from "@/services/app-config";
import { addMessage, createConversation, getConversation, truncateFrom } from "@/services/conversations";
import { imageRateLimit, parseSize, saveImage } from "@/services/images";
import { getSettings } from "@/services/settings";
import { authed, errorResponse, json, readJson } from "../_lib";

export const dynamic = "force-dynamic";
export const maxDuration = 600;

const IMAGE_MODEL_LABEL = "sdxl-turbo";

interface Body {
  conversationId?: string;
  prompt?: string;
  size?: string;
  quality?: "fast" | "better";
  /** Delete this message and everything after it first (regenerate / edit). */
  truncateFromMessageId?: string;
}

export async function POST(req: Request) {
  const a = await authed();
  if (!a.ok) return a.res;
  const body = await readJson<Body>(req);
  if (!body) return json({ code: "bad_request", message: "Invalid request." }, 400);
  if (!(await getImagesEnabled())) return json({ code: "image_unavailable", message: "Image generation is turned off by an admin." }, 403);

  const prompt = body.prompt?.trim();
  if (prompt !== undefined && (prompt.length === 0 || prompt.length > 500)) {
    return json({ code: "bad_request", message: "Describe the image in 1–500 characters." }, 400);
  }
  if (!prompt && !body.truncateFromMessageId) return json({ code: "bad_request", message: "Describe the image you want." }, 400);

  const limit = imageRateLimit(a.user.id, a.user.role === "admin");
  if (!limit.ok) {
    return json({ code: "image_unavailable", message: `You've reached the hourly image limit. Try again in about ${limit.retryAfterMin} min.` }, 429);
  }

  const releaseSlot = acquireUserSlot(a.user.id);
  if (!releaseSlot) {
    return json({ code: "too_many_requests", message: `You already have ${MAX_PER_USER} answers or images being generated. Wait for one to finish.` }, 429);
  }

  try {
    const settings = await getSettings(a.user.id);
    let conv = body.conversationId ? await getConversation(a.user.id, body.conversationId) : null;
    if (body.conversationId && !conv) return json({ code: "bad_request", message: "Conversation not found." }, 404);
    if (!conv) {
      const title = (prompt ?? "Image").replace(/\s+/g, " ").slice(0, 48);
      conv = { ...(await createConversation(a.user.id, { model: settings.defaultModel || IMAGE_MODEL_LABEL, title: `Image: ${title}` })), messages: [] };
    }
    if (body.truncateFromMessageId) await truncateFrom(conv.id, body.truncateFromMessageId);
    if (prompt) await addMessage({ conversationId: conv.id, role: "user", content: prompt });

    const history = (await getConversation(a.user.id, conv.id))!.messages;
    const last = history[history.length - 1];
    if (!last || last.role !== "user") return json({ code: "bad_request", message: "Nothing to generate." }, 400);

    const size = parseSize(body.size);
    const steps = body.quality === "fast" ? 2 : 4;

    const started = Date.now();
    const endActivity = beginActivity("image");
    let png: Buffer;
    let seed: number;
    try {
      await unloadAllModels(); // the chat model and the image model can't share the GPU
      ({ png, seed } = await generateImage({ prompt: last.content, size, steps, signal: req.signal }));
    } catch (genErr) {
      endActivity();
      logEvent({ type: "image", status: "error", userId: a.user.id, username: a.user.username, model: IMAGE_MODEL_LABEL, durationMs: Date.now() - started, detail: genErr instanceof OllamaError ? genErr.message.slice(0, 120) : "failed" });
      throw genErr;
    }
    endActivity();
    logEvent({ type: "image", userId: a.user.id, username: a.user.username, model: IMAGE_MODEL_LABEL, durationMs: Date.now() - started, bytes: png.length, detail: `${size}, ${steps} steps` });
    const image = await saveImage({ userId: a.user.id, conversationId: conv.id, prompt: last.content, size, steps, seed, png });
    await addMessage({ conversationId: conv.id, role: "assistant", content: `Generated image: ${last.content}`, model: IMAGE_MODEL_LABEL, imageId: image.id });
    return json({ conversationId: conv.id });
  } catch (err) {
    if (err instanceof OllamaError) return json({ code: err.code, message: err.message }, err.status);
    return errorResponse(err);
  } finally {
    releaseSlot();
  }
}
