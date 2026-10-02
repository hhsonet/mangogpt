"use client";
import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { StreamingState } from "@/hooks/useChat";
import { Markdown } from "./Markdown";
import { ThinkingBlock } from "./ThinkingBlock";

const LABEL = { connecting: "Loading model…", thinking: "Thinking…", answering: "Generating…", image: "Creating image (the first one takes longer while the model loads)…" } as const;

export function StreamingMessage({ state }: { state: StreamingState }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);
  const secs = Math.max(0, Math.floor((now - state.startedAt) / 1000));

  return (
    <div className="msg py-3" aria-live="polite">
      {state.thinking && <ThinkingBlock text={state.thinking} active={!state.content} />}
      {state.content ? (
        <div className="caret">
          <Markdown text={state.content} />
        </div>
      ) : null}
      <div className="mt-2 flex items-center gap-2 text-xs text-muted">
        <Loader2 size={13} className="animate-spin" />
        {LABEL[state.phase]} {secs}s
      </div>
    </div>
  );
}
