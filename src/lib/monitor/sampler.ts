import "server-only";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import { imageHealth } from "@/lib/images/client";
import { getStatus } from "@/lib/ollama/client";
import { activitySnapshot } from "./activity";

export interface GpuProcess {
  pid: number;
  label: string;
  memMiB: number;
}

export interface Sample {
  t: number;
  gpu: {
    available: boolean;
    name: string | null;
    memUsedMiB: number | null;
    memTotalMiB: number | null;
    /** The vGPU on this host doesn't expose these; they are null rather than invented. */
    utilPct: number | null;
    tempC: number | null;
    powerW: number | null;
    smMhz: number | null;
  };
  procs: GpuProcess[];
  ollama: { online: boolean; loaded: { name: string; vramMiB: number; ctx: number | null; expiresAt: string | null }[] };
  imageSvc: { running: boolean; loaded: boolean; busy: boolean };
  host: { cpuPct: number; load: [number, number, number]; cpus: number; ramUsedMiB: number; ramTotalMiB: number; diskUsedGiB: number; diskTotalGiB: number };
  activity: { chat: number; image: number; tokensPerSec: number | null };
}

const HISTORY_MAX = 720; // 1 hour at 5 s
const RING_EVERY_MS = 4500;

interface State {
  ring: Sample[];
  lastCpu: { idle: number; total: number } | null;
  timer: ReturnType<typeof setInterval> | null;
}
const g = globalThis as unknown as { __mangoSampler?: State };
const state = (g.__mangoSampler ??= { ring: [], lastCpu: null, timer: null });

const run = (cmd: string, args: string[]) =>
  new Promise<string>((resolve) => execFile(cmd, args, { timeout: 3000 }, (err, stdout) => resolve(err ? "" : stdout.trim())));

const num = (v: string | undefined): number | null => {
  if (v === undefined) return null;
  const n = Number(v);
  return v.includes("N/A") || v === "" || Number.isNaN(n) ? null : n;
};

async function gpuInfo(): Promise<Sample["gpu"]> {
  const out = await run("nvidia-smi", ["--query-gpu=name,memory.used,memory.total,utilization.gpu,temperature.gpu,power.draw,clocks.sm", "--format=csv,noheader,nounits"]);
  if (!out) return { available: false, name: null, memUsedMiB: null, memTotalMiB: null, utilPct: null, tempC: null, powerW: null, smMhz: null };
  const c = out.split("\n")[0]!.split(",").map((x) => x.trim());
  return { available: true, name: c[0] ?? null, memUsedMiB: num(c[1]), memTotalMiB: num(c[2]), utilPct: num(c[3]), tempC: num(c[4]), powerW: num(c[5]), smMhz: num(c[6]) };
}

async function labelFor(pid: number): Promise<string> {
  try {
    const cmd = (await fs.readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0").filter(Boolean);
    const joined = cmd.join(" ");
    if (/uvicorn|imagesvc/.test(joined)) return "Image service (SDXL-Turbo)";
    if (/ollama/.test(joined)) return "Ollama (chat model)";
    return (cmd[0] ?? `pid ${pid}`).split("/").pop() ?? `pid ${pid}`;
  } catch {
    return `process ${pid}`;
  }
}

async function gpuProcs(): Promise<GpuProcess[]> {
  const out = await run("nvidia-smi", ["--query-compute-apps=pid,used_memory", "--format=csv,noheader,nounits"]);
  if (!out) return [];
  const rows = out.split("\n").map((l) => l.split(",").map((x) => x.trim())).filter((r) => r.length >= 2 && Number(r[0]) > 0);
  return Promise.all(rows.map(async (r) => ({ pid: Number(r[0]), label: await labelFor(Number(r[0])), memMiB: Number(r[1]) || 0 })));
}

async function cpuPct(): Promise<number> {
  const line = (await fs.readFile("/proc/stat", "utf8")).split("\n")[0]!.split(/\s+/).slice(1).map(Number);
  const idle = (line[3] ?? 0) + (line[4] ?? 0);
  const total = line.reduce((a, b) => a + b, 0);
  const prev = state.lastCpu;
  state.lastCpu = { idle, total };
  if (!prev || total === prev.total) return 0;
  return Math.max(0, Math.min(100, (1 - (idle - prev.idle) / (total - prev.total)) * 100));
}

async function ram(): Promise<{ used: number; total: number }> {
  try {
    const m = Object.fromEntries((await fs.readFile("/proc/meminfo", "utf8")).split("\n").map((l) => l.split(/:\s+/)).filter((p) => p.length === 2).map(([k, v]) => [k, parseInt(v!, 10) / 1024]));
    return { used: (m.MemTotal ?? 0) - (m.MemAvailable ?? 0), total: m.MemTotal ?? 0 };
  } catch {
    return { used: (os.totalmem() - os.freemem()) / 1048576, total: os.totalmem() / 1048576 };
  }
}

async function disk(): Promise<{ used: number; total: number }> {
  try {
    const s = await fs.statfs("/");
    const total = (s.blocks * s.bsize) / 2 ** 30;
    return { used: total - (s.bavail * s.bsize) / 2 ** 30, total };
  } catch {
    return { used: 0, total: 0 };
  }
}

export async function takeSample(): Promise<Sample> {
  const [gpu, procs, ollama, img, cpu, mem, dsk] = await Promise.all([gpuInfo(), gpuProcs(), getStatus(), imageHealth(), cpuPct(), ram(), disk()]);
  const act = activitySnapshot();
  const [l1, l5, l15] = os.loadavg();
  return {
    t: Date.now(),
    gpu,
    procs,
    ollama: {
      online: ollama.online,
      loaded: ollama.loadedModels.map((m) => ({ name: m.name, vramMiB: Math.round(m.sizeVram / 1048576), ctx: m.contextLength ?? null, expiresAt: m.expiresAt ?? null })),
    },
    imageSvc: { running: img.ok, loaded: img.loaded ?? false, busy: img.busy ?? false },
    host: { cpuPct: Math.round(cpu * 10) / 10, load: [l1 ?? 0, l5 ?? 0, l15 ?? 0], cpus: os.cpus().length, ramUsedMiB: Math.round(mem.used), ramTotalMiB: Math.round(mem.total), diskUsedGiB: Math.round(dsk.used * 10) / 10, diskTotalGiB: Math.round(dsk.total * 10) / 10 },
    activity: { chat: act.chat, image: act.image, tokensPerSec: act.lastTokensPerSec === null ? null : Math.round(act.lastTokensPerSec * 10) / 10 },
  };
}

/** Start background sampling (once per server process) so charts have history when an admin opens the page. */
export function ensureSampler() {
  if (state.timer) return;
  const tick = async () => {
    try {
      const s = await takeSample();
      pushToRing(s);
    } catch (err) {
      console.error("[monitor]", err);
    }
  };
  void tick();
  state.timer = setInterval(tick, 5000);
  state.timer.unref?.();
}

export function pushToRing(s: Sample) {
  const last = state.ring[state.ring.length - 1];
  if (last && s.t - last.t < RING_EVERY_MS) return;
  state.ring.push(s);
  if (state.ring.length > HISTORY_MAX) state.ring.shift();
}

export const history = () => state.ring.slice();
