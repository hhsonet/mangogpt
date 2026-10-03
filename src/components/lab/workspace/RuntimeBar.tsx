"use client";
import { Loader2, Plug, Unplug, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent } from "@/components/ui/dialog";
import { cn } from "@/lib/utils/cn";
import { ResourcePopover } from "./ResourcePopover";
import { useRuntime, useRuntimeClient } from "./RuntimeContext";

const gb = (mb: number | null | undefined) => (mb == null ? "–" : mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`);

const REASONS: Record<string, string> = {
  idle: "Your runtime was stopped because nothing ran for a while. Press Connect to start it again.",
  admin: "An admin stopped your runtime.",
  access_removed: "Your MangoLab access ended, so the runtime was stopped.",
  crashed: "The runtime stopped unexpectedly. Press Connect to start it again.",
  project_deleted: "The project was deleted.",
  disk_full: "Your runtime was stopped because your workspace grew far past its disk limit. Delete files, then connect again.",
};

/** Runtime status pill, usage and Connect / Disconnect for the whole project. */
export function RuntimeBar() {
  const client = useRuntimeClient();
  const status = useRuntime((s) => s.runtime.status);
  const usage = useRuntime((s) => s.runtime.usage);
  const limits = useRuntime((s) => s.runtime.limits);
  const connecting = useRuntime((s) => s.connecting);
  const conn = useRuntime((s) => s.conn);
  const [confirm, setConfirm] = useState(false);
  const [panel, setPanel] = useState(false);
  const [err, setErr] = useState("");
  const busy = status === "starting" || connecting;
  const connect = () => {
    setErr("");
    client.ensureRuntime().catch((e: Error & { code?: string }) => e.code !== "runtime_limit" && setErr(e.message));
  };

  const dot = status === "running" ? "bg-emerald-500" : busy ? "animate-pulse bg-amber-500" : status === "stopping" ? "animate-pulse bg-muted" : "bg-muted";
  const label = status === "running" ? "Connected" : busy ? "Connecting…" : status === "stopping" ? "Disconnecting…" : conn === "closed" ? "Reconnecting…" : "Not connected";

  return (
    <>
      <div className="relative">
        <button
          data-resource-toggle
          type="button"
          onClick={() => status === "running" && setPanel((v) => !v)}
          aria-expanded={status === "running" ? panel : undefined}
          aria-haspopup={status === "running" ? "dialog" : undefined}
          title={status === "running" && limits ? `Limits: ${gb(limits.mem_max_mb)} RAM, ${(limits.cpu_quota_pct / 100).toFixed(1)} CPU cores, ${gb(limits.gpu_budget_mib)} GPU. Click for details.` : "The runtime runs your code on the server's GPU"}
          className={cn("flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs", status === "running" ? "cursor-pointer border-emerald-500/40 hover:bg-surface-2" : "cursor-default border-border text-muted")}
          role="status"
        >
          {busy ? <Loader2 size={11} className="animate-spin text-amber-500" /> : <span className={cn("h-2 w-2 rounded-full", dot)} />}
          <span className="max-sm:sr-only">{label}</span>
          {status === "running" && usage && (usage.ram_mb != null || usage.gpu_mib != null) && (
            <span className="hidden text-muted tabular-nums lg:inline">RAM {gb(usage.ram_mb)} · GPU {gb(usage.gpu_mib)}</span>
          )}
        </button>
        {panel && status === "running" && <ResourcePopover onClose={() => setPanel(false)} />}
      </div>
      {status === "running" ? (
        <Button size="sm" variant="outline" onClick={() => setConfirm(true)} className="max-sm:px-2">
          <Unplug size={14} /> <span className="max-sm:sr-only">Disconnect</span>
        </Button>
      ) : (
        <Button size="sm" variant="outline" onClick={connect} disabled={busy || status === "stopping" || conn !== "open"} className="max-sm:px-2">
          <Plug size={14} /> <span className="max-sm:sr-only">Connect</span>
        </Button>
      )}
      {err && (
        <span role="alert" className="max-w-56 truncate text-xs text-danger" title={err}>
          {err}
        </span>
      )}

      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent title="Disconnect the runtime?" description="Running cells stop and the notebooks’ variables are lost. Your files and saved notebooks stay.">
          <div className="flex justify-end gap-2">
            <DialogClose asChild>
              <Button variant="ghost">Stay connected</Button>
            </DialogClose>
            <Button
              variant="primary"
              onClick={() => {
                setConfirm(false);
                void client.stopRuntime();
              }}
            >
              Disconnect
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Explains why the runtime went away when the server (not the user) stopped it, and handles the one-runtime-at-a-time limit. */
export function RuntimeNotices() {
  const client = useRuntimeClient();
  const reason = useRuntime((s) => s.runtime.reason);
  const status = useRuntime((s) => s.runtime.status);
  const conflict = useRuntime((s) => s.conflict);
  const notice = useRuntime((s) => s.notice);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const note = status === "none" && reason && reason !== "user" && REASONS[reason] && dismissed !== reason ? REASONS[reason] : null;

  return (
    <>
      {notice && (
        <div role={notice.level === "warn" ? "status" : "alert"} className={cn("flex items-center gap-2 border-b px-4 py-1.5 text-sm", notice.level === "warn" ? "border-amber-500/40 bg-amber-500/10" : "border-danger/40 bg-danger/10")}>
          <span className="flex-1">{notice.message}</span>
          <button aria-label="Dismiss" onClick={() => client.dismissNotice()} className="cursor-pointer rounded p-1 hover:bg-surface-2">
            <X size={14} />
          </button>
        </div>
      )}
      {note && (
        <div role="status" className="flex items-center gap-2 border-b border-amber-500/40 bg-amber-500/10 px-4 py-1.5 text-sm">
          <span className="flex-1">{note}</span>
          <button aria-label="Dismiss" onClick={() => setDismissed(reason ?? null)} className="cursor-pointer rounded p-1 hover:bg-surface-2">
            <X size={14} />
          </button>
        </div>
      )}
      <Dialog open={!!conflict} onOpenChange={(v) => !v && client.dismissConflict()}>
        <DialogContent title="Only one runtime at a time" description={conflict?.message}>
          <div className="flex justify-end gap-2">
            <DialogClose asChild>
              <Button variant="ghost">Cancel</Button>
            </DialogClose>
            {conflict && conflict.others.length > 0 && (
              <Button
                variant="primary"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await client.replaceOthers(conflict.others, conflict.retry);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy ? "Stopping…" : `Stop “${conflict.others[0]!.project_name}” and connect here`}
              </Button>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

