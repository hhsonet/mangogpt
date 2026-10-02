"use client";
import { AlertTriangle, Cpu, FlaskConical, HardDrive, Lock, MemoryStick, Menu, Timer, Zap } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useApp } from "@/hooks/useApp";
import { useLabMe } from "@/hooks/lab";
import { cn } from "@/lib/utils/cn";
import { ProjectsSection } from "./ProjectsSection";

/** Opens the authenticated WebSocket once to prove the whole path (cookie, origin, gateway, framing) works. */
function useLiveCheck(enabled: boolean) {
  const [state, setState] = useState<{ status: "connecting" | "ok" | "failed"; ms?: number }>({ status: "connecting" });
  useEffect(() => {
    if (!enabled) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    let ws: WebSocket | null = null;
    let t0 = 0;
    try {
      ws = new WebSocket(`${proto}://${location.host}/lab-ws/v1/ping`);
      ws.onopen = () => {
        t0 = performance.now();
        ws?.send(JSON.stringify({ type: "ping" }));
      };
      ws.onmessage = (e) => {
        if (JSON.parse(e.data).type === "pong") setState({ status: "ok", ms: Math.round(performance.now() - t0) });
      };
      ws.onerror = () => setState({ status: "failed" });
      ws.onclose = (e) => e.code !== 1000 && setState((s) => (s.status === "ok" ? s : { status: "failed" }));
    } catch {
      setTimeout(() => setState({ status: "failed" }), 0); // async: never set state synchronously inside an effect
    }
    return () => ws?.close(1000);
  }, [enabled]);
  return state;
}

function Limit({ icon: Icon, label, value }: { icon: React.ComponentType<{ size?: number }>; label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border p-3">
      <p className="flex items-center gap-2 text-xs text-muted">
        <Icon size={14} /> {label}
      </p>
      <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
    </div>
  );
}

const gib = (mib: number) => `${(mib / 1024).toFixed(mib % 1024 ? 1 : 0)} GiB`;

export function LabHome() {
  const { setMobileOpen } = useApp();
  const { me, error, isLoading } = useLabMe();
  const enabled = Boolean(me?.lab.enabled);
  const live = useLiveCheck(enabled);

  return (
    <div className="h-dvh overflow-y-auto">
      <div className="mx-auto max-w-4xl px-4 pb-16">
        <header className="flex h-12 items-center gap-2">
          <Button variant="ghost" size="icon" className="md:hidden" onClick={() => setMobileOpen(true)} aria-label="Open sidebar">
            <Menu size={18} />
          </Button>
        </header>

        <div className="mb-6 mt-4 flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent text-accent-fg">
            <FlaskConical size={20} />
          </span>
          <div>
            <h1 className="flex items-center gap-2 text-xl font-semibold">
              MangoLab <span className="rounded-full border border-border px-2 py-0.5 text-[0.65rem] font-medium uppercase tracking-wide text-muted">Beta</span>
            </h1>
            <p className="text-sm text-muted">Notebooks on your own GPU, with an AI assistant.</p>
          </div>
        </div>

        {isLoading && <p className="py-10 text-center text-sm text-muted">Loading…</p>}

        {error && (
          <div role="alert" className="flex items-start gap-3 rounded-lg border border-danger/40 bg-danger/10 p-4 text-sm">
            <AlertTriangle size={16} className="mt-0.5 shrink-0 text-danger" />
            <div>
              <p className="font-medium">MangoLab isn’t responding.</p>
              <p className="mt-1 text-muted">The MangoLab service may be stopped. If you run this server, start it with <code>mangolab/scripts/start-api.sh</code>.</p>
            </div>
          </div>
        )}

        {me && !enabled && (
          <div className="rounded-lg border border-border p-6 text-center">
            <Lock size={22} className="mx-auto mb-3 text-muted" />
            <h2 className="font-semibold">MangoLab access is needed</h2>
            <p className="mx-auto mt-1 max-w-md text-sm text-muted">
              Notebooks run your code on the shared GPU server, so an admin has to switch MangoLab on for your account. Ask them to enable it.
            </p>
          </div>
        )}

        {me && enabled && (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-3 text-sm">
              <span
                className={cn(
                  "inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs",
                  live.status === "ok" ? "border-emerald-500/40 text-emerald-600 dark:text-emerald-400" : live.status === "failed" ? "border-danger/40 text-danger" : "border-border text-muted",
                )}
                role="status"
              >
                <span className={cn("h-2 w-2 rounded-full", live.status === "ok" ? "bg-emerald-500" : live.status === "failed" ? "bg-danger" : "animate-pulse bg-muted")} />
                {live.status === "ok" ? `Live connection OK (${live.ms} ms)` : live.status === "failed" ? "Live connection failed" : "Connecting…"}
              </span>
              <span className="text-muted">Signed in as {me.user.username}</span>
              {me.user.role === "admin" && (
                <Link href="/admin/lab" className="text-accent underline-offset-2 hover:underline">
                  Manage access
                </Link>
              )}
            </div>

            <ProjectsSection />
            <h2 className="mb-2 mt-8 text-sm font-semibold">Your resource limits</h2>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Limit icon={Zap} label="GPU memory" value={gib(me.lab.limits.gpu_budget_mib)} />
              <Limit icon={Cpu} label="CPU" value={`${(me.lab.limits.cpu_quota_pct / 100).toFixed(1)} cores`} />
              <Limit icon={MemoryStick} label="RAM" value={gib(me.lab.limits.mem_max_mb)} />
              <Limit icon={HardDrive} label="Workspace disk" value={gib(me.lab.limits.disk_quota_mb)} />
              <Limit icon={FlaskConical} label="Runtimes at once" value={String(me.lab.limits.max_runtimes)} />
              <Limit icon={Timer} label="Stops after idle" value={`${me.lab.limits.idle_timeout_min} min`} />
            </div>

          </>
        )}
      </div>
    </div>
  );
}
