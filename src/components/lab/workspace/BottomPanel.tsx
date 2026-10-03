"use client";
import { Package, TerminalSquare, X } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { PackagesPanel } from "./PackagesPanel";
import { TerminalPanel } from "./TerminalPanel";

export type PanelTab = "terminal" | "packages";

/** The tool drawer under the editor: terminal and packages. Both stay mounted so a running shell or install is never interrupted by switching tabs. */
export function BottomPanel({ projectId, tab, onTab, onClose }: { projectId: string; tab: PanelTab; onTab: (t: PanelTab) => void; onClose: () => void }) {
  return (
    <section aria-label="Tools" className="flex h-full min-h-0 flex-col border-t border-border bg-bg">
      <div className="flex shrink-0 items-center gap-1 border-b border-border bg-surface/50 px-2" role="tablist" aria-label="Tool panels">
        {([["terminal", "Terminal", TerminalSquare], ["packages", "Packages", Package]] as const).map(([id, label, Icon]) => (
          <button key={id} role="tab" aria-selected={tab === id} onClick={() => onTab(id)} className={cn("flex cursor-pointer items-center gap-1.5 border-b-2 px-3 py-1.5 text-sm", tab === id ? "border-accent font-medium" : "border-transparent text-muted hover:text-fg")}>
            <Icon size={14} /> {label}
          </button>
        ))}
        <button aria-label="Close panel" onClick={onClose} className="ml-auto cursor-pointer rounded p-1.5 text-muted hover:bg-surface-2 hover:text-fg">
          <X size={15} />
        </button>
      </div>
      <div className="relative min-h-0 flex-1">
        <div className="absolute inset-0" hidden={tab !== "terminal"}>
          <TerminalPanel projectId={projectId} visible={tab === "terminal"} />
        </div>
        <div className="absolute inset-0" hidden={tab !== "packages"}>
          <PackagesPanel projectId={projectId} />
        </div>
      </div>
    </section>
  );
}
