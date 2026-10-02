import { unloadImageModel } from "@/lib/images/client";
import { beginActivity, setTokensPerSec } from "@/lib/monitor/activity";
import { logEvent } from "@/services/usage";
import { buildMessages } from "@/lib/chat/context";
import { AttachmentError } from "@/lib/extract";
import { chatStream, modelSupportsVision } from "@/lib/ollama/client";
import { OllamaError, toOllamaError } from "@/lib/ollama/errors";
import { addMessage, createConversation, getConversation, truncateFrom } from "@/services/conversations";
import { getSettings } from "@/services/settings";
import { attachmentIdsOfMessage, linkAttachments, validatePending } from "@/services/attachments";
import { prisma } from "@/lib/db/prisma";
import type { StreamEvent } from "@/types";
import { authed, json, readJson } from "../_lib";

export const dynamic = "force-dynamic";
export const maxDuration = 600;

interface ChatRequest {
  conversationId?: string;
  projectId?: string | null;
  model?: string;
  /** New user message. Omit to regenerate from existing history. */
  content?: string;
  /** Delete this message and everything after it first (edit / regenerate / retry). */
  truncateFromMessageId?: string;
  /** false turns reasoning off on thinking-capable models. */
  think?: boolean;
  /** Ids of uploaded files (POST /api/attachments) to attach to the new user message. */
  attachmentIds?: string[];
}

const titleFrom = (text: string) => {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > 48 ? `${t.slice(0, 48).trimEnd()}…` : t || "New chat";
};

export async function POST(req: Request) {
  const a = await authed();
  if (!a.ok) return a.res;
  const body = await readJson<ChatRequest>(req);
  if (!body) return json({ code: "bad_request", message: "Invalid request." }, 400);

  const settings = await getSettings(a.user.id);
  const model = body.model || settings.defaultModel;
  if (!model) return json({ code: "bad_request", message: "No model selected." }, 400);
  if (!body.content?.trim() && !body.truncateFromMessageId) {
    return json({ code: "bad_request", message: "Message is empty." }, 400);
  }

  // Validate attachments before anything is saved.
  const attachmentIds = Array.isArray(body.attachmentIds) ? body.attachmentIds.filter((x): x is string => typeof x === "string").slice(0, 10) : [];
  try {
    const pending = await validatePending(a.user.id, attachmentIds);
    if (pending.some((p) => p.kind === "image") && !(await modelSupportsVision(model))) {
      return json({ code: "model_no_vision", message: `${model} can't read images. Switch to a vision model such as gemma4:12b or qwen3.5:9b, or remove the image.` }, 400);
    }
  } catch (err) {
    if (err instanceof AttachmentError) return json({ code: "attachment_error", message: err.message }, err.status);
    throw err;
  }

  let conv = body.conversationId ? await getConversation(a.user.id, body.conversationId) : null;
  if (body.conversationId && !conv) return json({ code: "bad_request", message: "Conversation not found." }, 404);
  if (!conv) {
    const created = await createConversation(a.user.id, { model, projectId: body.projectId, title: titleFrom(body.content ?? "") });
    conv = { ...created, messages: [] };
  }
  // Editing a message keeps its attachments and moves them onto the replacement message.
  const kept = body.truncateFromMessageId && body.content?.trim() ? await attachmentIdsOfMessage(body.truncateFromMessageId) : [];
  if (body.truncateFromMessageId) await truncateFrom(conv.id, body.truncateFromMessageId, kept);

  let userMessageId = "";
  if (body.content?.trim()) {
    userMessageId = (await addMessage({ conversationId: conv.id, role: "user", content: body.content, model })).id;
    if (kept.length) await prisma.attachment.updateMany({ where: { id: { in: kept } }, data: { messageId: userMessageId, conversationId: conv.id } });
    if (attachmentIds.length) await linkAttachments(a.user.id, attachmentIds, conv.id, userMessageId);
  }
  const history = (await getConversation(a.user.id, conv.id))!.messages;
  if (history.length === 0 || history[history.length - 1]?.role !== "user") {
    return json({ code: "bad_request", message: "Nothing to respond to." }, 400);
  }

  const allAttachments = await prisma.attachment.findMany({ where: { conversationId: conv.id, messageId: { not: null } } });
  const { messages, notices } = await buildMessages({
    userId: a.user.id,
    history,
    attachments: allAttachments,
    system: settings.systemPrompt,
    numCtx: settings.numCtx,
    vision: allAttachments.some((x) => x.kind === "image") ? await modelSupportsVision(model) : false,
  });

  await unloadImageModel(); // free GPU memory held by the image model, if any
  const abort = new AbortController();
  req.signal.addEventListener("abort", () => abort.abort());
  const encoder = new TextEncoder();
  const convId = conv.id;
  const convTitle = conv.title;

  const started = Date.now();
  const endActivity = beginActivity("chat");
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const send = (e: StreamEvent) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(e)}\n`));
        } catch {
          open = false;
        }
      };
      send({ type: "meta", conversationId: convId, userMessageId, title: convTitle });
      for (const message of notices) send({ type: "notice", message });

      let content = "";
      let thinking = "";
      let stats: { tokens: number; seconds: number } | undefined;
      let promptTokens = 0;
      let failure: OllamaError | undefined;
      try {
        for await (const chunk of chatStream({
          model,
          messages,
          think: body.think === false ? false : undefined,
          options: { temperature: settings.temperature, topP: settings.topP, numCtx: settings.numCtx },
          signal: abort.signal,
        })) {
          if (chunk.thinking) {
            thinking += chunk.thinking;
            send({ type: "thinking", delta: chunk.thinking });
          }
          if (chunk.content) {
            content += chunk.content;
            send({ type: "content", delta: chunk.content });
          }
          if (chunk.done && chunk.evalCount && chunk.evalDurationNs) {
            stats = { tokens: chunk.evalCount, seconds: chunk.evalDurationNs / 1e9 };
            setTokensPerSec(chunk.evalCount / (chunk.evalDurationNs / 1e9));
          }
          if (chunk.done && chunk.promptEvalCount) promptTokens = chunk.promptEvalCount;
        }
      } catch (err) {
        failure = err instanceof OllamaError ? err : toOllamaError(err, model);
        console.error("[chat]", err);
      }

      // Persist whatever was generated, including partial output after Stop.
      let messageId = "";
      if (content || thinking) {
        messageId = (await addMessage({ conversationId: convId, role: "assistant", content, thinking, model })).id;
      }
      endActivity();
      logEvent({
        type: "chat",
        status: failure ? "error" : abort.signal.aborted ? "cancelled" : "ok",
        userId: a.user.id,
        username: a.user.username,
        model,
        tokensIn: promptTokens || null,
        tokensOut: stats?.tokens ?? null,
        durationMs: Date.now() - started,
        detail: failure ? failure.code : null,
      });
      if (failure) send({ type: "error", code: failure.code, message: failure.message });
      else send({ type: "done", messageId, stats });
      open = false;
      try {
        controller.close();
      } catch {
        /* already closed by client */
      }
    },
    cancel() {
      abort.abort();
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" },
  });
}
