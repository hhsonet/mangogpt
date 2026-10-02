"use client";
import { Check, Copy, WrapText } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils/cn";

export function CodeBlock({ language, text, children }: { language: string; text: string; children: React.ReactNode }) {
  const [wrap, setWrap] = useState(false);
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked */
    }
  };

  return (
    <div className="not-prose my-4 overflow-hidden rounded-lg border border-border bg-[var(--code-bg)]">
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5 text-xs text-muted">
        <span className="font-mono">{language || "text"}</span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setWrap((w) => !w)}
            aria-pressed={wrap}
            title="Toggle line wrapping"
            className={cn("flex items-center gap-1 rounded px-1.5 py-1 hover:bg-surface-2 cursor-pointer", wrap && "text-fg")}
          >
            <WrapText size={13} /> Wrap
          </button>
          <button onClick={copy} className="flex items-center gap-1 rounded px-1.5 py-1 hover:bg-surface-2 cursor-pointer">
            {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </div>
      <pre className={cn("m-0 overflow-x-auto p-3 font-mono text-[0.85rem] leading-relaxed", wrap && "whitespace-pre-wrap break-words")}>
        {children}
      </pre>
    </div>
  );
}
