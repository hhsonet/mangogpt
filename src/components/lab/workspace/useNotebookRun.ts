"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiError } from "@/hooks/api";
import type { NotebookStore } from "@/stores/notebook";
import { useRuntimeClient } from "./RuntimeContext";

/** Connects one open notebook to its kernel: applies the server's events to the notebook, and runs / interrupts / restarts. */
export function useNotebookRun(store: NotebookStore, path: string) {
  const client = useRuntimeClient();
  const [error, setError] = useState<string | null>(null);
  const stopped = useRef(false);

  useEffect(() => {
    stopped.current = false;
    const detach = client.attach(path, (e) => {
      const r = store.getState().applyEvent(e);
      r?.ack.forEach((id) => client.ack(path, id));
      if (e.type === "error" && e.code !== "no_runtime") setError(e.message);
      if (e.type === "error" && e.code === "no_runtime") setError("The runtime isn’t connected. Press Connect, then run again.");
    });
    return () => {
      stopped.current = true;
      detach();
    };
  }, [client, path, store]);

  const runCells = useCallback(
    async (ids: string[]) => {
      const cells = store.getState().doc.cells;
      const targets = ids.map((id) => cells.find((c) => c.id === id)).filter((c): c is NonNullable<typeof c> => !!c && c.type === "code" && c.source.trim() !== "");
      if (!targets.length) return;
      setError(null);
      store.getState().markQueued(targets.map((c) => c.id));
      try {
        await client.ensureRuntime();
      } catch (e) {
        targets.forEach((c) => store.getState().unqueue(c.id));
        if ((e as ApiError).code !== "runtime_limit") setError((e as Error).message);
        return;
      }
      for (const t of targets) {
        const cell = store.getState().doc.cells.find((c) => c.id === t.id);
        if (!cell) {
          store.getState().unqueue(t.id);
          continue;
        }
        try {
          await client.execute(path, cell.id, cell.source); // read at run time, so edits made while waiting are included
        } catch (e) {
          store.getState().unqueue(t.id);
          setError((e as Error).message);
        }
      }
    },
    [client, path, store],
  );

  const runAll = useCallback(() => runCells(store.getState().doc.cells.map((c) => c.id)), [runCells, store]);
  const runRange = useCallback(
    (id: string, where: "above" | "below") => {
      const cells = store.getState().doc.cells;
      const i = cells.findIndex((c) => c.id === id);
      if (i < 0) return Promise.resolve();
      return runCells((where === "above" ? cells.slice(0, i) : cells.slice(i)).map((c) => c.id));
    },
    [runCells, store],
  );
  const interrupt = useCallback(() => client.interrupt(path), [client, path]);
  const restart = useCallback(() => {
    setError(null);
    client.restartKernel(path);
  }, [client, path]);

  const restartAndRunAll = useCallback(async () => {
    restart();
    await new Promise<void>((resolve) => {
      let seenRestarting = false;
      const timer = setTimeout(() => (unsub(), resolve()), 30_000);
      const unsub = store.subscribe((s) => {
        if (s.kernel === "restarting") seenRestarting = true;
        if (seenRestarting && s.kernel === "idle") {
          clearTimeout(timer);
          unsub();
          resolve();
        }
      });
    });
    await runAll();
  }, [restart, runAll, store]);

  return { runCells, runAll, runRange, interrupt, restart, restartAndRunAll, error, clearError: () => setError(null) };
}
