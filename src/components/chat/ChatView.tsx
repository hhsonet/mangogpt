"use client";
import { Menu, PanelLeft } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/sidebar/StatusBadge";
import { api, refreshConversations, useImageStatus, useModels, useSettings } from "@/hooks/api";
import { useApp } from "@/hooks/useApp";
import { useChat } from "@/hooks/useChat";
import { useLocalFlag } from "@/hooks/useLocalFlag";
import { formatDate } from "@/lib/utils/format";
import type { ImageSize } from "@/types";
import { Composer } from "./Composer";
import { ErrorBanner } from "./ErrorBanner";
import { MessageItem } from "./MessageItem";
import { StreamingMessage } from "./StreamingMessage";

const THINK_KEY = "think-enabled-v2";

export function ChatView({ conversationId }: { conversationId?: string }) {
  const { setMobileOpen, collapsed, toggleCollapsed } = useApp();
  const { settings, update } = useSettings();
  const { models } = useModels();
  const chat = useChat(conversationId);
  const { available: imageAvailable } = useImageStatus();
  const { conversation, messages, streaming, error } = chat;

  const [modelChoice, setModelChoice] = useState<string>("");
  const [think, changeThink] = useLocalFlag(THINK_KEY, true);

  // Model precedence: explicit choice > conversation's model > saved default > first installed model.
  const model = useMemo(() => {
    const names = new Set(models.map((m) => m.name));
    const candidates = [modelChoice, conversation?.model, settings?.defaultModel, models[0]?.name];
    return candidates.find((c) => c && (names.size === 0 || names.has(c))) ?? candidates.find(Boolean) ?? "";
  }, [modelChoice, conversation?.model, settings?.defaultModel, models]);

  const changeModel = (m: string) => {
    setModelChoice(m);
    void update({ defaultModel: m });
    if (conversation) {
      api(`/api/conversations/${conversation.id}`, { method: "PATCH", body: JSON.stringify({ model: m }) }).then(() => refreshConversations());
    }
  };

  const lastImageSize = useRef<ImageSize>("square");
  const opts = useCallback(() => ({ model, think: think ? undefined : false, imageSize: lastImageSize.current }), [model, think]);
  const generating = streaming !== null;

  // Esc stops generation (dialogs handle their own Esc first).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && generating && !document.querySelector("[role=dialog],[role=menu]")) chat.stop();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [generating, chat]);

  // Keep pinned to the bottom unless the user scrolls up.
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const onScroll = () => {
    const el = scrollRef.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages, streaming]);

  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  const retry = () => {
    const last = messages[messages.length - 1];
    if (!last) return;
    chat.setError(null);
    if (last.role === "assistant") void chat.regenerate(last.id, opts());
    else if (last.role === "user") void chat.edit(last.id, last.content, opts());
  };

  const empty = messages.length === 0 && !generating;

  return (
    <div className="flex h-dvh min-w-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
        <Button variant="ghost" size="icon" className="md:hidden" aria-label="Open sidebar" onClick={() => setMobileOpen(true)}>
          <Menu size={18} />
        </Button>
        {collapsed && (
          <Button variant="ghost" size="icon" className="max-md:hidden" aria-label="Expand sidebar" onClick={toggleCollapsed}>
            <PanelLeft size={18} />
          </Button>
        )}
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-medium">{conversation?.title ?? "New chat"}</h1>
          {conversation && (
            <p className="truncate text-xs text-muted">
              {conversation.model} · updated {formatDate(conversation.updatedAt)}
            </p>
          )}
        </div>
        <StatusBadge compact />
      </header>

      <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-4 py-4">
          {chat.loading && <p className="py-10 text-center text-sm text-muted">Loading…</p>}
          {chat.notFound && <p className="py-10 text-center text-sm text-muted">This conversation doesn’t exist (it may have been deleted).</p>}
          {empty && !chat.loading && !chat.notFound && (
            <div className="flex min-h-[40vh] flex-col items-center justify-center gap-2 text-center">
              <h2 className="text-2xl font-semibold">What can I help with?</h2>
              <p className="text-sm text-muted">Running privately on your own GPU{model ? ` with ${model}` : ""}.</p>
            </div>
          )}
          {messages.map((m, i) => (
            <MessageItem
              key={m.id}
              message={m}
              isLast={!generating && !error && m.id === lastAssistant?.id && i === messages.length - 1}
              disabled={generating}
              onEdit={(id, content) => void chat.edit(id, content, opts())}
              onRegenerate={(id) => void chat.regenerate(id, { ...opts(), imageSize: m.imageSize ?? lastImageSize.current })}
              onContinue={() => void chat.send("Continue.", opts())}
            />
          ))}
          {streaming && <StreamingMessage state={streaming} />}
          {error && <ErrorBanner error={error} onRetry={retry} onDismiss={() => chat.setError(null)} />}
          {chat.notices.length > 0 && !streaming && (
            <div role="status" className="my-3 flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
              <div className="flex-1">{chat.notices.join(" ")}</div>
              <button onClick={chat.dismissNotices} aria-label="Dismiss" className="cursor-pointer text-muted hover:text-fg">×</button>
            </div>
          )}
        </div>
      </div>

      <Composer
        model={model}
        onModelChange={changeModel}
        think={think}
        onThinkChange={changeThink}
        generating={generating}
        disabled={chat.loading || chat.notFound}
        numCtx={settings?.numCtx ?? 8192}
        onSend={(text, attachments) => {
          stick.current = true;
          void chat.send(text, opts(), attachments);
        }}
        onStop={chat.stop}
        imageAvailable={imageAvailable}
        onGenerateImage={(prompt, size) => {
          stick.current = true;
          lastImageSize.current = size;
          void chat.generateImage(prompt, { ...opts(), imageSize: size });
        }}
      />
    </div>
  );
}
