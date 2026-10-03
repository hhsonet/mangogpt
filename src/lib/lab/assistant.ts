import { labApi } from "@/hooks/lab";
import type { ApiError } from "@/hooks/api";
import type { ActionStatus, AssistantEvent, AssistantMessage, AssistantMode, AssistantModel, AssistantThread, NotebookSnapshot } from "./types";

const base = (id: string) => `/projects/${id}/assistant`;

export const assistantApi = {
  models: (id: string) => labApi<{ models: AssistantModel[]; default: string }>(`${base(id)}/models`),
  threads: (id: string, path: string | null) => labApi<{ threads: AssistantThread[] }>(`${base(id)}/threads${path ? `?path=${encodeURIComponent(path)}` : ""}`),
  createThread: (id: string, path: string | null) => labApi<{ id: string; title: string }>(`${base(id)}/threads`, { method: "POST", body: JSON.stringify({ path }) }),
  deleteThread: (id: string, tid: string) => labApi<null>(`${base(id)}/threads/${tid}`, { method: "DELETE" }),
  messages: (id: string, tid: string) =>
    labApi<{ messages: (Omit<AssistantMessage, "tools" | "actions"> & { tools: { name: string; summary: string; error?: boolean }[]; actions: AssistantMessage["actions"] })[] }>(`${base(id)}/threads/${tid}/messages`),
  patchAction: (id: string, actionId: string, status: ActionStatus, prev?: string) =>
    labApi<{ id: string; status: ActionStatus; payload: Record<string, unknown> }>(`${base(id)}/actions/${actionId}`, { method: "PATCH", body: JSON.stringify({ status, prev }) }),
};

/** Streams one question. Calls `onEvent` for every event; stops quietly when `signal` aborts (the Stop button). */
export async function streamChat(
  projectId: string,
  threadId: string,
  body: { message: string; mode: AssistantMode; model?: string; think: boolean; context: NotebookSnapshot | null },
  onEvent: (e: AssistantEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch(`/lab-api/v1${base(projectId)}/threads/${threadId}/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
  if (!res.ok || !res.body) {
    let err: Partial<ApiError> = {};
    try {
      err = await res.json();
    } catch {
      /* not JSON */
    }
    onEvent({ type: "error", code: err.code ?? "http_error", message: err.message ?? "The assistant couldn't be reached. Please try again." });
    return;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) {
          try {
            onEvent(JSON.parse(line) as AssistantEvent);
          } catch {
            /* ignore a damaged line */
          }
        }
      }
    }
  } catch (e) {
    if ((e as Error).name !== "AbortError") onEvent({ type: "error", code: "connection", message: "The connection dropped while the assistant was answering." });
  }
}
