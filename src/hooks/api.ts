"use client";
import useSWR, { mutate } from "swr";
import type { AppSettings, ConversationSummary, ModelInfo, OllamaStatus } from "@/types";

export class ApiError extends Error {
  constructor(
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...init?.headers } });
  } catch {
    throw new ApiError("Cannot reach the server. Check your connection (or your SSH tunnel).", "network");
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(body?.message ?? `Request failed (${res.status})`, body?.code);
  return body as T;
}

const get = <T,>(url: string) => api<T>(url);

export const refreshConversations = () => mutate((key) => typeof key === "string" && key.startsWith("/api/conversations"));

export function useConversations(q = "") {
  const key = q.trim() ? `/api/conversations?q=${encodeURIComponent(q.trim())}` : "/api/conversations";
  const { data, error, isLoading } = useSWR<{ conversations: ConversationSummary[] }>(key, get, { keepPreviousData: true });
  return { conversations: data?.conversations ?? [], error, isLoading };
}

export function useModels() {
  const { data, error, isLoading, mutate: refresh } = useSWR<{ models: ModelInfo[] }>("/api/models", get, {
    revalidateOnFocus: false,
    shouldRetryOnError: false,
  });
  return { models: data?.models ?? [], error: error as ApiError | undefined, isLoading, refresh };
}

export function useSettings() {
  const { data, mutate: refresh } = useSWR<AppSettings>("/api/settings", get, { revalidateOnFocus: false });
  const update = async (patch: Partial<AppSettings>) => {
    const next = await api<AppSettings>("/api/settings", { method: "PATCH", body: JSON.stringify(patch) });
    await refresh(next, { revalidate: false });
    return next;
  };
  return { settings: data, update };
}

export function useImageStatus() {
  const { data } = useSWR<{ enabled: boolean; running: boolean; available: boolean; loaded: boolean }>("/api/images/status", get, { refreshInterval: 30000, revalidateOnFocus: false });
  return { available: data?.available ?? false };
}

export function useStatus() {
  const { data, mutate: refresh } = useSWR<OllamaStatus>("/api/status", get, { refreshInterval: 15000 });
  return { status: data, refresh };
}
