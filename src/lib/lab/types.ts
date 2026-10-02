export interface LabProject {
  id: string;
  name: string;
  slug: string;
  description: string;
  archived: boolean;
  created_at: string;
  updated_at: string;
  last_opened_at: string | null;
  notebook_count?: number;
  used_bytes?: number;
}

export interface FileEntry {
  name: string;
  path: string;
  kind: "dir" | "file" | "link";
  size: number;
  mtime: number;
  is_notebook: boolean;
}

/** nbformat output objects are kept exactly as stored so saving never loses information. */
export type NbOutput = Record<string, unknown> & { output_type: string };

export interface NbCellJson {
  id: string;
  cell_type: "code" | "markdown" | "raw";
  source: string | string[];
  metadata: Record<string, unknown>;
  outputs?: NbOutput[];
  execution_count?: number | null;
  [k: string]: unknown;
}

export interface NbJson {
  nbformat: number;
  nbformat_minor: number;
  metadata: Record<string, unknown>;
  cells: NbCellJson[];
}

export interface OpenedNotebook {
  id: string;
  path: string;
  name: string;
  etag: string;
  version: number;
  size: number;
  notebook: NbJson;
}

export interface Revision {
  id: string;
  size: number;
  created_at: string;
}

export type RuntimeStatus = "none" | "starting" | "running" | "stopping";
export type KernelState = "none" | "starting" | "idle" | "busy" | "restarting" | "dead";
export type ExecState = "queued" | "running" | "ok" | "error" | "aborted" | "died";

export interface RuntimeUsage {
  ram_mb: number | null;
  gpu_mib: number | null;
  cpu_pct: number | null;
}

export interface RuntimeInfo {
  status: RuntimeStatus;
  error?: string | null;
  reason?: string;
  project_id?: string;
  project_name?: string;
  started_at?: string;
  idle_timeout_min?: number;
  limits?: { cpu_quota_pct: number; mem_max_mb: number; gpu_budget_mib: number };
  usage?: RuntimeUsage;
  kernels?: { path: string; state: KernelState; execution_count: number; running: number }[];
}

/** What the server sends on the project socket. */
export type LabEvent =
  | { type: "hello"; runtime: RuntimeInfo }
  | ({ type: "runtime" } & RuntimeInfo)
  | ({ type: "usage" } & RuntimeUsage)
  | { type: "pong" }
  | { type: "renamed"; from: string; to: string }
  | { type: "error"; code: string; message: string; path?: string; cell_id?: string }
  | { type: "kernel"; path: string; state: KernelState; execution_count: number }
  | { type: "snapshot"; path: string; kernel: KernelState; execution_count: number; executions: { cell_id: string; msg_id: string; state: ExecState; execution_count: number | null; outputs: NbOutput[] }[] }
  | { type: "exec"; path: string; cell_id: string; msg_id: string; state: ExecState; execution_count?: number | null; duration_ms?: number }
  | { type: "output"; path: string; cell_id: string; msg_id: string; output: NbOutput }
  | { type: "clear_output"; path: string; cell_id: string; msg_id: string }
  | { type: "update_display"; path: string; cell_id: string; msg_id: string; index: number; data: Record<string, unknown>; metadata: Record<string, unknown> };
