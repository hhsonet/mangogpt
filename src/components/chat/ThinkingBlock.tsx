"use client";
import { Brain, ChevronRight } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils/cn";

export function ThinkingBlock({ text, active }: { text: string; active?: boolean }) {
  const [open, setOpen] = useState(Boolean(active));
  const shown = open;
  return (
    <div className="mb-3 rounded-lg border border-border bg-surface text-sm">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-muted hover:text-fg"
      >
        <ChevronRight size={14} className={cn("transition-transform", open && "rotate-90")} />
        <Brain size={14} />
        <span>{active ? "Reasoning…" : "Reasoning"}</span>
      </button>
      {shown && <div className="max-h-80 overflow-y-auto whitespace-pre-wrap border-t border-border px-3 py-2 text-muted">{text}</div>}
    </div>
  );
}
