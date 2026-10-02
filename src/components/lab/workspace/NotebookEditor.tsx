"use client";
import { AlertTriangle, Check, ChevronDown, CloudOff, Download, Eraser, History, Loader2, Play, Plus, Redo2, RefreshCw, RotateCcw, Square, Undo2, X } from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown";
import { filesApi } from "@/lib/lab/api";
import { dirOf } from "@/lib/lab/files";
import { fromNbformat } from "@/lib/lab/notebook";
import type { OpenedNotebook } from "@/lib/lab/types";
import { cn } from "@/lib/utils/cn";
import { createNotebookStore, type NotebookStore, type SaveState } from "@/stores/notebook";
import { CellView } from "./CellView";
import { HistoryDialog } from "./HistoryDialog";
import { useNotebookPersistence } from "./useNotebookPersistence";
import { useNotebookRun } from "./useNotebookRun";

const SAVE_LABEL: Record<SaveState, string> = { saved: "All changes saved", dirty: "Unsaved changes", saving: "Saving…", error: "Couldn’t save. Retrying…", conflict: "Changed elsewhere" };

function SaveStatus({ state }: { state: SaveState }) {
  const Icon = state === "saving" ? Loader2 : state === "saved" ? Check : state === "error" ? CloudOff : AlertTriangle;
  return (
    <span role="status" className={cn("flex items-center gap-1.5 text-xs", state === "saved" ? "text-muted" : state === "error" || state === "conflict" ? "text-danger" : "text-amber-600 dark:text-amber-400")}>
      <Icon size={13} className={state === "saving" ? "animate-spin" : undefined} /> {SAVE_LABEL[state]}
    </span>
  );
}

function AddBar({ onAdd }: { onAdd: (type: "code" | "markdown") => void }) {
  return (
    <div className="flex h-5 items-center justify-center gap-2 opacity-0 transition-opacity focus-within:opacity-100 hover:opacity-100">
      {(["code", "markdown"] as const).map((t) => (
        <button key={t} onClick={() => onAdd(t)} className="flex cursor-pointer items-center gap-1 rounded border border-border bg-bg px-2 py-0.5 text-[0.7rem] text-muted hover:text-fg">
          <Plus size={11} /> {t === "code" ? "Code" : "Text"}
        </button>
      ))}
    </div>
  );
}

interface Props {
  projectId: string;
  opened: OpenedNotebook;
  /** The workspace asks the editor to finish saving before a tab closes. */
  registerFlush: (path: string, flush: (() => Promise<void>) | null) => void;
  /** Open tabs stay mounted (so runs and unsaved edits survive a tab switch); only the visible one takes keyboard focus. */
  active: boolean;
}

export function NotebookEditor({ projectId, opened, registerFlush, active }: Props) {
  const [store] = useState<NotebookStore>(() => createNotebookStore({ doc: fromNbformat(opened.notebook), notebookId: opened.id, etag: opened.etag, version: opened.version }));
  const { save, reload, flush } = useNotebookPersistence(store, projectId, opened.path);
  const run = useNotebookRun(store, opened.path);
  const runStates = useStore(store, (s) => s.run);
  const lastRuns = useStore(store, (s) => s.lastRun);
  const kernel = useStore(store, (s) => s.kernel);
  const runningCount = useStore(store, (s) => Object.values(s.run).reduce((n, r) => n + (r.running ? 1 : 0), 0));
  const queuedCount = useStore(store, (s) => Object.values(s.run).reduce((n, r) => n + r.queued.length, 0));
  const [confirmRestart, setConfirmRestart] = useState<"restart" | "restartRun" | null>(null);
  const cells = useStore(store, (s) => s.doc.cells);
  const selected = useStore(store, (s) => s.selected);
  const editing = useStore(store, (s) => s.editing);
  const mounted = useStore(store, (s) => s.mounted);
  const saveState = useStore(store, (s) => s.saveState);
  const canUndo = useStore(store, (s) => s.undo.length > 0);
  const canRedo = useStore(store, (s) => s.redo.length > 0);
  const meta = useStore(store, (s) => s.doc.metadata);
  const [history, setHistory] = useState(false);
  const [reloadError, setReloadError] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);
  const lastKey = useRef<{ k: string; t: number }>({ k: "", t: 0 });
  const act = store.getState();
  const dir = dirOf(opened.path);
  const language = useMemo(() => ((meta.language_info as { name?: string } | undefined)?.name ?? (meta.kernelspec as { language?: string } | undefined)?.language ?? "python"), [meta]);

  useEffect(() => {
    registerFlush(opened.path, flush);
    return () => registerFlush(opened.path, null);
  }, [registerFlush, opened.path, flush]);

  // Keep the selected cell in view; in command mode keep keyboard focus on the notebook so shortcuts work.
  useEffect(() => {
    if (selected) document.getElementById(`cell-${selected}`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  useEffect(() => {
    if (active && !editing) boxRef.current?.focus({ preventScroll: true });
  }, [editing, selected, active]);

  /** Run a cell (code) or finish editing it (text), then stay, move on or add a cell below. */
  const handleRun = useCallback(
    (id: string, mode: "next" | "stay" | "insert") => {
      const s = store.getState();
      const i = s.doc.cells.findIndex((c) => c.id === id);
      if (i < 0) return;
      const cell = s.doc.cells[i]!;
      if (cell.type === "code") void run.runCells([id]);
      if (mode === "stay") {
        if (cell.type !== "code") s.select(id, false);
      } else if (mode === "insert") s.insertCell(i + 1, "code");
      else if (i < s.doc.cells.length - 1) s.select(s.doc.cells[i + 1]!.id, s.doc.cells[i + 1]!.type === "code");
      else s.insertCell(s.doc.cells.length, "code");
    },
    [store, run],
  );
  const escape = useCallback(() => store.getState().setEditing(false), [store]);
  const doSave = useCallback(() => void save(true), [save]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (t.closest(".monaco-editor, input, textarea, select, [role=dialog]")) return;
    const s = store.getState();
    const i = s.doc.cells.findIndex((c) => c.id === s.selected);
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key;
    if (mod && k.toLowerCase() === "s") return e.preventDefault(), doSave();
    if (mod && k.toLowerCase() === "z") return e.preventDefault(), e.shiftKey ? s.redoStructure() : s.undoStructure();
    if (mod && k.toLowerCase() === "y") return e.preventDefault(), s.redoStructure();
    if (k === "Enter" && s.selected && (e.shiftKey || mod || e.altKey)) return e.preventDefault(), handleRun(s.selected, e.shiftKey ? "next" : mod ? "stay" : "insert");
    if (mod || e.altKey && !["ArrowUp", "ArrowDown"].includes(k)) return;
    if (e.altKey && k === "ArrowUp" && s.selected) return e.preventDefault(), s.moveCell(s.selected, -1);
    if (e.altKey && k === "ArrowDown" && s.selected) return e.preventDefault(), s.moveCell(s.selected, 1);
    if (k === "Enter" && s.selected) return e.preventDefault(), s.select(s.selected, true);
    if (k === "ArrowUp" || k === "k") return e.preventDefault(), s.select(s.doc.cells[Math.max(0, i - 1)]?.id ?? null);
    if (k === "ArrowDown" || k === "j") return e.preventDefault(), s.select(s.doc.cells[Math.min(s.doc.cells.length - 1, i + 1)]?.id ?? null);
    if (k === "a") return e.preventDefault(), s.insertCell(Math.max(i, 0));
    if (k === "b") return e.preventDefault(), s.insertCell(i + 1);
    if (k === "m" && s.selected) return e.preventDefault(), s.changeType(s.selected, "markdown");
    if (k === "y" && s.selected) return e.preventDefault(), s.changeType(s.selected, "code");
    if (k === "z") return e.preventDefault(), s.undoStructure();
    if (k === "i") {
      const now = Date.now();
      e.preventDefault();
      if (lastKey.current.k === "i" && now - lastKey.current.t < 600) {
        run.interrupt();
        lastKey.current = { k: "", t: 0 };
      } else lastKey.current = { k: "i", t: now };
      return;
    }
    if (k === "d" && s.selected) {
      const now = Date.now();
      if (lastKey.current.k === "d" && now - lastKey.current.t < 600) {
        e.preventDefault();
        s.deleteCell(s.selected);
        lastKey.current = { k: "", t: 0 };
      } else lastKey.current = { k: "d", t: now };
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-1 border-b border-border px-3 py-1.5" role="toolbar" aria-label="Notebook toolbar">
        <Button size="sm" variant="ghost" onClick={() => act.insertBelowSelected("code")}>
          <Plus size={14} /> Code
        </Button>
        <Button size="sm" variant="ghost" onClick={() => act.insertBelowSelected("markdown")}>
          <Plus size={14} /> Text
        </Button>
        <span className="mx-1 h-5 w-px bg-border" />
        <Button size="icon" variant="ghost" title="Undo cell change (Z)" aria-label="Undo cell change" disabled={!canUndo} onClick={() => act.undoStructure()}>
          <Undo2 size={15} />
        </Button>
        <Button size="icon" variant="ghost" title="Redo (Shift+Z)" aria-label="Redo cell change" disabled={!canRedo} onClick={() => act.redoStructure()}>
          <Redo2 size={15} />
        </Button>
        <Button size="icon" variant="ghost" title="Clear all outputs" aria-label="Clear all outputs" onClick={() => act.clearOutputs()}>
          <Eraser size={15} />
        </Button>
        <Button size="icon" variant="ghost" title="Version history" aria-label="Version history" onClick={() => setHistory(true)}>
          <History size={15} />
        </Button>
        <a href={filesApi.downloadUrl(projectId, opened.path)} download title="Download .ipynb" aria-label="Download notebook" className="inline-flex h-8 w-8 items-center justify-center rounded-md hover:bg-surface-2">
          <Download size={15} />
        </a>
        <span className="mx-1 h-5 w-px bg-border" />
        <Button size="sm" variant="ghost" onClick={() => void run.runAll()} title="Run every cell from the top">
          <Play size={14} /> Run all
        </Button>
        {runningCount + queuedCount > 0 && (
          <Button size="sm" variant="outline" onClick={run.interrupt} title="Stop the running cell (press I twice)">
            <Square size={12} fill="currentColor" /> Stop
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="ghost" aria-label="Runtime menu">
              Runtime <ChevronDown size={13} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onSelect={() => void run.runAll()}>Run all</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => selected && void run.runRange(selected, "above")}>Run cells above</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => selected && void run.runRange(selected, "below")}>Run selected cell and below</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={run.interrupt}>Interrupt</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setConfirmRestart("restart")}>Restart kernel…</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setConfirmRestart("restartRun")}>Restart and run all…</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <span className="ml-1 text-xs text-muted" role="status" aria-label="Kernel status">
          {runningCount + queuedCount > 0
            ? `${runningCount ? "Running" : "Waiting"}${queuedCount ? ` · ${queuedCount} waiting` : ""}`
            : kernel === "restarting" || kernel === "starting"
              ? "Kernel starting…"
              : kernel === "dead"
                ? "Kernel stopped"
                : kernel === "idle"
                  ? "Kernel ready"
                  : ""}
        </span>
        <div className="ml-auto flex items-center gap-3">
          <SaveStatus state={saveState} />
          <Button size="sm" variant="outline" onClick={doSave} disabled={saveState === "saved" || saveState === "saving"} title="Save (Ctrl+S)">
            Save
          </Button>
        </div>
      </div>

      {run.error && (
        <div role="alert" className="flex items-center gap-3 border-b border-danger/40 bg-danger/10 px-4 py-2 text-sm">
          <AlertTriangle size={15} className="shrink-0 text-danger" />
          <span className="flex-1">{run.error}</span>
          <button aria-label="Dismiss" onClick={run.clearError} className="cursor-pointer rounded p-1 hover:bg-surface-2">
            <X size={14} />
          </button>
        </div>
      )}
      {kernel === "dead" && (
        <div role="alert" className="flex items-center gap-3 border-b border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm">
          <span className="flex-1">The kernel stopped. Restart it to run cells again.</span>
          <Button size="sm" variant="outline" onClick={run.restart}>
            <RefreshCw size={13} /> Restart kernel
          </Button>
        </div>
      )}
      {saveState === "conflict" && (
        <div role="alert" className="flex flex-wrap items-center gap-3 border-b border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm">
          <AlertTriangle size={15} className="shrink-0 text-amber-500" />
          <span className="flex-1">This notebook was changed somewhere else (another tab, an upload or the terminal). Your edits are still here.</span>
          {reloadError && <span className="text-danger">{reloadError}</span>}
          <Button size="sm" variant="outline" onClick={() => reload().catch((e: Error) => setReloadError(e.message))}>
            <RotateCcw size={13} /> Load the other version
          </Button>
          <Button size="sm" variant="primary" onClick={() => void save(true)}>
            Keep my version
          </Button>
        </div>
      )}

      <div ref={boxRef} tabIndex={0} onKeyDown={onKeyDown} aria-label="Notebook cells" className="min-h-0 flex-1 overflow-y-auto px-3 py-4 outline-none sm:px-6">
        <div className="mx-auto max-w-5xl">
          {cells.map((cell, i) => (
            <Fragment key={cell.id}>
              <AddBar onAdd={(t) => act.insertCell(i, t)} />
              <CellView
                cell={cell}
                index={i}
                count={cells.length}
                projectId={projectId}
                dir={dir}
                language={language}
                selected={selected === cell.id}
                editing={editing}
                liveEditor={mounted.includes(cell.id)}
                onSelect={act.select}
                onSource={act.setSource}
                onRun={handleRun}
                onInterrupt={run.interrupt}
                run={runStates[cell.id]}
                lastRun={lastRuns[cell.id]}
                onEscape={escape}
                onSave={doSave}
                onMove={act.moveCell}
                onDuplicate={act.duplicateCell}
                onDelete={act.deleteCell}
                onChangeType={act.changeType}
                onClearOutputs={act.clearOutputs}
              />
            </Fragment>
          ))}
          <AddBar onAdd={(t) => act.insertCell(cells.length, t)} />
          {cells.length === 0 && (
            <div className="rounded-lg border border-dashed border-border p-10 text-center">
              <p className="mb-3 text-sm text-muted">This notebook is empty.</p>
              <Button variant="primary" onClick={() => act.insertCell(0, "code")}>
                <Plus size={15} /> Add a code cell
              </Button>
            </div>
          )}
          <div className="h-40" aria-hidden />
        </div>
      </div>

      <Dialog open={confirmRestart !== null} onOpenChange={(v) => !v && setConfirmRestart(null)}>
        <DialogContent title={confirmRestart === "restartRun" ? "Restart the kernel and run everything?" : "Restart the kernel?"} description="Variables and imports in this notebook are cleared. Cells that are running stop. Your files and the notebook itself stay.">
          <div className="flex justify-end gap-2">
            <DialogClose asChild>
              <Button variant="ghost">Cancel</Button>
            </DialogClose>
            <Button
              variant="primary"
              onClick={() => {
                const mode = confirmRestart;
                setConfirmRestart(null);
                if (mode === "restartRun") void run.restartAndRunAll();
                else run.restart();
              }}
            >
              {confirmRestart === "restartRun" ? "Restart and run all" : "Restart"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <HistoryDialog
        projectId={projectId}
        path={opened.path}
        open={history}
        onOpenChange={setHistory}
        onRestored={(nb) => store.getState().replaceDoc(fromNbformat(nb.notebook), nb.etag, nb.version)}
      />
    </div>
  );
}
