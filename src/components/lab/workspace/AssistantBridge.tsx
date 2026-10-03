"use client";
import { createContext, useCallback, useContext, useMemo, useRef } from "react";
import type { NotebookSnapshot } from "@/lib/lab/types";

/** What the assistant can do to the notebook the person is looking at. Each open notebook registers one. */
export interface NotebookBridge {
  /** For useSyncExternalStore: re-render when the notebook's selection, content or run state changes. */
  subscribe: (cb: () => void) => () => void;
  version: () => string;
  snapshot: () => NotebookSnapshot;
  selectedCellId: () => string | null;
  /** The cell's current source, or null if it no longer exists. */
  cellSource: (id: string) => string | null;
  editCell: (id: string, source: string) => boolean;
  insertCell: (o: { position: "after" | "before" | "end"; refCellId: string | null; type: "code" | "markdown"; source: string }) => string;
  removeCell: (id: string) => void;
  runCell: (id: string) => void;
  selectCell: (id: string) => void;
}

interface Registry {
  register: (path: string, b: NotebookBridge | null) => void;
  get: (path: string) => NotebookBridge | undefined;
}

const Ctx = createContext<Registry | null>(null);

export function AssistantBridgeProvider({ children }: { children: React.ReactNode }) {
  const map = useRef(new Map<string, NotebookBridge>());
  const register = useCallback((path: string, b: NotebookBridge | null) => void (b ? map.current.set(path, b) : map.current.delete(path)), []);
  const get = useCallback((path: string) => map.current.get(path), []);
  const value = useMemo(() => ({ register, get }), [register, get]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useBridgeRegistry(): Registry {
  const r = useContext(Ctx);
  if (!r) throw new Error("useBridgeRegistry must be used inside AssistantBridgeProvider");
  return r;
}
