"use client";
import { AlertTriangle, Cpu, HardDrive, MemoryStick, Power, Zap } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent } from "@/components/ui/dialog";
import { api } from "@/hooks/api";
import { cn } from "@/lib/utils/cn";
import type { Sample } from "@/lib/monitor/sampler";
import { AdminHeader } from "./AdminNav";
import { TimeSeries } from "./charts";

const GIB = (mib: number | null) => (mib === null ? "–" : `${(mib / 1024).toFixed(1)} GiB`);
const MAX_POINTS = 720;

function Card({ title, icon: Icon, children, className }: { title: string; icon: React.ComponentType<{ size?: number }>; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn("rounded-lg border border-border p-4", className)}>
      <h2 className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted">
        <Icon size={14} /> {title}
      </h2>
      {children}
    </section>
  );
}

function Meter({ value, tone = "ok" }: { value: number; tone?: "ok" | "warn" | "bad" }) {
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-valuenow={Math.round(value)} aria-valuemin={0} aria-valuemax={100}>
      <div
        className={cn("h-full rounded-full transition-all duration-500", tone === "ok" && "bg-accent", tone === "warn" && "bg-amber-500", tone === "bad" && "bg-danger")}
        style={{ width: `${Math.max(1, Math.min(100, value))}%` }}
      />
    </div>
  );
}

function countdown(expiresAt: string | null, now: number) {
  if (!expiresAt) return "–";
  const s = Math.round((Date.parse(expiresAt) - now) / 1000);
  if (s <= 0) return "unloading";
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

export function GpuView() {
  const me = useSWR<{ role: string | null }>("/api/auth/me", (u: string) => fetch(u).then((r) => r.json()));
  const isAdmin = me.data?.role === "admin";
  const [samples, setSamples] = useState<Sample[]>([]);
  const [lastEvent, setLastEvent] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const push = useCallback((s: Sample) => {
    setLastEvent(Date.now());
    setSamples((prev) => (prev.length && prev[prev.length - 1]!.t >= s.t ? prev : [...prev, s].slice(-MAX_POINTS)));
  }, []);

  useEffect(() => {
    if (!isAdmin) return;
    let es: EventSource | null = null;
    let cancelled = false;
    api<{ current: Sample; history: Sample[] }>("/api/admin/gpu")
      .then((d) => {
        if (cancelled) return;
        setSamples([...d.history.filter((h) => h.t < d.current.t), d.current].slice(-MAX_POINTS));
        setLastEvent(Date.now());
        es = new EventSource("/api/admin/gpu/stream");
        es.addEventListener("sample", (e) => push(JSON.parse((e as MessageEvent).data) as Sample));
      })
      .catch(() => undefined);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      cancelled = true;
      es?.close();
      clearInterval(tick);
    };
  }, [isAdmin, push]);

  const cur = samples[samples.length - 1];
  const live = cur !== undefined && now - lastEvent < 7000;
  const times = useMemo(() => samples.map((s) => s.t), [samples]);
  const memPct = cur?.gpu.memUsedMiB && cur.gpu.memTotalMiB ? (cur.gpu.memUsedMiB / cur.gpu.memTotalMiB) * 100 : 0;
  const memTone = memPct >= 90 ? "bad" : memPct >= 78 ? "warn" : "ok";
  const chatModels = cur?.ollama.loaded.length ?? 0;
  const ramPct = cur ? (cur.host.ramUsedMiB / Math.max(1, cur.host.ramTotalMiB)) * 100 : 0;

  const unload = async () => {
    setBusy(true);
    try {
      await api("/api/admin/gpu/unload", { method: "POST" });
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  if (me.data && !isAdmin) {
    return (
      <div className="mx-auto max-w-5xl px-4">
        <AdminHeader />
        <p className="py-16 text-center text-sm text-muted">This page is for admins only.</p>
      </div>
    );
  }

  return (
    <div className="h-dvh overflow-y-auto">
      <div className="mx-auto max-w-5xl px-4 pb-16">
        <AdminHeader />
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">GPU monitor</h1>
            <p className="text-sm text-muted">{cur?.gpu.name ?? "Waiting for data…"} · updates every 2 seconds</p>
          </div>
          <div className="flex items-center gap-3">
            <span className={cn("inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs", live ? "border-emerald-500/40 text-emerald-600 dark:text-emerald-400" : "border-border text-muted")} role="status">
              <span className={cn("h-2 w-2 rounded-full", live ? "animate-pulse bg-emerald-500" : "bg-muted")} />
              {live ? "Live" : cur ? "Reconnecting…" : "Connecting…"}
            </span>
            <Button variant="outline" size="sm" onClick={() => setConfirming(true)} disabled={!cur || (chatModels === 0 && !cur.imageSvc.loaded)}>
              <Power size={14} /> Unload models
            </Button>
          </div>
        </div>

        {cur && memPct >= 90 && (
          <p role="alert" className="mb-4 flex items-start gap-2 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm">
            <AlertTriangle size={16} className="mt-0.5 shrink-0 text-danger" /> GPU memory is almost full ({memPct.toFixed(0)}%). New requests may fail or models may be evicted. Consider unloading models.
          </p>
        )}
        {cur && chatModels > 1 && (
          <p role="status" className="mb-4 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
            <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-500" /> {chatModels} chat models are loaded at once ({cur.ollama.loaded.map((m) => m.name).join(", ")}). Users on different models slow each other down and fill GPU memory.
          </p>
        )}

        <div className="mb-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Card title="GPU memory" icon={MemoryStick} className="lg:col-span-2">
            <div className="mb-2 flex items-baseline gap-2">
              <span className="text-3xl font-semibold tabular-nums">{cur ? (cur.gpu.memUsedMiB! / 1024).toFixed(1) : "–"}</span>
              <span className="text-sm text-muted">/ {cur ? GIB(cur.gpu.memTotalMiB) : "–"} · {memPct.toFixed(0)}%</span>
            </div>
            <Meter value={memPct} tone={memTone} />
          </Card>
          <Card title="Generating now" icon={Zap}>
            <div className="text-3xl font-semibold tabular-nums">{cur ? cur.activity.chat + cur.activity.image : "–"}</div>
            <p className="mt-1 text-xs text-muted">
              {cur ? `${cur.activity.chat} chat · ${cur.activity.image} image` : ""}
              {cur?.activity.tokensPerSec ? ` · last ${cur.activity.tokensPerSec} tok/s` : ""}
            </p>
          </Card>
          <Card title="CPU" icon={Cpu}>
            <div className="text-3xl font-semibold tabular-nums">{cur ? `${cur.host.cpuPct.toFixed(0)}%` : "–"}</div>
            <p className="mt-1 text-xs text-muted">{cur ? `load ${cur.host.load.map((l) => l.toFixed(1)).join(" / ")} · ${cur.host.cpus} cores` : ""}</p>
          </Card>
        </div>

        <div className="mb-4 grid gap-4 lg:grid-cols-2">
          <Card title="GPU memory over time" icon={MemoryStick}>
            <TimeSeries title="GPU memory in GiB" series={[{ name: "Used", color: "var(--accent)", values: samples.map((s) => (s.gpu.memUsedMiB === null ? null : s.gpu.memUsedMiB / 1024)) }]} times={times} yMax={cur?.gpu.memTotalMiB ? cur.gpu.memTotalMiB / 1024 : undefined} format={(v) => `${v.toFixed(v < 10 ? 1 : 0)} GiB`} threshold={cur?.gpu.memTotalMiB ? { value: (cur.gpu.memTotalMiB * 0.9) / 1024, label: "90%" } : undefined} />
          </Card>
          <Card title="CPU and RAM" icon={Cpu}>
            <TimeSeries title="CPU and RAM usage in percent" series={[{ name: "CPU", color: "var(--accent)", values: samples.map((s) => s.host.cpuPct) }, { name: "RAM", color: "var(--chart-3)", values: samples.map((s) => (s.host.ramUsedMiB / Math.max(1, s.host.ramTotalMiB)) * 100) }]} times={times} yMax={100} format={(v) => `${Math.round(v)}%`} />
          </Card>
          <Card title="Generations in progress" icon={Zap} className="lg:col-span-2">
            <TimeSeries title="Active generations" series={[{ name: "Chat", color: "var(--accent)", values: samples.map((s) => s.activity.chat) }, { name: "Image", color: "var(--chart-2)", values: samples.map((s) => s.activity.image) }]} times={times} format={(v) => String(Math.round(v))} />
          </Card>
        </div>

        <div className="mb-4 grid gap-4 lg:grid-cols-2">
          <Card title="Loaded chat models" icon={Cpu}>
            {cur && cur.ollama.loaded.length === 0 ? (
              <p className="text-sm text-muted">{cur.ollama.online ? "None. A model loads on the next message." : "Ollama is offline."}</p>
            ) : (
              <ul className="divide-y divide-border text-sm">
                {cur?.ollama.loaded.map((m) => (
                  <li key={m.name} className="flex items-center justify-between gap-3 py-2">
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{m.name}</span>
                      <span className="text-xs text-muted">{m.ctx ? `context ${m.ctx.toLocaleString()}` : ""}</span>
                    </span>
                    <span className="shrink-0 text-right text-xs text-muted">
                      <span className="block text-sm text-fg tabular-nums">{GIB(m.vramMiB)}</span>
                      unloads in {countdown(m.expiresAt, cur.t)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-3 border-t border-border pt-3 text-xs text-muted">
              Sizes are Ollama’s own estimates and can under-report some models; “GPU memory by process” shows the real usage.
            </p>
            <p className="mt-2 text-xs text-muted">
              Image service: {cur ? (cur.imageSvc.running ? (cur.imageSvc.busy ? "generating" : cur.imageSvc.loaded ? "model loaded" : "idle, model unloaded") : "not running") : "–"}
            </p>
          </Card>
          <Card title="GPU memory by process" icon={MemoryStick}>
            {cur && cur.procs.length === 0 ? (
              <p className="text-sm text-muted">No processes are using the GPU.</p>
            ) : (
              <ul className="space-y-3 text-sm">
                {cur?.procs.map((p) => (
                  <li key={p.pid}>
                    <div className="mb-1 flex justify-between gap-3">
                      <span className="truncate">{p.label} <span className="text-xs text-muted">pid {p.pid}</span></span>
                      <span className="tabular-nums">{GIB(p.memMiB)}</span>
                    </div>
                    <Meter value={cur.gpu.memTotalMiB ? (p.memMiB / cur.gpu.memTotalMiB) * 100 : 0} />
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="Memory and disk" icon={HardDrive} className="lg:col-span-2">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <div className="mb-1 flex justify-between text-sm"><span>System RAM</span><span className="tabular-nums">{cur ? `${GIB(cur.host.ramUsedMiB)} / ${GIB(cur.host.ramTotalMiB)}` : "–"}</span></div>
                <Meter value={ramPct} tone={ramPct > 90 ? "bad" : ramPct > 78 ? "warn" : "ok"} />
              </div>
              <div>
                <div className="mb-1 flex justify-between text-sm"><span>Disk</span><span className="tabular-nums">{cur ? `${cur.host.diskUsedGiB} / ${cur.host.diskTotalGiB} GiB` : "–"}</span></div>
                <Meter value={cur && cur.host.diskTotalGiB ? (cur.host.diskUsedGiB / cur.host.diskTotalGiB) * 100 : 0} tone={cur && cur.host.diskUsedGiB / Math.max(1, cur.host.diskTotalGiB) > 0.9 ? "bad" : "ok"} />
              </div>
            </div>
          </Card>
        </div>

        <p className="text-xs text-muted">
          This is a virtual GPU slice, so the host does not report GPU utilisation, temperature or power
          {cur?.gpu.utilPct === null ? "" : ""}; the “Generating now” and CPU panels show activity instead. History covers the last hour.
        </p>
      </div>

      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent title="Unload all models?" description="Frees GPU memory now. The next message or image loads a model again, which takes about 10–25 seconds. Generations in progress will be interrupted.">
          <div className="flex justify-end gap-2 pt-2">
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button variant="danger" onClick={unload} disabled={busy}>
              Unload models
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
