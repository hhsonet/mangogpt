"use client";
import { ArrowUp, Brain, ChevronDown, Loader2, MessageSquarePlus, Sparkles, Square, Trash2, Wrench, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import useSWR from "swr";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown";
import type { ApiError } from "@/hooks/api";
import { assistantApi, streamChat } from "@/lib/lab/assistant";
import { packagesApi } from "@/lib/lab/api";
import type { AssistantAction, AssistantEvent, AssistantMessage, AssistantMode } from "@/lib/lab/types";
import { cn } from "@/lib/utils/cn";
import { ActionCard } from "./ActionCard";
import { useBridgeRegistry } from "./AssistantBridge";
import { LabMarkdown } from "./LabMarkdown";

export interface AskRequest {
  path: string;
  cellId: string;
  mode: "explain" | "fix";
  nonce: number;
}

const lsGet = (k: string, d: string) => {
  try {
    return localStorage.getItem(k) ?? d;
  } catch {
    return d;
  }
};
const lsSet = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* storage unavailable */
  }
};

/** "Thinking…", and after a few seconds an explanation: the first question after a while has to load the model onto the GPU. */
function Waiting() {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), 6000);
    return () => clearTimeout(t);
  }, []);
  return (
    <p className="flex items-center gap-2 text-xs text-muted">
      <Loader2 size={12} className="animate-spin" /> {slow ? "Still working. The first question after a quiet spell has to load the model, which can take up to a minute." : "Thinking…"}
    </p>
  );
}

interface Props {
  projectId: string;
  /** The open notebook, or null when something else is in front. */
  path: string | null;
  ask: AskRequest | null;
  onClose: () => void;
  onOpenPackages: () => void;
}

/** The MangoLab assistant: ask about the open notebook, let it look around, and review the changes it proposes before they happen. */
export function AssistantPanel({ projectId, path, ask, onClose, onOpenPackages }: Props) {
  const registry = useBridgeRegistry();
  const bridge = path ? registry.get(path) : undefined;
  // Re-render when the selected cell or the notebook changes, so the quick actions and proposals follow what the person is looking at.
  useSyncExternalStore(
    useCallback((cb: () => void) => bridge?.subscribe(cb) ?? (() => undefined), [bridge]),
    () => bridge?.version() ?? "",
    () => "",
  );
  const models = useSWR(["lab-ai-models", projectId], () => assistantApi.models(projectId), { revalidateOnFocus: false, shouldRetryOnError: false });
  const threads = useSWR(["lab-ai-threads", projectId, path], () => assistantApi.threads(projectId, path), { revalidateOnFocus: false });
  const [model, setModel] = useState(() => lsGet("lab-ai-model", ""));
  const [think, setThink] = useState(() => lsGet("lab-ai-think", "0") === "1");
  const [chosen, setChosen] = useState<Record<string, string | null>>({}); // conversation per notebook; null = a fresh one
  const [byThread, setByThread] = useState<Record<string, AssistantMessage[]>>({});
  const [draft, setDraft] = useState("");
  const [mode, setMode] = useState<AssistantMode>("chat");
  const [streamingTid, setStreamingTid] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<Record<string, string>>({});
  const abort = useRef<AbortController | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const key = path ?? "";
  const tid = chosen[key] !== undefined ? chosen[key] : (threads.data?.threads[0]?.id ?? null);
  const loaded = tid ? byThread[tid] : undefined;

  const selectedModel = models.data?.models.find((m) => m.name === (model || models.data?.default));
  const messages = useMemo(() => loaded ?? [], [loaded]);

  // Load a conversation's history the first time it is opened.
  useEffect(() => {
    if (!tid || byThread[tid] !== undefined) return;
    let live = true;
    assistantApi
      .messages(projectId, tid)
      .then((r) => live && setByThread((m) => (m[tid] !== undefined ? m : { ...m, [tid]: r.messages.map((x) => ({ ...x, tools: x.tools.map((t, i) => ({ id: `${x.id}-${i}`, name: t.name, status: t.error ? "error" : "done", summary: t.summary })) })) })))
      .catch(() => live && setByThread((m) => ({ ...m, [tid]: [] })));
    return () => {
      live = false;
    };
  }, [tid, projectId, byThread]);

  // Keep the newest text in view while it streams, unless the person scrolled up to read.
  useEffect(() => {
    const el = scroller.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 160) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const patchAssistant = useCallback((threadId: string, fn: (m: AssistantMessage) => AssistantMessage) => {
    setByThread((all) => {
      const list = all[threadId];
      if (!list?.length) return all;
      const copy = list.slice();
      copy[copy.length - 1] = fn(copy[copy.length - 1]!);
      return { ...all, [threadId]: copy };
    });
  }, []);

  const send = useCallback(
    async (text: string, sendMode: AssistantMode = "chat") => {
      const message = text.trim();
      if (!message || streamingTid) return;
      let threadId = tid;
      try {
        if (!threadId) {
          threadId = (await assistantApi.createThread(projectId, path)).id;
          setChosen((c) => ({ ...c, [key]: threadId }));
          setByThread((m) => ({ ...m, [threadId!]: [] }));
        }
      } catch (e) {
        window.alert((e as ApiError).message);
        return;
      }
      const t = threadId!;
      setStreamingTid(t);
      setDraft("");
      setMode("chat");
      setByThread((all) => ({
        ...all,
        [t]: [...(all[t] ?? []), { id: `u-${Date.now()}`, role: "user", content: message, tools: [], actions: [] }, { id: `a-${Date.now()}`, role: "assistant", content: "", tools: [], actions: [], streaming: true }],
      }));
      const ctl = new AbortController();
      abort.current = ctl;
      const onEvent = (e: AssistantEvent) => {
        if (e.type === "meta") patchAssistant(t, (m) => ({ ...m, id: e.assistant_message_id, model: e.model, trimmed: e.trimmed }));
        else if (e.type === "content") patchAssistant(t, (m) => ({ ...m, content: m.content + e.delta }));
        else if (e.type === "thinking") patchAssistant(t, (m) => ({ ...m, thinking: (m.thinking ?? "") + e.delta }));
        else if (e.type === "tool") patchAssistant(t, (m) => ({ ...m, tools: m.tools.some((x) => x.id === e.id) ? m.tools.map((x) => (x.id === e.id ? { ...x, status: e.status, summary: e.summary } : x)) : [...m.tools, { id: e.id, name: e.name, status: e.status, summary: e.summary }] }));
        else if (e.type === "action") patchAssistant(t, (m) => ({ ...m, actions: [...m.actions, e.action] }));
        else if (e.type === "error") patchAssistant(t, (m) => ({ ...m, error: e.message }));
      };
      try {
        await streamChat(projectId, t, { message, mode: sendMode, model: model || undefined, think, context: bridge ? bridge.snapshot() : null }, onEvent, ctl.signal);
      } finally {
        patchAssistant(t, (m) => ({ ...m, streaming: false }));
        setStreamingTid(null);
        abort.current = null;
        void threads.mutate();
      }
    },
    [tid, streamingTid, projectId, path, key, model, think, bridge, patchAssistant, threads],
  );

  // "Fix with AI" / "Explain with AI" on a cell
  const lastNonce = useRef(0);
  useEffect(() => {
    if (!ask || ask.nonce === lastNonce.current || ask.path !== path || !bridge) return;
    lastNonce.current = ask.nonce;
    bridge.selectCell(ask.cellId);
    const n = bridge.snapshot().cells.findIndex((c) => c.id === ask.cellId) + 1;
    void send(ask.mode === "fix" ? `Fix the error in cell [${n}]` : `Explain cell [${n}]`, ask.mode);
  }, [ask, path, bridge, send]);

  const stop = () => abort.current?.abort();
  const newChat = () => {
    setChosen((c) => ({ ...c, [key]: null }));
    setTimeout(() => input.current?.focus(), 0);
  };

  // ---- applying proposals
  const decide = async (threadId: string, msgId: string, action: AssistantAction, kind: "apply" | "reject" | "undo") => {
    setActionBusy(action.id);
    setActionError((e) => ({ ...e, [action.id]: "" }));
    const setStatus = (status: AssistantAction["status"], extra?: Record<string, unknown>) =>
      setByThread((all) => ({ ...all, [threadId]: (all[threadId] ?? []).map((m) => (m.id !== msgId ? m : { ...m, actions: m.actions.map((a) => (a.id === action.id ? ({ ...a, status, payload: { ...a.payload, ...extra } } as AssistantAction) : a)) })) }));
    try {
      if (kind === "reject") {
        await assistantApi.patchAction(projectId, action.id, "rejected");
        setStatus("rejected");
      } else if (kind === "apply") {
        let prev: string | undefined;
        if (action.type === "edit_cell") {
          prev = bridge?.cellSource(action.payload.cell_id) ?? undefined;
          if (!bridge?.editCell(action.payload.cell_id, action.payload.source)) throw new Error("That cell no longer exists.");
        } else if (action.type === "insert_cell") {
          if (!bridge) throw new Error("Open the notebook first.");
          prev = bridge.insertCell({ position: action.payload.position, refCellId: action.payload.ref_cell_id, type: action.payload.cell_type, source: action.payload.source });
        } else if (action.type === "run_cell") {
          if (!bridge) throw new Error("Open the notebook first.");
          bridge.runCell(action.payload.cell_id);
        } else {
          await packagesApi.install(projectId, action.payload.specs);
          onOpenPackages();
        }
        await assistantApi.patchAction(projectId, action.id, "applied", prev);
        setStatus("applied", prev !== undefined ? { applied_prev: prev } : undefined);
      } else {
        // undo (or bring back a dismissed one)
        if (action.status === "applied") {
          if (action.type === "edit_cell" && action.payload.applied_prev !== undefined) bridge?.editCell(action.payload.cell_id, action.payload.applied_prev);
          if (action.type === "insert_cell" && action.payload.applied_prev) bridge?.removeCell(action.payload.applied_prev);
        }
        await assistantApi.patchAction(projectId, action.id, "proposed");
        setStatus("proposed");
      }
    } catch (e) {
      setActionError((x) => ({ ...x, [action.id]: (e as Error).message }));
    } finally {
      setActionBusy(null);
    }
  };

  const snapshot = bridge?.snapshot();
  const selected = snapshot?.cells.find((c) => c.id === snapshot.selected);
  const selNumber = snapshot && selected ? snapshot.cells.indexOf(selected) + 1 : 0;
  const quick = useMemo(
    () => [
      { label: "Fix error", mode: "fix" as const, text: `Fix the error in cell [${selNumber}]`, show: !!selected?.failed, strong: true },
      { label: "Explain cell", mode: "explain" as const, text: `Explain cell [${selNumber}]`, show: !!selected },
      { label: "Make it faster", mode: "optimize" as const, text: `Review cell [${selNumber}] for speed and memory use`, show: !!selected && selected.type === "code" },
    ],
    [selected, selNumber],
  );

  const codeActions = useCallback(
    (code: string, lang: string) => (
      <>
        <button onClick={() => void navigator.clipboard?.writeText(code)} className="cursor-pointer rounded border border-border px-2 py-0.5 text-[0.7rem] text-muted hover:text-fg">Copy</button>
        {bridge && (!lang || /^(python|py|ipython|bash|sh)?$/i.test(lang)) && (
          <>
            <button onClick={() => bridge.insertCell({ position: bridge.selectedCellId() ? "after" : "end", refCellId: bridge.selectedCellId(), type: "code", source: code })} className="cursor-pointer rounded border border-border px-2 py-0.5 text-[0.7rem] text-muted hover:text-fg">Insert as new cell</button>
            {bridge.selectedCellId() && <button onClick={() => bridge.editCell(bridge.selectedCellId()!, code)} className="cursor-pointer rounded border border-border px-2 py-0.5 text-[0.7rem] text-muted hover:text-fg">Replace selected cell</button>}
          </>
        )}
      </>
    ),
    [bridge],
  );

  const err = models.error as ApiError | undefined;
  const busy = streamingTid !== null;

  return (
    <section aria-label="MangoLab AI assistant" className="flex h-full min-h-0 flex-col bg-bg">
      <header className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5">
        <Sparkles size={15} className="ml-1 text-accent" />
        <h2 className="mr-auto pl-1 text-sm font-semibold">MangoLab AI</h2>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="ghost" aria-label="Conversations" className="max-w-32 gap-1 px-2"><span className="truncate text-xs">{threads.data?.threads.find((t) => t.id === tid)?.title ?? "New chat"}</span><ChevronDown size={12} /></Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="max-h-80 w-72 overflow-y-auto">
            <DropdownMenuItem onSelect={newChat}><MessageSquarePlus size={14} /> New conversation</DropdownMenuItem>
            {(threads.data?.threads.length ?? 0) > 0 && <DropdownMenuSeparator />}
            {threads.data?.threads.map((t) => (
              <DropdownMenuItem key={t.id} onSelect={() => setChosen((c) => ({ ...c, [key]: t.id }))} className="justify-between">
                <span className={cn("truncate", t.id === tid && "font-medium")}>{t.title}</span>
                <button
                  aria-label={`Delete conversation ${t.title}`}
                  onClick={async (e) => {
                    e.stopPropagation();
                    await assistantApi.deleteThread(projectId, t.id).catch(() => undefined);
                    setChosen((c) => (c[key] === t.id ? { ...c, [key]: null } : c));
                    void threads.mutate();
                  }}
                  className="cursor-pointer rounded p-1 text-muted hover:text-danger"
                >
                  <Trash2 size={12} />
                </button>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button size="icon" variant="ghost" aria-label="New conversation" title="New conversation" onClick={newChat}><MessageSquarePlus size={15} /></Button>
        <Button size="icon" variant="ghost" aria-label="Close assistant" onClick={onClose}><X size={15} /></Button>
      </header>

      <div ref={scroller} className="min-h-0 flex-1 space-y-4 overflow-y-auto px-3 py-3" aria-live="polite">
        {err && (
          <div role="alert" className="rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm">
            {err.code === "assistant_off" ? "The assistant is turned off on this server." : err.message}
          </div>
        )}
        {!err && messages.length === 0 && tid !== null && loaded === undefined && <p className="text-sm text-muted">Loading…</p>}
        {!err && messages.length === 0 && (loaded !== undefined || tid === null) && (
          <div className="rounded-lg border border-dashed border-border p-4 text-sm text-muted">
            <p className="mb-2 font-medium text-fg">Ask about your notebook</p>
            <p>I can read your cells and their output, look at your files, explain errors and write or change code. Changes only happen when you press <strong>Apply</strong>.</p>
            {!path && <p className="mt-2">Open a notebook to let me see it.</p>}
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={m.role === "user" ? "flex justify-end" : undefined}>
            {m.role === "user" ? (
              <p className="max-w-[90%] whitespace-pre-wrap break-words rounded-2xl rounded-br-sm bg-accent/15 px-3 py-2 text-sm">{m.content}</p>
            ) : (
              <div className="space-y-2 text-sm">
                {m.tools.length > 0 && (
                  <ul className="flex flex-wrap gap-1.5" aria-label="What the assistant looked at">
                    {m.tools.map((t) => (
                      <li key={t.id} className={cn("flex items-center gap-1 rounded-full border px-2 py-0.5 text-[0.7rem]", t.status === "error" ? "border-danger/40 text-danger" : "border-border text-muted")}>
                        {t.status === "running" ? <Loader2 size={10} className="animate-spin" /> : <Wrench size={10} />} {t.summary}
                      </li>
                    ))}
                  </ul>
                )}
                {m.thinking && (
                  <details className="text-xs text-muted">
                    <summary className="cursor-pointer"><Brain size={11} className="mr-1 inline" /> Reasoning</summary>
                    <p className="mt-1 whitespace-pre-wrap">{m.thinking}</p>
                  </details>
                )}
                {m.content && <LabMarkdown text={m.content} projectId={projectId} dir="" codeActions={codeActions} />}
                {m.streaming && !m.content && !m.tools.length && <Waiting />}
                {m.actions.map((a) => (
                  <ActionCard key={a.id} action={a} cellSource={(id) => bridge?.cellSource(id) ?? null} canEdit={a.type === "install_packages" || !!bridge} busy={actionBusy === a.id}
                    error={actionError[a.id]} onApply={() => void decide(tid!, m.id, a, "apply")} onReject={() => void decide(tid!, m.id, a, "reject")} onUndo={() => void decide(tid!, m.id, a, "undo")} />
                ))}
                {m.trimmed && <p className="text-xs text-muted">This notebook is large, so I only saw part of it. Ask about a specific cell for more detail.</p>}
                {m.error && <p role="alert" className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs">{m.error}</p>}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="shrink-0 border-t border-border p-2">
        {path && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {quick.filter((q) => q.show).map((q) => (
              <button key={q.label} disabled={busy} onClick={() => void send(q.text, q.mode)} className={cn("cursor-pointer rounded-full border px-2.5 py-1 text-xs disabled:opacity-50", q.strong ? "border-accent/60 bg-accent/10 text-accent" : "border-border text-muted hover:text-fg")}>{q.label}</button>
            ))}
            <button disabled={busy} onClick={() => { setMode("generate"); input.current?.focus(); }} className={cn("cursor-pointer rounded-full border px-2.5 py-1 text-xs disabled:opacity-50", mode === "generate" ? "border-accent bg-accent/10 text-accent" : "border-border text-muted hover:text-fg")}>Write code…</button>
          </div>
        )}
        <div className="rounded-xl border border-border bg-surface focus-within:border-accent/60">
          <textarea
            ref={input}
            value={draft}
            rows={2}
            maxLength={8000}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send(draft, mode);
              }
            }}
            placeholder={mode === "generate" ? "Describe the code you want…" : "Ask about this notebook…"}
            aria-label="Message to the assistant"
            className="block max-h-40 w-full resize-none bg-transparent px-3 pt-2 text-sm outline-none placeholder:text-muted"
          />
          <div className="flex items-center gap-1 px-2 pb-1.5">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="ghost" aria-label="Choose model" className="max-w-40 gap-1 px-2 text-xs text-muted"><span className="truncate">{selectedModel?.name ?? "model"}</span><ChevronDown size={11} /></Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {models.data?.models.map((m) => (
                  <DropdownMenuItem key={m.name} onSelect={() => { setModel(m.name); lsSet("lab-ai-model", m.name); }} className="justify-between gap-3">
                    <span className={cn(m.name === selectedModel?.name && "font-medium")}>{m.name}</span>
                    <span className="text-xs text-muted">{m.size_gb} GB{m.tools ? "" : " · can't look around"}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            {selectedModel?.thinking && (
              <Button size="icon" variant="ghost" aria-pressed={think} aria-label="Think longer" title={think ? "Thinks before answering (slower). Click to turn off." : "Answers directly. Click to let it think first (slower, sometimes better)."} onClick={() => { setThink(!think); lsSet("lab-ai-think", think ? "0" : "1"); }} className={cn("h-7 w-7", think ? "text-accent" : "text-muted")}><Brain size={14} /></Button>
            )}
            <span className="flex-1" />
            {busy ? (
              <Button size="icon" variant="primary" onClick={stop} aria-label="Stop" title="Stop" className="h-8 w-8 rounded-full"><Square size={12} fill="currentColor" /></Button>
            ) : (
              <Button size="icon" variant="primary" onClick={() => void send(draft, mode)} disabled={!draft.trim() || !!err} aria-label="Send" title="Send (Enter)" className="h-8 w-8 rounded-full"><ArrowUp size={15} /></Button>
            )}
          </div>
        </div>
        <p className="mt-1.5 px-1 text-[0.68rem] leading-snug text-muted">AI can be wrong. It only sees what you show it, and nothing changes until you press Apply.</p>
      </div>
    </section>
  );
}
