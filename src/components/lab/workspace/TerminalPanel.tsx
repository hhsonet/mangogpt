"use client";
import { Plug, Plus, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type { ApiError } from "@/hooks/api";
import { terminalsApi } from "@/lib/lab/api";
import type { TerminalInfo } from "@/lib/lab/types";
import { cn } from "@/lib/utils/cn";
import { useRuntime, useRuntimeClient } from "./RuntimeContext";
import { TerminalView } from "./TerminalView";

/** Shells running in the project's runtime. They share its RAM, CPU and process limits with the notebooks. */
export function TerminalPanel({ projectId, visible }: { projectId: string; visible: boolean }) {
  const client = useRuntimeClient();
  const status = useRuntime((s) => s.runtime.status);
  const connecting = useRuntime((s) => s.connecting);
  const [terms, setTerms] = useState<TerminalInfo[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const add = useCallback(async () => {
    setError("");
    setBusy(true);
    try {
      const t = await terminalsApi.create(projectId);
      setTerms((l) => [...l, t]);
      setActive(t.id);
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  }, [projectId]);

  // Pick up terminals that survived a page reload; open the first one when the runtime is ready and none exist.
  useEffect(() => {
    if (status !== "running") return; // the placeholder shows; the list is reloaded when a runtime is running again
    let live = true;
    terminalsApi
      .list(projectId)
      .then((r) => {
        if (!live) return;
        setTerms(r.terminals);
        setActive((a) => (r.terminals.some((t) => t.id === a) ? a : (r.terminals[0]?.id ?? null)));
        if (r.terminals.length === 0 && visible) void add();
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run when the runtime becomes ready or the panel is first shown
  }, [status, projectId, visible]);

  const close = async (id: string) => {
    setTerms((l) => l.filter((t) => t.id !== id));
    setActive((a) => (a === id ? (terms.find((t) => t.id !== id)?.id ?? null) : a));
    await terminalsApi.close(projectId, id).catch(() => undefined);
  };

  if (status !== "running") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-sm text-muted">Terminals run inside the runtime, next to your notebooks.</p>
        <Button variant="primary" size="sm" disabled={status === "starting" || connecting} onClick={() => client.ensureRuntime().catch(() => undefined)}>
          <Plug size={14} /> {status === "starting" || connecting ? "Connecting…" : "Connect a runtime"}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1" role="tablist" aria-label="Terminals">
        {terms.map((t) => (
          <div key={t.id} className={cn("flex items-center rounded-md text-xs", t.id === active ? "bg-surface-2 font-medium" : "text-muted hover:text-fg")}>
            <button role="tab" aria-selected={t.id === active} onClick={() => setActive(t.id)} className="cursor-pointer px-2 py-1">
              {t.title}
            </button>
            <button aria-label={`Close ${t.title}`} onClick={() => void close(t.id)} className="mr-1 cursor-pointer rounded p-0.5 hover:bg-surface">
              <X size={12} />
            </button>
          </div>
        ))}
        <Button size="icon" variant="ghost" aria-label="New terminal" title="New terminal" onClick={() => void add()} disabled={busy || terms.length >= 3} className="h-7 w-7">
          <Plus size={14} />
        </Button>
        {error && (
          <span role="alert" className="ml-2 truncate text-xs text-danger">
            {error}
          </span>
        )}
      </div>
      <div className="relative min-h-0 flex-1">
        {terms.map((t) => (
          <div key={t.id} className="absolute inset-0" hidden={t.id !== active}>
            <TerminalView projectId={projectId} terminalId={t.id} active={visible && t.id === active} onEnded={() => undefined} />
          </div>
        ))}
        {terms.length === 0 && <p className="p-4 text-sm text-muted">No terminal open. Press + to start one.</p>}
      </div>
    </div>
  );
}
