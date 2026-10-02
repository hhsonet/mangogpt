"use client";
import { createContext, useContext, useEffect, useState } from "react";
import { useStore } from "zustand";
import { RuntimeClient, type RuntimeState } from "@/lib/lab/runtime";

const Ctx = createContext<RuntimeClient | null>(null);

/** Owns the project's runtime connection for as long as the workspace is open. */
export function RuntimeProvider({ projectId, children }: { projectId: string; children: React.ReactNode }) {
  const [client] = useState(() => new RuntimeClient(projectId));
  useEffect(() => {
    client.connect();
    return () => client.close();
  }, [client]);
  return <Ctx.Provider value={client}>{children}</Ctx.Provider>;
}

export function useRuntimeClient(): RuntimeClient {
  const c = useContext(Ctx);
  if (!c) throw new Error("useRuntimeClient must be used inside RuntimeProvider");
  return c;
}

export function useRuntime<T>(selector: (s: RuntimeState) => T): T {
  return useStore(useRuntimeClient().store, selector);
}
