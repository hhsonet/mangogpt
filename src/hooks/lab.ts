"use client";
import useSWR from "swr";
import { api } from "./api";

export interface LabLimits {
  gpu_budget_mib: number;
  cpu_quota_pct: number;
  mem_max_mb: number;
  disk_quota_mb: number;
  max_runtimes: number;
  idle_timeout_min: number;
}

export interface LabMe {
  user: { id: string; username: string; role: "admin" | "user" };
  lab: { enabled: boolean; limits: LabLimits };
}

/** MangoLab's control plane lives at /lab-api (FastAPI). The same login cookie authenticates both apps. */
export const labApi = <T,>(path: string, init?: RequestInit) => api<T>(`/lab-api/v1${path}`, init);

export function useLabMe() {
  const { data, error, isLoading, mutate } = useSWR<LabMe>("/lab-api/v1/me", (u: string) => api<LabMe>(u), {
    revalidateOnFocus: false,
    shouldRetryOnError: false,
  });
  return { me: data, error, isLoading, refresh: mutate };
}
