import { createStore } from "zustand";
import type { ApiError } from "@/hooks/api";
import { runtimeApi } from "./api";
import type { KernelState, LabEvent, RuntimeInfo } from "./types";

export interface LimitConflict {
  message: string;
  /** Runtimes of the same user that are in the way. */
  others: { project_id: string; project_name: string }[];
  retry: () => void;
}

export interface RuntimeState {
  conn: "connecting" | "open" | "closed";
  runtime: RuntimeInfo;
  kernels: Record<string, KernelState>;
  /** Set while this browser is waiting for a runtime it asked for. */
  connecting: boolean;
  message: string | null;
  conflict: LimitConflict | null;
}

type Handler = (e: LabEvent) => void;

const PING_MS = 25_000;
const START_TIMEOUT_MS = 90_000;

/**
 * One WebSocket per open project: runtime status, resource use and the events of every notebook the page has attached.
 * It reconnects by itself; on every (re)connect it attaches again, and the server answers with what the page missed.
 */
export class RuntimeClient {
  readonly store = createStore<RuntimeState>()(() => ({ conn: "connecting", runtime: { status: "none" }, kernels: {}, connecting: false, message: null, conflict: null }));
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Set<Handler>>();
  private closed = false;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;

  constructor(readonly projectId: string) {}

  // ------------------------------------------------------------------ connection
  connect() {
    this.closed = false;
    this.open();
  }

  close() {
    this.closed = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.pingTimer);
    this.ws?.close(1000);
    this.ws = null;
  }

  private open() {
    if (this.closed || (this.ws && this.ws.readyState <= WebSocket.OPEN)) return;
    this.store.setState({ conn: "connecting" });
    const proto = location.protocol === "https:" ? "wss" : "ws";
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${proto}://${location.host}/lab-ws/v1/projects/${this.projectId}/runtime`);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.store.setState({ conn: "open" });
      for (const path of this.handlers.keys()) this.send({ type: "attach", path });
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => this.send({ type: "ping" }), PING_MS);
    };
    ws.onmessage = (m) => {
      try {
        this.dispatch(JSON.parse(m.data as string) as LabEvent);
      } catch {
        /* ignore a malformed frame */
      }
    };
    ws.onclose = () => {
      clearInterval(this.pingTimer);
      if (this.ws === ws) this.ws = null;
      this.store.setState({ conn: "closed" });
      this.scheduleReconnect();
    };
    ws.onerror = () => ws.close();
  }

  private scheduleReconnect() {
    if (this.closed) return;
    clearTimeout(this.reconnectTimer);
    const delay = Math.min(15_000, 500 * 2 ** Math.min(this.attempt++, 5));
    this.reconnectTimer = setTimeout(() => this.open(), delay);
  }

  private send(msg: Record<string, unknown>) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private async whenOpen(ms = 10_000) {
    const t0 = Date.now();
    while (this.store.getState().conn !== "open") {
      if (Date.now() - t0 > ms) throw new Error("Can’t reach the server right now. Check your connection and try again.");
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  // ------------------------------------------------------------------ events
  private dispatch(e: LabEvent) {
    switch (e.type) {
      case "hello":
        this.store.setState({ runtime: e.runtime });
        return;
      case "runtime": {
        const { type: _t, ...info } = e;
        void _t;
        this.store.setState((s) => ({ runtime: info.status === "none" ? { status: "none", error: info.error ?? null, reason: info.reason } : { ...s.runtime, ...info }, kernels: info.status === "none" ? {} : s.kernels }));
        this.all(e);
        return;
      }
      case "usage":
        this.store.setState((s) => ({ runtime: { ...s.runtime, usage: { ram_mb: e.ram_mb, gpu_mib: e.gpu_mib, cpu_pct: e.cpu_pct } } }));
        return;
      case "kernel":
        this.store.setState((s) => ({ kernels: { ...s.kernels, [e.path]: e.state } }));
        break;
      case "renamed":
        this.all(e);
        return;
      case "pong":
        return;
    }
    if ("path" in e && typeof e.path === "string") for (const h of this.handlers.get(e.path) ?? []) h(e);
  }

  private all(e: LabEvent) {
    for (const set of this.handlers.values()) for (const h of set) h(e);
  }

  /** Receive the events of one notebook. Returns the function that stops listening. */
  attach(path: string, handler: Handler): () => void {
    let set = this.handlers.get(path);
    if (!set) this.handlers.set(path, (set = new Set()));
    set.add(handler);
    if (set.size === 1) this.send({ type: "attach", path });
    return () => {
      set.delete(handler);
      if (set.size === 0) {
        this.handlers.delete(path);
        this.send({ type: "detach", path });
      }
    };
  }

  // ------------------------------------------------------------------ kernel commands
  async execute(path: string, cellId: string, code: string) {
    await this.whenOpen();
    this.send({ type: "execute", path, cell_id: cellId, code });
  }
  interrupt(path: string) {
    this.send({ type: "interrupt", path });
  }
  restartKernel(path: string) {
    this.send({ type: "restart", path });
  }
  ack(path: string, msgId: string) {
    this.send({ type: "ack", path, msg_id: msgId });
  }

  // ------------------------------------------------------------------ runtime lifecycle
  /** Starts the runtime if needed and resolves when it is running. Rejects with a readable message, or opens the "limit reached" dialog. */
  async ensureRuntime(): Promise<void> {
    const status = () => this.store.getState().runtime.status;
    if (status() === "running") return;
    if (status() === "stopping") await this.waitFor((r) => r.status === "none", 20_000).catch(() => undefined);
    this.store.setState({ connecting: true, message: null });
    try {
      let info: RuntimeInfo;
      try {
        info = await runtimeApi.start(this.projectId);
      } catch (e) {
        const err = e as ApiError;
        if (err.code === "runtime_limit") {
          const others = (await runtimeApi.mine().catch(() => ({ runtimes: [] as RuntimeInfo[] }))).runtimes.filter((r) => r.project_id !== this.projectId);
          this.store.setState({ conflict: { message: err.message, others: others.map((r) => ({ project_id: r.project_id!, project_name: r.project_name ?? "another project" })), retry: () => void this.ensureRuntime().catch(() => undefined) } });
        }
        this.store.setState({ message: err.message });
        throw err;
      }
      this.store.setState((s) => ({ runtime: { ...s.runtime, ...info } }));
      await this.waitFor((r) => r.status === "running", START_TIMEOUT_MS, true);
    } finally {
      this.store.setState({ connecting: false });
    }
  }

  async stopRuntime() {
    await runtimeApi.stop(this.projectId);
    this.store.setState({ runtime: { status: "none" }, kernels: {} });
  }

  /** Stops the runtimes that block this one, then starts this one. */
  async replaceOthers(others: { project_id: string }[], retry: () => void) {
    this.store.setState({ conflict: null });
    await Promise.all(others.map((o) => runtimeApi.stop(o.project_id)));
    retry();
  }

  dismissConflict() {
    this.store.setState({ conflict: null });
  }

  private waitFor(done: (r: RuntimeInfo) => boolean, ms: number, failOnError = false): Promise<void> {
    return new Promise((resolve, reject) => {
      const check = (r: RuntimeInfo) => {
        if (done(r)) return cleanup(), resolve(), true;
        if (failOnError && r.status === "none" && r.error) return cleanup(), reject(new Error(r.error)), true;
        return false;
      };
      const unsub = this.store.subscribe((s) => void check(s.runtime));
      // The socket may be reconnecting: poll over HTTP as a fallback so a start is never missed.
      const poll = setInterval(() => {
        runtimeApi.status(this.projectId).then((r) => {
          if (r.status !== this.store.getState().runtime.status || r.error) this.store.setState((s) => ({ runtime: { ...s.runtime, ...r } }));
        }).catch(() => undefined);
      }, 3000);
      const timer = setTimeout(() => (cleanup(), reject(new Error("The runtime is taking too long to start. Please try again."))), ms);
      const cleanup = () => {
        unsub();
        clearInterval(poll);
        clearTimeout(timer);
      };
      check(this.store.getState().runtime);
    });
  }
}
