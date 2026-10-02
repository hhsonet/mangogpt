"use client";
import { Check, ChevronDown, Cpu, Eye } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown";
import { useModels } from "@/hooks/api";
import { formatBytes } from "@/lib/utils/format";
import type { ModelInfo } from "@/types";

const HINTS: [RegExp, string][] = [
  [/deepseek-r1/, "Reasoning"],
  [/qwen.*coder|coder/, "Coding"],
  [/qwen/, "General & coding"],
  [/llama/, "General purpose"],
  [/gemma/, "General purpose"],
  [/mistral|mixtral/, "General purpose"],
  [/embed|nomic|bge/, "Embeddings"],
];

export function describeModel(m: ModelInfo): string {
  const hint = HINTS.find(([re]) => re.test(m.name.toLowerCase()))?.[1];
  return [hint, m.parameterSize, formatBytes(m.sizeBytes)].filter(Boolean).join(" · ");
}

interface Props {
  value: string;
  onChange: (model: string) => void;
  disabled?: boolean;
}

export function ModelSelector({ value, onChange, disabled }: Props) {
  const { models, error, isLoading } = useModels();
  // Embedding models can't chat; hide them from the picker.
  const chatModels = models.filter((m) => !/embed|nomic|bge/.test(m.name.toLowerCase()));

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" disabled={disabled} className="max-w-[60vw] gap-1.5 text-muted hover:text-fg" aria-label="Select model">
          <Cpu size={14} />
          <span className="truncate">{value || (isLoading ? "Loading…" : "No model")}</span>
          <ChevronDown size={13} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-80">
        {error ? (
          <div className="px-3 py-2 text-sm text-danger">{error.message}</div>
        ) : chatModels.length === 0 ? (
          <div className="px-3 py-2 text-sm text-muted">{isLoading ? "Loading models…" : "No models installed. Run `ollama pull <model>`."}</div>
        ) : (
          chatModels.map((m) => (
            <DropdownMenuItem key={m.name} onSelect={() => onChange(m.name)} className="items-start gap-3 py-2">
              <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-accent" style={{ opacity: m.name === value ? 1 : 0.25 }} />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 truncate font-medium">
                  {m.name}
                  {m.vision && <span title="Can read images" className="inline-flex items-center gap-1 rounded border border-border px-1 text-[0.65rem] font-normal text-muted"><Eye size={10} /> vision</span>}
                </span>
                <span className="block truncate text-xs text-muted">{describeModel(m)}</span>
              </span>
              {m.name === value && <Check size={14} className="mt-1 shrink-0" />}
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
