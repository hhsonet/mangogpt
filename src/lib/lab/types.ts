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
  disk_mb?: number | null;
  disk_quota_mb?: number | null;
}

export interface HistoryPoint {
  t: number;
  ram_mb: number | null;
  gpu_mib: number | null;
  cpu_pct: number | null;
}

export interface LimitNotice {
  kind: "gpu" | "disk";
  level: "warn" | "blocked" | "stopped" | "ok";
  message: string;
}

export interface TerminalInfo {
  id: string;
  title: string;
}

export interface PackageInfo {
  name: string;
  version: string;
}

export interface PackageJob {
  id: string;
  action: "install" | "uninstall";
  specs: string[];
  status: "running" | "ok" | "error" | "timeout";
  exit_code: number | null;
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
  blocked?: boolean;
  terminals?: number;
  kernels?: { path: string; state: KernelState; execution_count: number; running: number }[];
}

/** What the server sends on the project socket. */
export type LabEvent =
  | { type: "hello"; runtime: RuntimeInfo }
  | ({ type: "runtime" } & RuntimeInfo)
  | ({ type: "usage" } & RuntimeUsage)
  | { type: "pong" }
  | { type: "limit"; kind: "gpu" | "disk"; level: "warn" | "blocked" | "stopped" | "ok"; message: string }
  | { type: "packages"; job_id: string; status: string }
  | { type: "renamed"; from: string; to: string }
  | { type: "error"; code: string; message: string; path?: string; cell_id?: string }
  | { type: "kernel"; path: string; state: KernelState; execution_count: number }
  | { type: "snapshot"; path: string; kernel: KernelState; execution_count: number; executions: { cell_id: string; msg_id: string; state: ExecState; execution_count: number | null; outputs: NbOutput[] }[] }
  | { type: "exec"; path: string; cell_id: string; msg_id: string; state: ExecState; execution_count?: number | null; duration_ms?: number }
  | { type: "output"; path: string; cell_id: string; msg_id: string; output: NbOutput }
  | { type: "clear_output"; path: string; cell_id: string; msg_id: string }
  | { type: "update_display"; path: string; cell_id: string; msg_id: string; index: number; data: Record<string, unknown>; metadata: Record<string, unknown> };

// ---------------------------------------------------------------- assistant
export interface AssistantModel {
  name: string;
  size_gb: number;
  tools: boolean;
  thinking: boolean;
  vision: boolean;
}

export type AssistantMode = "chat" | "explain" | "fix" | "optimize" | "generate";

export type AssistantAction =
  | { id: string; type: "edit_cell"; status: ActionStatus; payload: { cell_id: string; cell_number: number; old_source: string; source: string; applied_prev?: string } }
  | { id: string; type: "insert_cell"; status: ActionStatus; payload: { position: "after" | "before" | "end"; ref_cell_id: string | null; ref_cell_number: number | null; cell_type: "code" | "markdown"; source: string; applied_prev?: string } }
  | { id: string; type: "run_cell"; status: ActionStatus; payload: { cell_id: string; cell_number: number } }
  | { id: string; type: "install_packages"; status: ActionStatus; payload: { specs: string[] } };
export type ActionStatus = "proposed" | "applied" | "rejected";

export interface ToolChip {
  id: string;
  name: string;
  status: "running" | "done" | "error";
  summary: string;
}

export interface AssistantMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  thinking?: string;
  tools: ToolChip[];
  actions: AssistantAction[];
  model?: string;
  streaming?: boolean;
  error?: string;
  /** Set when the answer was cut because the notebook was too big to show in full. */
  trimmed?: boolean;
}

export interface AssistantThread {
  id: string;
  title: string;
  last_at: string;
}

/** What the browser tells the server about the open notebook (including edits that are not saved yet). */
export interface NotebookSnapshot {
  path: string;
  selected: string | null;
  kernel: string | null;
  cells: { id: string; type: "code" | "markdown" | "raw"; source: string; output: string; execution_count: number | null; state: "idle" | "queued" | "running"; failed: boolean }[];
}

export type AssistantEvent =
  | { type: "meta"; thread_id: string; user_message_id: string; assistant_message_id: string; model: string; title: string; tools: boolean; trimmed: boolean }
  | { type: "thinking"; delta: string }
  | { type: "content"; delta: string }
  | { type: "tool"; id: string; name: string; status: "running" | "done" | "error"; summary: string }
  | { type: "action"; action: AssistantAction }
  | { type: "done"; stats: { tokens_in: number; tokens_out: number; ms: number } }
  | { type: "error"; code: string; message: string };
