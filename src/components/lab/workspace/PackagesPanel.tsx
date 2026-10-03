"use client";
import { Loader2, Package, Search, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { ApiError } from "@/hooks/api";
import { packagesApi } from "@/lib/lab/api";
import type { PackageJob } from "@/lib/lab/types";
import { cn } from "@/lib/utils/cn";
import { useRuntime } from "./RuntimeContext";

/** Install and remove Python packages for this project. PyTorch, NumPy, pandas and friends are shared and already there. */
export function PackagesPanel({ projectId }: { projectId: string }) {
  const runtimeStatus = useRuntime((s) => s.runtime.status);
  const { data, mutate } = useSWR(["lab-packages", projectId], () => packagesApi.list(projectId), { revalidateOnFocus: false });
  const [text, setText] = useState("");
  const [localJob, setJob] = useState<PackageJob | null>(null);
  const [log, setLog] = useState("");
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const [showShared, setShowShared] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [doneNote, setDoneNote] = useState("");
  const job = localJob ?? data?.job ?? null; // a job that was already running when the panel opened is picked up from the server
  const logRef = useRef<HTMLPreElement>(null);

  // Follow a running job's log.
  useEffect(() => {
    if (!job || job.status !== "running") return;
    let live = true;
    let offset = log.length === 0 ? 0 : new TextEncoder().encode(log).length;
    const tick = async () => {
      try {
        const r = await packagesApi.job(projectId, job.id, offset);
        if (!live) return;
        offset = r.next_offset;
        if (r.log) setLog((l) => l + r.log);
        if (r.status !== "running") {
          setJob(r);
          setDoneNote(r.status === "ok" ? (runtimeStatus === "running" ? "Done. New packages can be imported right away; restart the kernel to pick up upgrades of packages you already imported." : "Done.") : "");
          void mutate();
          return;
        }
      } catch {
        /* keep trying */
      }
      if (live) setTimeout(tick, 700);
    };
    void tick();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- follow one job; log is only read for the starting offset
  }, [job?.id, job?.status, projectId]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  const run = useCallback(
    async (action: "install" | "uninstall", specs: string[]) => {
      setError("");
      setDoneNote("");
      try {
        const j = await (action === "install" ? packagesApi.install(projectId, specs) : packagesApi.uninstall(projectId, specs));
        setLog("");
        setJob(j);
      } catch (e) {
        setError((e as ApiError).message);
      }
    },
    [projectId],
  );

  const running = job?.status === "running";
  const specs = text.split(/[\s,]+/).filter(Boolean);
  const mine = (data?.installed ?? []).filter((p) => !filter || p.name.includes(filter.toLowerCase()));
  const shared = (data?.shared ?? []).filter((p) => !filter || p.name.includes(filter.toLowerCase()));

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-3 text-sm">
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (specs.length && !running) {
            void run("install", specs);
            setText("");
          }
        }}
      >
        <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="scikit-learn   transformers==4.45.0   plotly" aria-label="Packages to install" className="min-w-0 flex-1 basis-64" disabled={running} />
        <Button type="submit" variant="primary" size="sm" disabled={!specs.length || running}>
          {running ? <Loader2 size={14} className="animate-spin" /> : <Package size={14} />} Install
        </Button>
      </form>
      <p className="-mt-1 text-xs text-muted">
        Separate names with spaces. In a notebook you can also run <code className="rounded bg-surface-2 px-1">%pip install name</code>. Packages you install belong to this project only.
      </p>
      {error && (
        <p role="alert" className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs">
          {error}
        </p>
      )}

      {job && (
        <div className="rounded-md border border-border">
          <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-xs">
            <span className={cn("font-medium", job.status === "ok" ? "text-emerald-600 dark:text-emerald-400" : job.status === "running" ? "" : "text-danger")}>
              {job.status === "running" ? `${job.action === "install" ? "Installing" : "Removing"} ${job.specs.join(", ")}…` : job.status === "ok" ? "Finished" : job.status === "timeout" ? "Timed out" : "Failed"}
            </span>
            {running && (
              <Button size="sm" variant="ghost" className="ml-auto h-6 px-2 text-xs" onClick={() => void packagesApi.cancel(projectId, job.id)}>
                Cancel
              </Button>
            )}
          </div>
          <pre ref={logRef} className="m-0 max-h-48 overflow-auto whitespace-pre-wrap break-words bg-[var(--code-bg)] p-3 font-mono text-xs leading-relaxed" aria-label="Package log">
            {log || "Starting…"}
          </pre>
          {doneNote && <p className="border-t border-border px-3 py-1.5 text-xs text-muted">{doneNote}</p>}
        </div>
      )}

      <div className="flex items-center gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Installed in this project ({data?.installed.length ?? 0})</h3>
        <div className="relative ml-auto">
          <Search size={13} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted" />
          <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter" aria-label="Filter packages" className="h-7 w-40 pl-7 text-xs" />
        </div>
      </div>
      {mine.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-3 py-3 text-xs text-muted">{data?.installed.length ? "No match." : "Nothing installed yet. Everything below “Preinstalled” is already available."}</p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {mine.map((p) => (
            <li key={p.name} className="flex items-center gap-2 px-3 py-1.5">
              <span className="font-medium">{p.name}</span>
              <span className="text-xs text-muted">{p.version}</span>
              <button aria-label={`Uninstall ${p.name}`} title="Uninstall" disabled={running} onClick={() => void run("uninstall", [p.name])} className="ml-auto cursor-pointer rounded p-1 text-muted hover:bg-surface-2 hover:text-danger disabled:opacity-40">
                <Trash2 size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <button onClick={() => setShowShared((v) => !v)} aria-expanded={showShared} className="cursor-pointer self-start text-xs text-accent hover:underline">
        {showShared ? "Hide" : "Show"} preinstalled packages ({data?.shared.length ?? 0})
      </button>
      {showShared && (
        <ul className="grid max-h-56 grid-cols-1 gap-x-4 overflow-y-auto rounded-md border border-border px-3 py-2 text-xs sm:grid-cols-2 lg:grid-cols-3">
          {shared.map((p) => (
            <li key={p.name} className="flex justify-between gap-2 py-0.5">
              <span>{p.name}</span>
              <span className="text-muted">{p.version}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-auto flex items-center gap-2 border-t border-border pt-3">
        <Button size="sm" variant="outline" onClick={() => setConfirmReset(true)} disabled={running || !data?.installed.length}>
          Reset project packages
        </Button>
        <span className="text-xs text-muted">Removes everything installed here, e.g. after a conflict.</span>
      </div>

      <Dialog open={confirmReset} onOpenChange={setConfirmReset}>
        <DialogContent title="Reset this project’s packages?" description="Everything you installed in this project is removed. The preinstalled packages stay. Your files are not touched.">
          {runtimeStatus !== "none" && <p className="mb-3 text-sm text-amber-600 dark:text-amber-400">Disconnect the runtime first (the button in the top bar), then reset.</p>}
          <div className="flex justify-end gap-2">
            <DialogClose asChild>
              <Button variant="ghost">Cancel</Button>
            </DialogClose>
            <Button
              variant="primary"
              disabled={runtimeStatus !== "none"}
              onClick={async () => {
                try {
                  await packagesApi.reset(projectId);
                  setConfirmReset(false);
                  setJob(null);
                  void mutate();
                } catch (e) {
                  setError((e as ApiError).message);
                  setConfirmReset(false);
                }
              }}
            >
              Reset
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
