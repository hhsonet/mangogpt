"use client";
import { AlertTriangle, RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ChatError } from "@/hooks/useChat";

export function ErrorBanner({ error, onRetry, onDismiss }: { error: ChatError; onRetry?: () => void; onDismiss: () => void }) {
  return (
    <div role="alert" className="my-3 flex items-start gap-3 rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm">
      <AlertTriangle size={16} className="mt-0.5 shrink-0 text-danger" />
      <div className="flex-1">{error.message}</div>
      {onRetry && error.code !== "model_missing" && (
        <Button size="sm" variant="outline" onClick={onRetry}>
          <RefreshCw size={13} /> Retry
        </Button>
      )}
      <Button size="icon" variant="ghost" onClick={onDismiss} aria-label="Dismiss">
        <X size={14} />
      </Button>
    </div>
  );
}
