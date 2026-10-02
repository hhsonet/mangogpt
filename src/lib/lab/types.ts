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
