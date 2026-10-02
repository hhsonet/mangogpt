import { createStore } from "zustand";
import { newCell, withType, type Cell, type CellType, type NotebookDoc } from "@/lib/lab/notebook";

export type SaveState = "saved" | "dirty" | "saving" | "error" | "conflict";
const MAX_UNDO = 50;
const MAX_MOUNTED_EDITORS = 6; // Monaco instances are heavy: only the most recently used cells keep a live editor

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
  // actions
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
