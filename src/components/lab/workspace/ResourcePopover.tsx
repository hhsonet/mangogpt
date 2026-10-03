"use client";
import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils/cn";
import { useRuntime } from "./RuntimeContext";

const fmt = (mb: number | null | undefined) => (mb == null ? "–" : mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`);

function Spark({ values, max, tone }: { values: number[]; max: number; tone: string }) {
  const w = 220;
  const h = 36;
  if (values.length < 2) return <div className="h-9 rounded bg-surface-2/50" aria-hidden />;
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * w).toFixed(1)},${(h - 2 - Math.min(v / max, 1) * (h - 4)).toFixed(1)}`);
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-9 w-full" preserveAspectRatio="none" aria-hidden>
      <polyline points={`0,${h} ${pts.join(" ")} ${w},${h}`} className={cn("opacity-15", tone)} fill="currentColor" stroke="none" />
      <polyline points={pts.join(" ")} className={tone} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Meter({ label, value, limit, display, history, tone }: { label: string; value: number | null | undefined; limit: number; display: string; history: number[]; tone: string }) {
  const pct = value == null || !limit ? 0 : Math.min(100, (value / limit) * 100);
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between text-xs">
        <span className="font-medium">{label}</span>
        <span className="tabular-nums text-muted">{display}</span>
      </div>
      <div className="mb-1.5 h-1.5 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-label={label} aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
        <div className={cn("h-full rounded-full", pct > 90 ? "bg-danger" : pct > 75 ? "bg-amber-500" : "bg-accent")} style={{ width: `${pct}%` }} />
      </div>
      <Spark values={history} max={limit} tone={tone} />
    </div>
  );
}

/** What the runtime is using right now and over the last minutes, against this account's limits. */
export function ResourcePopover({ onClose }: { onClose: () => void }) {
  const usage = useRuntime((s) => s.runtime.usage);
  const limits = useRuntime((s) => s.runtime.limits);
  const history = useRuntime((s) => s.history);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) && !(e.target as HTMLElement).closest("[data-resource-toggle]")) onClose();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
    };
  }, [onClose]);

  if (!limits) return null;
  const cores = limits.cpu_quota_pct / 100;
  return (
    <div ref={ref} role="dialog" aria-label="Resource use" className="absolute right-0 top-full z-50 mt-2 w-[min(20rem,calc(100vw-1rem))] space-y-3 rounded-lg border border-border bg-bg p-3 shadow-lg">
      <Meter label="RAM" value={usage?.ram_mb} limit={limits.mem_max_mb} display={`${fmt(usage?.ram_mb)} of ${fmt(limits.mem_max_mb)}`} history={history.map((h) => h.ram_mb ?? 0)} tone="text-sky-500" />
      <Meter label="GPU memory" value={usage?.gpu_mib} limit={limits.gpu_budget_mib} display={`${fmt(usage?.gpu_mib)} of ${fmt(limits.gpu_budget_mib)}`} history={history.map((h) => h.gpu_mib ?? 0)} tone="text-emerald-500" />
      <Meter label="CPU" value={usage?.cpu_pct} limit={limits.cpu_quota_pct} display={`${usage?.cpu_pct != null ? Math.round(usage.cpu_pct) : "–"}% of ${cores.toFixed(cores % 1 ? 1 : 0)} core${cores === 1 ? "" : "s"}`} history={history.map((h) => h.cpu_pct ?? 0)} tone="text-violet-500" />
      {usage?.disk_quota_mb ? (
        <div>
          <div className="mb-1 flex items-baseline justify-between text-xs">
            <span className="font-medium">Workspace disk</span>
            <span className="tabular-nums text-muted">{fmt(usage.disk_mb)} of {fmt(usage.disk_quota_mb)}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-label="Workspace disk" aria-valuenow={Math.round(((usage.disk_mb ?? 0) / usage.disk_quota_mb) * 100)} aria-valuemin={0} aria-valuemax={100}>
            <div className={cn("h-full rounded-full", (usage.disk_mb ?? 0) > usage.disk_quota_mb * 0.9 ? "bg-danger" : "bg-accent")} style={{ width: `${Math.min(100, ((usage.disk_mb ?? 0) / usage.disk_quota_mb) * 100)}%` }} />
          </div>
        </div>
      ) : null}
      <p className="text-[0.7rem] leading-snug text-muted">RAM, CPU and processes are capped by the server. GPU memory over the limit for about 10 seconds ends the process using the most.</p>
    </div>
  );
}
