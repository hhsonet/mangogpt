import { labApi } from "@/hooks/lab";
import type { FileEntry, LabProject, NbJson, OpenedNotebook, Revision, RuntimeInfo } from "./types";

const q = (o: Record<string, string | undefined>) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined) as [string, string][]).toString();
const base = (id: string) => `/projects/${id}`;

export const projectsApi = {
  list: () => labApi<{ projects: LabProject[]; limits: { max_projects: number; disk_quota_mb: number } }>("/projects"),
  create: (b: { name: string; description?: string; template: "blank" | "welcome" }) => labApi<LabProject>("/projects", { method: "POST", body: JSON.stringify(b) }),
  get: (id: string) => labApi<LabProject & { limits: { disk_quota_mb: number } }>(base(id)),
  patch: (id: string, b: Partial<{ name: string; description: string; archived: boolean }>) => labApi<LabProject>(base(id), { method: "PATCH", body: JSON.stringify(b) }),
  remove: (id: string) => labApi<null>(base(id), { method: "DELETE" }),
};

export const filesApi = {
  list: (id: string, path = "") => labApi<{ path: string; entries: FileEntry[] }>(`${base(id)}/files?${q({ path })}`),
  read: (id: string, path: string) => labApi<{ path: string; content: string; etag: string; size: number }>(`${base(id)}/files/content?${q({ path })}`),
  write: (id: string, b: { path: string; content: string; base_etag?: string; create_only?: boolean }) => labApi<{ path: string; etag: string; size: number }>(`${base(id)}/files/content`, { method: "PUT", body: JSON.stringify(b) }),
  mkdir: (id: string, path: string) => labApi<{ path: string }>(`${base(id)}/files/mkdir`, { method: "POST", body: JSON.stringify({ path }) }),
  rename: (id: string, from: string, to: string) => labApi<{ path: string }>(`${base(id)}/files/rename`, { method: "POST", body: JSON.stringify({ from, to }) }),
  remove: (id: string, path: string) => labApi<null>(`${base(id)}/files?${q({ path })}`, { method: "DELETE" }),
  downloadUrl: (id: string, path: string, inline = false) => `/lab-api/v1${base(id)}/files/download?${q({ path, inline: inline ? "true" : undefined })}`,
};

export const notebooksApi = {
  create: (id: string, path: string, template: "blank" | "welcome" = "blank") => labApi<OpenedNotebook>(`${base(id)}/notebooks`, { method: "POST", body: JSON.stringify({ path, template }) }),
  open: (id: string, path: string) => labApi<OpenedNotebook>(`${base(id)}/notebooks?${q({ path })}`),
  save: (id: string, b: { path: string; notebook: NbJson; base_etag?: string; force?: boolean }) =>
    labApi<{ etag: string; version: number; size: number; saved_at: string }>(`${base(id)}/notebooks`, { method: "PUT", body: JSON.stringify(b) }),
  revisions: (id: string, path: string) => labApi<{ revisions: Revision[] }>(`${base(id)}/notebooks/revisions?${q({ path })}`),
  restore: (id: string, path: string, revision_id: string) => labApi<OpenedNotebook>(`${base(id)}/notebooks/revisions/restore`, { method: "POST", body: JSON.stringify({ path, revision_id }) }),
};

export const runtimeApi = {
  status: (id: string) => labApi<RuntimeInfo>(`${base(id)}/runtime`),
  start: (id: string) => labApi<RuntimeInfo>(`${base(id)}/runtime`, { method: "POST" }),
  stop: (id: string) => labApi<RuntimeInfo>(`${base(id)}/runtime`, { method: "DELETE" }),
  mine: () => labApi<{ runtimes: RuntimeInfo[] }>("/runtimes"),
};

export interface UploadResult {
  saved: { name: string; path: string; size: number; renamed: boolean }[];
  rejected: { name: string; message: string; code: string }[];
}

/** XMLHttpRequest rather than fetch, because only XHR reports upload progress. */
export function uploadFiles(projectId: string, dir: string, files: File[], onProgress: (fraction: number) => void): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append("dir", dir);
    files.forEach((f) => form.append("files", f, f.name));
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/lab-api/v1${base(projectId)}/files/upload`);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onerror = () => reject(new Error("Upload failed. Check your connection."));
    xhr.onload = () => {
      let body: (UploadResult & { message?: string }) | null = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* non-JSON error body */
      }
      if (xhr.status >= 200 && xhr.status < 300 && body) resolve(body);
      else reject(new Error(body?.message ?? `Upload failed (${xhr.status}).`));
    };
    xhr.send(form);
  });
}
