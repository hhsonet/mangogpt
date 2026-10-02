import type { NbCellJson, NbJson, NbOutput } from "./types";

export type CellType = "code" | "markdown" | "raw";

/** UI model of a cell. `extra` keeps every field we don't edit (metadata, unknown keys) so a save is lossless. */
export interface Cell {
  id: string;
  type: CellType;
  source: string;
  outputs: NbOutput[];
  executionCount: number | null;
  metadata: Record<string, unknown>;
  extra: Record<string, unknown>;
}

export interface NotebookDoc {
  nbformat: number;
  nbformat_minor: number;
  metadata: Record<string, unknown>;
  cells: Cell[];
}

const KNOWN = new Set(["id", "cell_type", "source", "outputs", "execution_count", "metadata"]);

export const newId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 8);

export const joinSource = (s: string | string[] | undefined): string => (Array.isArray(s) ? s.join("") : (s ?? ""));

export function newCell(type: CellType = "code", source = ""): Cell {
  return { id: newId(), type, source, outputs: [], executionCount: null, metadata: {}, extra: {} };
}

export function fromNbformat(nb: NbJson): NotebookDoc {
  return {
    nbformat: nb.nbformat,
    nbformat_minor: nb.nbformat_minor,
    metadata: nb.metadata ?? {},
    cells: nb.cells.map((c) => ({
      id: c.id,
      type: c.cell_type,
      source: joinSource(c.source),
      outputs: c.cell_type === "code" ? (c.outputs ?? []) : [],
      executionCount: c.cell_type === "code" ? (c.execution_count ?? null) : null,
      metadata: c.metadata ?? {},
      extra: Object.fromEntries(Object.entries(c).filter(([k]) => !KNOWN.has(k))),
    })),
  };
}

export function toNbformat(doc: NotebookDoc): NbJson {
  return {
    nbformat: doc.nbformat,
    nbformat_minor: doc.nbformat_minor,
    metadata: doc.metadata,
    cells: doc.cells.map((c): NbCellJson => {
      const base = { ...c.extra, id: c.id, cell_type: c.type, metadata: c.metadata, source: c.source };
      return c.type === "code" ? { ...base, outputs: c.outputs, execution_count: c.executionCount } : base;
    }),
  };
}

/** Changing a cell's type: code keeps nothing extra, markdown/raw must not carry outputs (nbformat rejects them). */
export function withType(cell: Cell, type: CellType): Cell {
  if (cell.type === type) return cell;
  return { ...cell, type, outputs: [], executionCount: null };
}

/** Text of an output field that nbformat allows as a string or an array of lines. */
export const textOf = (v: unknown): string => (Array.isArray(v) ? v.join("") : typeof v === "string" ? v : v == null ? "" : JSON.stringify(v, null, 2));
