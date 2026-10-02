"use client";
import { AlertTriangle, Check, Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { ApiError } from "@/hooks/api";
import { filesApi } from "@/lib/lab/api";
import { baseOf, languageFor } from "@/lib/lab/files";
import { CodeEditor } from "./CodeEditor";

type State = "saved" | "dirty" | "saving" | "error" | "conflict";

/** Plain text / code files (scripts, configs, Markdown, CSV...). Same save rules as notebooks: autosave, never overwrite a newer version silently. */
export function TextFileEditor({ projectId, path, registerFlush }: { projectId: string; path: string; registerFlush: (path: string, flush: (() => Promise<void>) | null) => void }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [state, setState] = useState<State>("saved");
  const etag = useRef("");
  const latest = useRef("");
  const rev = useRef(0);
  const saving = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    let live = true;
    filesApi
      .read(projectId, path)
      .then((r) => {
        if (!live) return;
        etag.current = r.etag;
        latest.current = r.content;
        setText(r.content);
      })
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [projectId, path]);

  const save = useCallback(
    async (force = false) => {
      if (saving.current) return;
      saving.current = true;
      const my = rev.current;
      setState("saving");
      try {
        const r = await filesApi.write(projectId, { path, content: latest.current, base_etag: force ? undefined : etag.current, create_only: false, ...(force ? { base_etag: undefined } : {}) });
        etag.current = r.etag;
        setState(rev.current === my ? "saved" : "dirty");
      } catch (e) {
        setState((e as ApiError).code === "conflict" ? "conflict" : "error");
        setError((e as Error).message);
      } finally {
        saving.current = false;
      }
    },
    [projectId, path],
  );

  const keepMine = async () => {
    // Fetch the current etag, then save over it on purpose.
    try {
      const cur = await filesApi.read(projectId, path);
      etag.current = cur.etag;
      setState("dirty");
      await save();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const onChange = (v: string) => {
    latest.current = v;
    rev.current++;
    setText(v);
    setState("dirty");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(), 2500);
  };

  useEffect(() => {
    registerFlush(path, async () => {
      clearTimeout(timer.current);
      for (let i = 0; i < 20 && state !== "saved" && !saving.current; i++) await save();
    });
    return () => registerFlush(path, null);
  }, [registerFlush, path, save, state]);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (state !== "saved") {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [state]);

  if (error && text === null) return <p role="alert" className="p-6 text-sm text-danger">{error}</p>;
  if (text === null) return <p className="p-6 text-sm text-muted">Loading…</p>;
  const Icon = state === "saving" ? Loader2 : state === "saved" ? Check : AlertTriangle;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-3 border-b border-border px-3 py-1.5 text-xs">
        <span className="font-medium">{baseOf(path)}</span>
        <span className={state === "saved" ? "text-muted" : state === "error" || state === "conflict" ? "text-danger" : "text-amber-600 dark:text-amber-400"} role="status">
          <Icon size={13} className={`mr-1 inline ${state === "saving" ? "animate-spin" : ""}`} />
          {state === "saved" ? "All changes saved" : state === "saving" ? "Saving…" : state === "dirty" ? "Unsaved changes" : state === "conflict" ? "Changed elsewhere" : "Couldn’t save"}
        </span>
        <Button size="sm" variant="outline" className="ml-auto" disabled={state === "saved" || state === "saving"} onClick={() => void save()}>
          Save
        </Button>
      </div>
      {state === "conflict" && (
        <div role="alert" className="flex items-center gap-3 border-b border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm">
          <span className="flex-1">{error || "This file changed somewhere else."}</span>
          <Button size="sm" variant="primary" onClick={() => void keepMine()}>
            Keep my version
          </Button>
        </div>
      )}
      <div className="min-h-0 flex-1">
        <CodeEditor mode="file" value={text} language={languageFor(path)} onChange={onChange} onSave={() => void save()} />
      </div>
    </div>
  );
}
