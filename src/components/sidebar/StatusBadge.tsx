"use client";
import { useStatus } from "@/hooks/api";
import { cn } from "@/lib/utils/cn";

export function StatusBadge({ compact }: { compact?: boolean }) {
  const { status } = useStatus();
  const online = status?.online;
  const loaded = status?.loadedModels[0]?.name;

  return (
    <div
      className={cn("flex items-center gap-2 text-xs", compact && "max-sm:hidden")}
      title={status && !online ? status.error : loaded ? `Loaded: ${loaded}` : undefined}
    >
      <span className={cn("h-2 w-2 rounded-full", status === undefined ? "bg-muted" : online ? "bg-emerald-500" : "bg-danger")} />
      <span className="text-muted">{status === undefined ? "Checking…" : online ? "Ollama Online" : "Ollama Offline"}</span>
         </div>
  );
}
