"use client";
import { useCallback, useEffect, useRef } from "react";
import { notebooksApi } from "@/lib/lab/api";
import { fromNbformat, toNbformat } from "@/lib/lab/notebook";
import type { ApiError } from "@/hooks/api";
import type { NotebookStore } from "@/stores/notebook";

const AUTOSAVE_MS = 2000;
const RETRY_MS = 10_000;
const MAX_WAIT_MS = 10_000; // output streaming from a running cell keeps resetting the 2 s timer; save at least this often anyway

/** Saving, autosave (2 s after the last edit), conflict handling and the "unsaved changes" warning for one open notebook. */
export function useNotebookPersistence(store: NotebookStore, projectId: string, path: string) {
  const saving = useRef(false);

  const save = useCallback(
    async (force = false) => {
      const s = store.getState();
      if (saving.current || (!force && (s.saveState === "saved" || s.saveState === "conflict"))) return;
      saving.current = true;
      const rev = s.markSaving();
      try {
        const r = await notebooksApi.save(projectId, { path, notebook: toNbformat(s.doc), base_etag: s.etag, force });
        store.getState().markSaved(rev, r.etag, r.version, r.saved_at);
      } catch (e) {
        const err = e as ApiError;
        store.getState().markSaveFailed(err.code === "conflict" || err.code === "deleted" ? "conflict" : "error", err.message);
      } finally {
        saving.current = false;
      }
    },
    [store, projectId, path],
  );

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let dirtySince = 0;
    const unsub = store.subscribe((s, prev) => {
      const edited = s.rev !== prev.rev || prev.saveState !== s.saveState;
      if (s.saveState !== "dirty") dirtySince = 0;
      if (s.saveState === "dirty" && edited) {
        clearTimeout(timer);
        if (!dirtySince) dirtySince = Date.now();
        const wait = Math.max(0, Math.min(AUTOSAVE_MS, dirtySince + MAX_WAIT_MS - Date.now()));
        timer = setTimeout(() => void save(), wait);
      } else if (s.saveState === "error" && prev.saveState !== "error") {
        clearTimeout(timer);
        timer = setTimeout(() => {
          store.setState({ saveState: "dirty" }); // try again
          void save();
        }, RETRY_MS);
      }
    });
    return () => {
      clearTimeout(timer);
      unsub();
      if (store.getState().saveState === "dirty") void save(); // never lose edits because a tab went away
    };
  }, [store, save]);

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (store.getState().saveState !== "saved") {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [store]);

  /** Discard the editor's copy and load what is on disk. */
  const reload = useCallback(async () => {
    const r = await notebooksApi.open(projectId, path);
    store.getState().replaceDoc(fromNbformat(r.notebook), r.etag, r.version);
  }, [store, projectId, path]);

  /** Wait for any pending edits to reach the server (used before closing a tab). */
  const flush = useCallback(async () => {
    for (let i = 0; i < 20 && store.getState().saveState !== "saved" && store.getState().saveState !== "conflict"; i++) {
      if (!saving.current) await save(true);
      else await new Promise((r) => setTimeout(r, 150));
    }
  }, [store, save]);

  return { save, reload, flush };
}
