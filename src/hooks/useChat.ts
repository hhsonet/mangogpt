"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { AttachmentMeta, ChatMessage, ConversationDetail, ImageSize, StreamEvent } from "@/types";
import { api, refreshConversations } from "./api";

export interface StreamingState {
  content: string;
  thinking: string;
  phase: "connecting" | "thinking" | "answering" | "image";
  startedAt: number;
}

export interface ChatError {
  code: string;
  message: string;
}

export interface SendOptions {
  model: string;
  think?: boolean;
  projectId?: string | null;
  imageSize?: ImageSize;
}

// Lets the page remount at /c/[id] without refetching or flashing empty.
const cache = new Map<string, ConversationDetail>();

export function useChat(initialId?: string) {
  const router = useRouter();
  const [conversation, setConversation] = useState<ConversationDetail | null>(initialId ? (cache.get(initialId) ?? null) : null);
  const [messages, setMessages] = useState<ChatMessage[]>(conversation?.messages ?? []);
  const [loading, setLoading] = useState(Boolean(initialId) && !conversation);
  const [streaming, setStreaming] = useState<StreamingState | null>(null);
  const [error, setError] = useState<ChatError | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [notices, setNotices] = useState<string[]>([]);

  const abortRef = useRef<AbortController | null>(null);
  const conversationIdRef = useRef<string | undefined>(initialId);
  const pending = useRef<{ content: string; thinking: string }>({ content: "", thinking: "" });
  const raf = useRef<number | null>(null);

  const loadConversation = useCallback(async (id: string) => {
    const conv = await api<ConversationDetail>(`/api/conversations/${id}`);
    cache.set(id, conv);
    setConversation(conv);
    setMessages(conv.messages);
    return conv;
  }, []);

  useEffect(() => {
    if (!initialId) return;
    if (cache.has(initialId)) return;
    let live = true;
    api<ConversationDetail>(`/api/conversations/${initialId}`)
      .then((conv) => {
        if (!live) return;
        cache.set(initialId, conv);
        setConversation(conv);
        setMessages(conv.messages);
        setLoading(false);
      })
      .catch(() => {
        if (!live) return;
        setNotFound(true);
        setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [initialId]);

  // Abort any in-flight stream when leaving the view.
  useEffect(() => () => abortRef.current?.abort(), []);

  const flush = useCallback(() => {
    raf.current = null;
    const { content, thinking } = pending.current;
    setStreaming((s) => (s ? { ...s, content, thinking, phase: content ? "answering" : thinking ? "thinking" : s.phase } : s));
  }, []);

  const run = useCallback(
    async (body: Record<string, unknown>, opts: SendOptions) => {
      setError(null);
      setNotices([]);
      pending.current = { content: "", thinking: "" };
      setStreaming({ content: "", thinking: "", phase: "connecting", startedAt: Date.now() });
      const controller = new AbortController();
      abortRef.current = controller;
      let convId = conversationIdRef.current;
      let isNew = !convId;
      let failed = false;

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...body, conversationId: convId, model: opts.model, think: opts.think, projectId: opts.projectId }),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          const err = await res.json().catch(() => null);
          throw Object.assign(new Error(err?.message ?? `Request failed (${res.status})`), { code: err?.code ?? "generation_failed" });
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            const ev = JSON.parse(line) as StreamEvent;
            if (ev.type === "meta") {
              convId = ev.conversationId;
              conversationIdRef.current = convId;
            } else if (ev.type === "notice") {
              setNotices((n) => [...n, ev.message]);
            } else if (ev.type === "thinking") {
              pending.current.thinking += ev.delta;
            } else if (ev.type === "content") {
              pending.current.content += ev.delta;
            } else if (ev.type === "error") {
              failed = true;
              setError({ code: ev.code, message: ev.message });
            }
            if ((ev.type === "thinking" || ev.type === "content") && raf.current === null) {
              raf.current = requestAnimationFrame(flush);
            }
          }
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          failed = true;
          const e = err as Error & { code?: string };
          const offline = err instanceof TypeError;
          setError({
            code: e.code ?? (offline ? "network" : "generation_failed"),
            message: offline ? "Connection lost while generating. Partial output is saved; press Retry to try again." : e.message,
          });
        }
      } finally {
        if (raf.current !== null) cancelAnimationFrame(raf.current);
        raf.current = null;
        abortRef.current = null;
      }

      // Re-sync from the database so ids and partial output (after Stop) are accurate.
      if (convId) {
        try {
          const conv = await loadConversation(convId);
          setStreaming(null);
          void refreshConversations();
          if (!failed && !controller.signal.aborted && conv.messages.filter((m) => m.role === "user").length === 1 && conv.title !== "New chat") {
            api<ConversationDetail>(`/api/conversations/${convId}/title`, { method: "POST" })
              .then(() => refreshConversations())
              .catch(() => undefined);
          }
          if (isNew) router.replace(`/c/${convId}`);
        } catch {
          setStreaming(null);
        }
      } else {
        setStreaming(null);
      }
    },
    [flush, loadConversation, router],
  );

  /** Generate an image (non-streaming). `body` is the POST /api/images payload. */
  const runImage = useCallback(
    async (body: Record<string, unknown>, opts: SendOptions) => {
      setError(null);
      setStreaming({ content: "", thinking: "", phase: "image", startedAt: Date.now() });
      const controller = new AbortController();
      abortRef.current = controller;
      const isNew = !conversationIdRef.current;
      let convId = conversationIdRef.current;
      try {
        const res = await fetch("/api/images", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...body, conversationId: convId, size: opts.imageSize ?? "square" }),
          signal: controller.signal,
        });
        const data = (await res.json().catch(() => null)) as { conversationId?: string; code?: string; message?: string } | null;
        if (data?.conversationId) {
          convId = data.conversationId;
          conversationIdRef.current = convId;
        }
        if (!res.ok) setError({ code: data?.code ?? "image_unavailable", message: data?.message ?? `Image request failed (${res.status})` });
      } catch (err) {
        if (!controller.signal.aborted) {
          setError({ code: "network", message: err instanceof TypeError ? "Connection lost while generating the image. Press Retry." : (err as Error).message });
        }
      } finally {
        abortRef.current = null;
      }
      if (convId) {
        try {
          await loadConversation(convId);
          void refreshConversations();
          if (isNew) router.replace(`/c/${convId}`);
        } catch {
          /* keep what we have */
        }
      }
      setStreaming(null);
    },
    [loadConversation, router],
  );

  const generateImage = useCallback(
    (prompt: string, opts: SendOptions) => {
      setMessages((m) => [
        ...m,
        { id: `tmp-${Date.now()}`, conversationId: conversationIdRef.current ?? "", role: "user", content: prompt, thinking: null, imageId: null, model: null, createdAt: new Date().toISOString() },
      ]);
      return runImage({ prompt }, opts);
    },
    [runImage],
  );

  const send = useCallback(
    (content: string, opts: SendOptions, attachments: AttachmentMeta[] = []) => {
      const temp: ChatMessage = {
        id: `tmp-${Date.now()}`,
        conversationId: conversationIdRef.current ?? "",
        role: "user",
        content,
        thinking: null,
        imageId: null,
        attachments,
        model: opts.model,
        createdAt: new Date().toISOString(),
      };
      setMessages((m) => [...m, temp]);
      return run({ content, attachmentIds: attachments.map((a) => a.id) }, opts);
    },
    [run],
  );

  /** Re-run the model from `messageId` (an assistant message) onward. */
  const regenerate = useCallback(
    (messageId: string, opts: SendOptions) => {
      const isImage = messages.find((x) => x.id === messageId)?.imageId != null;
      setMessages((m) => {
        const i = m.findIndex((x) => x.id === messageId);
        return i >= 0 ? m.slice(0, i) : m;
      });
      return isImage ? runImage({ truncateFromMessageId: messageId }, opts) : run({ truncateFromMessageId: messageId }, opts);
    },
    [messages, run, runImage],
  );

  /** Replace a user message and everything after it, then regenerate. */
  const edit = useCallback(
    (messageId: string, content: string, opts: SendOptions) => {
      const i0 = messages.findIndex((x) => x.id === messageId);
      const isImage = i0 >= 0 && messages[i0 + 1]?.imageId != null;
      setMessages((m) => {
        const i = m.findIndex((x) => x.id === messageId);
        return i >= 0 ? [...m.slice(0, i), { ...m[i]!, content }] : m;
      });
      return isImage ? runImage({ truncateFromMessageId: messageId, prompt: content }, opts) : run({ truncateFromMessageId: messageId, content }, opts);
    },
    [messages, run, runImage],
  );

  const stop = useCallback(() => abortRef.current?.abort(), []);

  return { conversation, messages, loading, notFound, streaming, error, setError, notices, dismissNotices: () => setNotices([]), send, generateImage, regenerate, edit, stop, setConversation };
}
