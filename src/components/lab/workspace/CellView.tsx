"use client";
import hljs from "highlight.js/lib/core";
import python from "highlight.js/lib/languages/python";
import { ArrowDown, ArrowUp, Copy, Eraser, Play, Trash2 } from "lucide-react";
import { memo } from "react";
import { cn } from "@/lib/utils/cn";
import type { Cell, CellType } from "@/lib/lab/notebook";
import { CodeEditor } from "./CodeEditor";
import { LabMarkdown } from "./LabMarkdown";
import { OutputView } from "./OutputView";

hljs.registerLanguage("python", python);

function Highlighted({ code, language }: { code: string; language: string }) {
  if (!code) return <span className="text-muted">Empty cell. Click to type.</span>;
  const html = hljs.getLanguage(language) ? hljs.highlight(code, { language }).value : code.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
  return <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />; // highlight.js escapes the code itself
}

interface Props {
  cell: Cell;
  index: number;
  count: number;
  projectId: string;
  dir: string;
  language: string;
  selected: boolean;
  editing: boolean;
  liveEditor: boolean;
  onSelect: (id: string, edit?: boolean) => void;
  onSource: (id: string, v: string) => void;
  onShiftEnter: () => void;
  onEscape: () => void;
  onSave: () => void;
  onMove: (id: string, d: -1 | 1) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
  onChangeType: (id: string, t: CellType) => void;
  onClearOutputs: (id: string) => void;
}

function IconBtn({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      title={label}
      aria-label={label}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()} // keep focus where it is
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="flex h-7 w-7 cursor-pointer items-center justify-center rounded text-muted hover:bg-surface-2 hover:text-fg disabled:cursor-default disabled:opacity-40"
    >
      {children}
    </button>
  );
}

export const CellView = memo(function CellView(p: Props) {
  const { cell } = p;
  const isCode = cell.type === "code";
  // Code/raw cells keep a live Monaco while among the most recently used; Markdown cells show it only while being edited.
  const showEditor = cell.type === "markdown" ? p.selected && p.editing : p.liveEditor;
  const editorLang = isCode ? p.language : cell.type === "markdown" ? "markdown" : "plaintext";

  return (
    <div
      id={`cell-${cell.id}`}
      data-cell-id={cell.id}
      onClick={() => p.onSelect(cell.id, false)}
      className={cn("group/cell relative flex gap-2 rounded-lg border bg-surface/40 transition-colors", p.selected ? (p.editing ? "border-accent" : "border-accent/50") : "border-transparent hover:border-border")}
    >
      <div className="flex w-14 shrink-0 flex-col items-center gap-1 pt-2 text-xs text-muted">
        {isCode ? (
          <>
            <button
              title="Run cell (available in the next build step)"
              aria-label="Run cell (not available yet)"
              disabled
              className="flex h-8 w-8 items-center justify-center rounded-full border border-border opacity-50"
            >
              <Play size={14} />
            </button>
            <span className="font-mono" aria-label="Execution count">[{cell.executionCount ?? " "}]</span>
          </>
        ) : (
          <span className="mt-1 rounded border border-border px-1 text-[0.6rem] uppercase tracking-wide">{cell.type === "markdown" ? "text" : "raw"}</span>
        )}
      </div>

      <div className="min-w-0 flex-1 py-1 pr-2">
        {p.selected && (
          <div className="mb-1 flex flex-wrap items-center justify-end gap-0.5" role="toolbar" aria-label="Cell actions">
            <div className="mr-1 flex overflow-hidden rounded border border-border text-xs" role="radiogroup" aria-label="Cell type">
              {(["code", "markdown"] as const).map((t) => (
                <button
                  key={t}
                  role="radio"
                  aria-checked={cell.type === t}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={(e) => {
                    e.stopPropagation();
                    p.onChangeType(cell.id, t);
                  }}
                  className={cn("cursor-pointer px-2 py-0.5", cell.type === t ? "bg-surface-2 font-medium" : "text-muted hover:text-fg")}
                >
                  {t === "code" ? "Code" : "Text"}
                </button>
              ))}
            </div>
            <IconBtn label="Move up" onClick={() => p.onMove(cell.id, -1)} disabled={p.index === 0}>
              <ArrowUp size={14} />
            </IconBtn>
            <IconBtn label="Move down" onClick={() => p.onMove(cell.id, 1)} disabled={p.index === p.count - 1}>
              <ArrowDown size={14} />
            </IconBtn>
            <IconBtn label="Duplicate cell" onClick={() => p.onDuplicate(cell.id)}>
              <Copy size={14} />
            </IconBtn>
            {isCode && (
              <IconBtn label="Clear output" onClick={() => p.onClearOutputs(cell.id)} disabled={!cell.outputs.length && cell.executionCount === null}>
                <Eraser size={14} />
              </IconBtn>
            )}
            <IconBtn label="Delete cell" onClick={() => p.onDelete(cell.id)}>
              <Trash2 size={14} />
            </IconBtn>
          </div>
        )}

        <div className="overflow-hidden rounded-md border border-border bg-[var(--code-bg)]" onDoubleClick={() => !isCode && p.onSelect(cell.id, true)}>
          {showEditor ? (
            <CodeEditor value={cell.source} language={editorLang} wordWrap={cell.type === "markdown"} focused={p.selected && p.editing} onChange={(v) => p.onSource(cell.id, v)} onSave={p.onSave} onShiftEnter={p.onShiftEnter} onEscape={p.onEscape} />
          ) : cell.type === "markdown" ? (
            <div className="cursor-text bg-bg px-4 py-2" onDoubleClick={() => p.onSelect(cell.id, true)}>
              {cell.source.trim() ? <LabMarkdown text={cell.source} projectId={p.projectId} dir={p.dir} /> : <span className="text-sm text-muted">Empty text cell. Double-click to edit.</span>}
            </div>
          ) : (
            <pre
              className="m-0 min-h-12 cursor-text overflow-x-auto px-3 py-2 font-mono text-[0.8125rem] leading-[1.55]"
              onClick={(e) => {
                e.stopPropagation();
                p.onSelect(cell.id, true);
              }}
            >
              <Highlighted code={cell.source} language={editorLang} />
            </pre>
          )}
          {isCode && <OutputView outputs={cell.outputs} projectId={p.projectId} dir={p.dir} />}
        </div>
      </div>
    </div>
  );
});
