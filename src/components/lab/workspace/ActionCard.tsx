"use client";
import { Check, FilePlus2, Package, Pencil, Play, Undo2, X } from "lucide-react";
import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { diffLines } from "@/lib/lab/diff";
import type { AssistantAction } from "@/lib/lab/types";
import { cn } from "@/lib/utils/cn";

function Diff({ oldText, newText }: { oldText: string; newText: string }) {
  const lines = useMemo(() => diffLines(oldText, newText), [oldText, newText]);
  return (
    <pre className="m-0 max-h-56 overflow-auto rounded border border-border bg-[var(--code-bg)] p-0 font-mono text-xs leading-relaxed" aria-label="Proposed change">
      {lines.map((l, i) => (
        <div key={i} className={cn("whitespace-pre-wrap break-words px-2", l.kind === "add" && "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300", l.kind === "del" && "bg-danger/15 text-danger line-through decoration-danger/40")}>
          <span className="mr-2 select-none opacity-60">{l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}</span>
          {l.text || " "}
        </div>
      ))}
    </pre>
  );
}

interface Props {
  action: AssistantAction;
  /** Current source of a cell in the open notebook (null if gone), to warn when it changed since the suggestion. */
  cellSource: (id: string) => string | null;
  canEdit: boolean;
  busy: boolean;
  error?: string;
  onApply: () => void;
  onReject: () => void;
  onUndo: () => void;
}

/** A change the assistant proposes. Nothing happens until the person presses Apply. */
export function ActionCard({ action, cellSource, canEdit, busy, error, onApply, onReject, onUndo }: Props) {
  let title: string;
  let Icon = Pencil;
  let body: React.ReactNode = null;
  let note = "";
  let undoable = false;
  if (action.type === "edit_cell") {
    title = `Change cell [${action.payload.cell_number}]`;
    const cur = cellSource(action.payload.cell_id);
    if (cur === null) note = "That cell no longer exists.";
    else if (action.status === "proposed" && cur !== action.payload.old_source) note = "This cell has changed since the suggestion was made.";
    body = <Diff oldText={action.payload.old_source} newText={action.payload.source} />;
    undoable = true;
  } else if (action.type === "insert_cell") {
    Icon = FilePlus2;
    const where = action.payload.position === "end" ? "at the end" : `${action.payload.position} cell [${action.payload.ref_cell_number}]`;
    title = `New ${action.payload.cell_type === "code" ? "code" : "text"} cell ${where}`;
    body = <Diff oldText="" newText={action.payload.source} />;
    undoable = true;
  } else if (action.type === "run_cell") {
    Icon = Play;
    title = `Run cell [${action.payload.cell_number}]`;
  } else {
    Icon = Package;
    title = `Install ${action.payload.specs.join(", ")}`;
    body = <p className="text-xs text-muted">Installs into this project only. You can follow it in the Packages panel.</p>;
  }
  const gone = action.type === "edit_cell" && cellSource(action.payload.cell_id) === null;
  return (
    <div className={cn("rounded-lg border bg-bg", action.status === "proposed" ? "border-accent/40" : "border-border")} role="group" aria-label={title}>
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-xs font-medium">
        <Icon size={13} className="text-accent" /> <span className="min-w-0 flex-1 truncate">{title}</span>
        {action.status === "applied" && <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400"><Check size={12} /> Applied</span>}
        {action.status === "rejected" && <span className="text-muted">Dismissed</span>}
      </div>
      {body && <div className="p-2">{body}</div>}
      {(note || error) && <p role={error ? "alert" : "status"} className={cn("px-3 pb-1 text-xs", error ? "text-danger" : "text-amber-600 dark:text-amber-400")}>{error || note}</p>}
      <div className="flex flex-wrap items-center gap-2 px-3 pb-2 pt-1">
        {action.status === "proposed" && (
          <>
            <Button size="sm" variant="primary" onClick={onApply} disabled={busy || !canEdit || gone}>{note.includes("changed") ? "Apply anyway" : action.type === "run_cell" ? "Run" : action.type === "install_packages" ? "Install" : "Apply"}</Button>
            <Button size="sm" variant="ghost" onClick={onReject} disabled={busy}><X size={13} /> Dismiss</Button>
            {!canEdit && action.type !== "install_packages" && <span className="text-xs text-muted">Open the notebook to apply this.</span>}
          </>
        )}
        {action.status === "applied" && undoable && (
          <Button size="sm" variant="outline" onClick={onUndo} disabled={busy || !canEdit}><Undo2 size={13} /> Undo</Button>
        )}
        {action.status === "rejected" && <Button size="sm" variant="ghost" onClick={onUndo} disabled={busy}>Bring back</Button>}
      </div>
    </div>
  );
}
