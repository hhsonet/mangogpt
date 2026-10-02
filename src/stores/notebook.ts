import { createStore } from "zustand";
import { newCell, withType, type Cell, type CellType, type NotebookDoc } from "@/lib/lab/notebook";
import { mergeOutput, replaceDisplay } from "@/lib/lab/outputs";
import type { ExecState, KernelState, LabEvent } from "@/lib/lab/types";

export type SaveState = "saved" | "dirty" | "saving" | "error" | "conflict";
const MAX_UNDO = 50;
const MAX_MOUNTED_EDITORS = 6; // Monaco instances are heavy: only the most recently used cells keep a live editor

/** Where a cell is in the run queue. Placeholder ids (`local:n`) stand in until the server reports the real message id. */
export interface RunState {
  queued: string[];
  running: string | null;
}
export interface LastRun {
  state: ExecState;
  ms: number | null;
}
const EMPTY_RUN: RunState = { queued: [], running: null };
let localSeq = 0;

export interface NotebookState {
  doc: NotebookDoc;
  notebookId: string;
  etag: string;
  version: number;
  rev: number; // bumped on every change, so a save that finishes late can tell whether new edits happened meanwhile
  selected: string | null;
  editing: boolean;
  mounted: string[];
  saveState: SaveState;
  saveError: string | null;
  savedAt: string | null;
  undo: Cell[][];
  redo: Cell[][];
  run: Record<string, RunState>;
  lastRun: Record<string, LastRun>;
  kernel: KernelState;
  // actions
  markQueued: (cellIds: string[]) => void;
  unqueue: (cellId: string) => void;
  applyEvent: (e: LabEvent) => { ack: string[] } | void;
  runtimeGone: () => void;
  select: (id: string | null, edit?: boolean) => void;
  setEditing: (v: boolean) => void;
  setSource: (id: string, source: string) => void;
  insertCell: (index: number, type?: CellType, source?: string) => string;
  insertBelowSelected: (type?: CellType) => string;
  deleteCell: (id: string) => void;
  moveCell: (id: string, delta: -1 | 1) => void;
  duplicateCell: (id: string) => void;
  changeType: (id: string, type: CellType) => void;
  clearOutputs: (id?: string) => void;
  undoStructure: () => void;
  redoStructure: () => void;
  replaceDoc: (doc: NotebookDoc, etag: string, version: number) => void;
  markSaving: () => number;
  markSaved: (rev: number, etag: string, version: number, savedAt: string) => void;
  markSaveFailed: (kind: "error" | "conflict", message: string) => void;
}

export function createNotebookStore(init: { doc: NotebookDoc; notebookId: string; etag: string; version: number }) {
  return createStore<NotebookState>()((set, get) => {
    /** Apply a structural change to the cell list, remembering the previous list for undo. */
    const structural = (fn: (cells: Cell[]) => Cell[]) =>
      set((s) => {
        const cells = fn(s.doc.cells);
        if (cells === s.doc.cells) return s;
        return { doc: { ...s.doc, cells }, undo: [...s.undo, s.doc.cells].slice(-MAX_UNDO), redo: [], rev: s.rev + 1, saveState: "dirty" };
      });
    const touch = (mounted: string[], id: string) => [id, ...mounted.filter((m) => m !== id)].slice(0, MAX_MOUNTED_EDITORS);

    return {
      doc: init.doc,
      notebookId: init.notebookId,
      etag: init.etag,
      version: init.version,
      rev: 0,
      selected: init.doc.cells[0]?.id ?? null,
      editing: false,
      mounted: init.doc.cells[0] ? [init.doc.cells[0].id] : [],
      saveState: "saved",
      saveError: null,
      savedAt: null,
      undo: [],
      redo: [],
      run: {},
      lastRun: {},
      kernel: "none",

      markQueued: (ids) =>
        set((s) => {
          const run = { ...s.run };
          for (const id of ids) {
            const cur = run[id] ?? EMPTY_RUN;
            run[id] = { ...cur, queued: [...cur.queued, `local:${++localSeq}`] };
          }
          return { run };
        }),
      unqueue: (id) =>
        set((s) => {
          const cur = s.run[id];
          if (!cur) return s;
          const i = cur.queued.findIndex((m) => m.startsWith("local:"));
          return i < 0 ? s : { run: { ...s.run, [id]: { ...cur, queued: cur.queued.filter((_, j) => j !== i) } } };
        }),
      runtimeGone: () => set({ run: {}, kernel: "none" }),
      applyEvent: (e) => {
        const dirty = (s: NotebookState) => ({ rev: s.rev + 1, saveState: "dirty" as const });
        const patchCell = (s: NotebookState, id: string, fn: (c: Cell) => Cell): Partial<NotebookState> | null => {
          const i = s.doc.cells.findIndex((c) => c.id === id);
          if (i < 0 || s.doc.cells[i]!.type !== "code") return null;
          const cells = s.doc.cells.slice();
          cells[i] = fn(cells[i]!);
          return { doc: { ...s.doc, cells }, ...dirty(s) };
        };
        const withRun = (s: NotebookState, id: string, fn: (r: RunState) => RunState) => ({ run: { ...s.run, [id]: fn(s.run[id] ?? EMPTY_RUN) } });
        switch (e.type) {
          case "kernel":
            set({ kernel: e.state });
            return;
          case "runtime":
            if (e.status === "none") get().runtimeGone();
            return;
          case "error":
            if (e.cell_id) get().unqueue(e.cell_id);
            return;
          case "snapshot": {
            set((s) => {
              let next: Partial<NotebookState> = { kernel: e.kernel };
              let cur = s;
              const ids = new Set(e.executions.map((x) => x.msg_id));
              const run: Record<string, RunState> = {};
              for (const [cid, r] of Object.entries(s.run)) {
                // keep placeholders (just requested) and anything the server still knows about; forget the rest (it finished while we were away)
                run[cid] = { queued: r.queued.filter((m) => m.startsWith("local:") || ids.has(m)), running: r.running && ids.has(r.running) ? r.running : null };
              }
              const lastRun = { ...s.lastRun };
              for (const x of e.executions) {
                const patch = patchCell(cur, x.cell_id, (c) => ({ ...c, outputs: x.outputs, executionCount: x.execution_count ?? c.executionCount }));
                if (patch) cur = { ...cur, ...patch };
                const r = run[x.cell_id] ?? { queued: [], running: null };
                if (x.state === "queued") run[x.cell_id] = { ...r, queued: r.queued.includes(x.msg_id) ? r.queued : [...r.queued, x.msg_id] };
                else if (x.state === "running") run[x.cell_id] = { queued: r.queued.filter((m) => m !== x.msg_id), running: x.msg_id };
                else {
                  run[x.cell_id] = { queued: r.queued.filter((m) => m !== x.msg_id), running: r.running === x.msg_id ? null : r.running };
                  lastRun[x.cell_id] = { state: x.state, ms: null };
                }
              }
              next = { ...next, run, lastRun, ...(cur !== s ? { doc: cur.doc, rev: cur.rev, saveState: cur.saveState } : {}) };
              return next;
            });
            return { ack: e.executions.filter((x) => x.state !== "queued" && x.state !== "running").map((x) => x.msg_id) };
          }
          case "exec": {
            const terminal = e.state !== "queued" && e.state !== "running";
            set((s) => {
              let patch: Partial<NotebookState> = {};
              if (e.state === "queued") {
                patch = withRun(s, e.cell_id, (r) => {
                  if (r.queued.includes(e.msg_id)) return r;
                  const i = r.queued.findIndex((m) => m.startsWith("local:"));
                  return { ...r, queued: i >= 0 ? r.queued.map((m, j) => (j === i ? e.msg_id : m)) : [...r.queued, e.msg_id] };
                });
              } else if (e.state === "running") {
                const first = (s.run[e.cell_id]?.running ?? null) !== e.msg_id;
                patch = withRun(s, e.cell_id, (r) => ({ queued: r.queued.filter((m) => m !== e.msg_id), running: e.msg_id }));
                if (first) {
                  // like Jupyter, the old output goes away when the new run starts
                  const c = patchCell(s, e.cell_id, (cell) => ({ ...cell, outputs: [], executionCount: e.execution_count ?? null }));
                  if (c) patch = { ...patch, ...c };
                  patch = { ...patch, lastRun: Object.fromEntries(Object.entries(s.lastRun).filter(([k]) => k !== e.cell_id)) };
                } else if (e.execution_count != null) {
                  const c = patchCell(s, e.cell_id, (cell) => ({ ...cell, executionCount: e.execution_count ?? null }));
                  if (c) patch = { ...patch, ...c };
                }
              } else {
                patch = withRun(s, e.cell_id, (r) => ({ queued: r.queued.filter((m) => m !== e.msg_id), running: r.running === e.msg_id ? null : r.running }));
                patch = { ...patch, lastRun: { ...s.lastRun, [e.cell_id]: { state: e.state, ms: e.duration_ms ?? null } } };
                if (e.execution_count != null) {
                  const c = patchCell(s, e.cell_id, (cell) => ({ ...cell, executionCount: e.execution_count ?? null }));
                  if (c) patch = { ...patch, ...c };
                }
              }
              return patch;
            });
            return terminal ? { ack: [e.msg_id] } : undefined;
          }
          case "output":
            set((s) => patchCell(s, e.cell_id, (c) => ({ ...c, outputs: mergeOutput(c.outputs, e.output) })) ?? s);
            return;
          case "clear_output":
            set((s) => patchCell(s, e.cell_id, (c) => ({ ...c, outputs: [] })) ?? s);
            return;
          case "update_display":
            set((s) => patchCell(s, e.cell_id, (c) => ({ ...c, outputs: replaceDisplay(c.outputs, e.index, e.data, e.metadata) })) ?? s);
            return;
        }
      },

      select: (id, edit = false) => set((s) => ({ selected: id, editing: edit && id !== null, mounted: id ? touch(s.mounted, id) : s.mounted })),
      setEditing: (v) => set({ editing: v }),
      setSource: (id, source) =>
        set((s) => {
          const i = s.doc.cells.findIndex((c) => c.id === id);
          if (i < 0 || s.doc.cells[i]!.source === source) return s;
          const cells = s.doc.cells.slice();
          cells[i] = { ...cells[i]!, source };
          return { doc: { ...s.doc, cells }, rev: s.rev + 1, saveState: "dirty" };
        }),
      insertCell: (index, type = "code", source = "") => {
        const cell = newCell(type, source);
        structural((cells) => [...cells.slice(0, index), cell, ...cells.slice(index)]);
        set((s) => ({ selected: cell.id, editing: true, mounted: touch(s.mounted, cell.id) }));
        return cell.id;
      },
      insertBelowSelected: (type = "code") => {
        const { doc, selected } = get();
        const i = doc.cells.findIndex((c) => c.id === selected);
        return get().insertCell(i < 0 ? doc.cells.length : i + 1, type);
      },
      deleteCell: (id) => {
        const { doc } = get();
        const i = doc.cells.findIndex((c) => c.id === id);
        if (i < 0) return;
        structural((cells) => cells.filter((c) => c.id !== id));
        const next = get().doc.cells[Math.min(i, get().doc.cells.length - 1)]?.id ?? null;
        set({ selected: next, editing: false });
      },
      moveCell: (id, delta) =>
        structural((cells) => {
          const i = cells.findIndex((c) => c.id === id);
          const j = i + delta;
          if (i < 0 || j < 0 || j >= cells.length) return cells;
          const out = cells.slice();
          [out[i], out[j]] = [out[j]!, out[i]!];
          return out;
        }),
      duplicateCell: (id) => {
        const copy = { ...newCell("code"), ...get().doc.cells.find((c) => c.id === id)! };
        const dup: Cell = { ...copy, id: newCell().id, outputs: [], executionCount: null };
        structural((cells) => {
          const i = cells.findIndex((c) => c.id === id);
          return [...cells.slice(0, i + 1), dup, ...cells.slice(i + 1)];
        });
        set((s) => ({ selected: dup.id, mounted: touch(s.mounted, dup.id) }));
      },
      changeType: (id, type) => structural((cells) => cells.map((c) => (c.id === id ? withType(c, type) : c))),
      clearOutputs: (id) => structural((cells) => cells.map((c) => (c.type === "code" && (!id || c.id === id) && (c.outputs.length || c.executionCount !== null) ? { ...c, outputs: [], executionCount: null } : c))),
      undoStructure: () =>
        set((s) => {
          const prev = s.undo[s.undo.length - 1];
          if (!prev) return s;
          return { doc: { ...s.doc, cells: prev }, undo: s.undo.slice(0, -1), redo: [...s.redo, s.doc.cells], rev: s.rev + 1, saveState: "dirty", selected: prev.some((c) => c.id === s.selected) ? s.selected : (prev[0]?.id ?? null) };
        }),
      redoStructure: () =>
        set((s) => {
          const next = s.redo[s.redo.length - 1];
          if (!next) return s;
          return { doc: { ...s.doc, cells: next }, redo: s.redo.slice(0, -1), undo: [...s.undo, s.doc.cells], rev: s.rev + 1, saveState: "dirty" };
        }),
      replaceDoc: (doc, etag, version) => set({ doc, etag, version, rev: get().rev + 1, undo: [], redo: [], saveState: "saved", saveError: null, selected: doc.cells[0]?.id ?? null, editing: false, mounted: doc.cells[0] ? [doc.cells[0].id] : [] }),
      markSaving: () => {
        set({ saveState: "saving", saveError: null });
        return get().rev;
      },
      markSaved: (rev, etag, version, savedAt) => set((s) => ({ etag, version, savedAt, saveError: null, saveState: s.rev === rev ? "saved" : "dirty" })),
      markSaveFailed: (kind, message) => set({ saveState: kind, saveError: message }),
    };
  });
}

export type NotebookStore = ReturnType<typeof createNotebookStore>;
