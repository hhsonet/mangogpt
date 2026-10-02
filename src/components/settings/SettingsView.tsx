"use client";
import { ArrowLeft, Menu, RefreshCw } from "lucide-react";
import { useTheme } from "next-themes";
import Link from "next/link";
import { useState } from "react";
import { describeModel } from "@/components/chat/ModelSelector";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useModels, useSettings, useStatus } from "@/hooks/api";
import { useApp } from "@/hooks/useApp";
import { useMounted } from "@/hooks/useLocalFlag";
import { cn } from "@/lib/utils/cn";
import type { AppSettings } from "@/types";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-border py-6">
      <h2 className="mb-4 text-sm font-semibold">{title}</h2>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div role="group" aria-label={label}>
      <span className="mb-1 block text-sm">{label}</span>
      {children}
    </div>
  );
}

function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex rounded-md border border-border p-0.5" role="radiogroup">
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn("cursor-pointer rounded px-3 py-1 text-sm", value === o.value ? "bg-surface-2 font-medium" : "text-muted hover:text-fg")}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function SettingsView() {
  const { settings, update } = useSettings();
  const { models, error: modelsError, refresh } = useModels();
  const { status, refresh: refreshStatus } = useStatus();
  const { theme, setTheme } = useTheme();
  const { setMobileOpen } = useApp();
  const [edits, setEdits] = useState<Partial<AppSettings>>({});
  const [saved, setSaved] = useState(false);
  const mounted = useMounted();

  if (!settings) return <div className="p-6 text-sm text-muted">Loading…</div>;
  const draft: AppSettings = { ...settings, ...edits };
  const set = <K extends keyof AppSettings>(k: K, v: AppSettings[K]) => setEdits((e) => ({ ...e, [k]: v }));
  const save = async () => {
    await update(draft);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  return (
    <div className="h-dvh overflow-y-auto">
      <div className="mx-auto max-w-2xl px-4 pb-16">
        <header className="flex h-12 items-center gap-2">
          <Button variant="ghost" size="icon" className="md:hidden" onClick={() => setMobileOpen(true)} aria-label="Open sidebar">
            <Menu size={18} />
          </Button>
          <Link href="/" className="flex items-center gap-1.5 text-sm text-muted hover:text-fg">
            <ArrowLeft size={15} /> Back to chat
          </Link>
        </header>
        <h1 className="mb-2 mt-4 text-xl font-semibold">Settings</h1>

        <Section title="AI">
          <Field label="Default model" hint="Used for new chats. Changing the model in the composer also updates this.">
            <select
              value={draft.defaultModel || models[0]?.name || ""}
              onChange={(e) => set("defaultModel", e.target.value)}
              className="h-9 w-full rounded-md border border-border bg-bg px-2 text-sm"
            >
              {draft.defaultModel && !models.some((m) => m.name === draft.defaultModel) && <option value={draft.defaultModel}>{draft.defaultModel} (not installed)</option>}
              {models.map((m) => (
                <option key={m.name} value={m.name}>
                  {m.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label={`Temperature: ${draft.temperature.toFixed(2)}`} hint="Lower is more focused, higher is more creative.">
            <input type="range" min={0} max={2} step={0.05} value={draft.temperature} onChange={(e) => set("temperature", Number(e.target.value))} className="w-full accent-[var(--accent)]" />
          </Field>
          <Field label={`Top P: ${draft.topP.toFixed(2)}`}>
            <input type="range" min={0} max={1} step={0.05} value={draft.topP} onChange={(e) => set("topP", Number(e.target.value))} className="w-full accent-[var(--accent)]" />
          </Field>
          <Field label="Context length (tokens)" hint="Larger values use more GPU memory. 8192 is a safe default on a ~16 GB GPU.">
            <Input type="number" min={512} max={131072} step={512} value={draft.numCtx} onChange={(e) => set("numCtx", Number(e.target.value))} />
          </Field>
          <Field label="Default system prompt">
            <textarea
              value={draft.systemPrompt}
              onChange={(e) => set("systemPrompt", e.target.value)}
              rows={5}
              className="w-full rounded-md border border-border bg-transparent p-3 text-sm focus-visible:outline-2 focus-visible:outline-accent"
            />
          </Field>
          <Button variant="primary" onClick={save}>
            {saved ? "Saved ✓" : "Save AI settings"}
          </Button>
        </Section>

        <Section title="Appearance">
          <Group label="Theme">
            {mounted && (
              <Segmented
                value={(theme ?? "dark") as "dark" | "light" | "system"}
                onChange={(v) => {
                  setTheme(v);
                  void update({ theme: v });
                }}
                options={[
                  { value: "light", label: "Light" },
                  { value: "dark", label: "Dark" },
                  { value: "system", label: "System" },
                ]}
              />
            )}
          </Group>
          <Group label="Font size">
            <Segmented
              value={draft.fontSize}
              onChange={(v) => {
                set("fontSize", v);
                void update({ fontSize: v });
              }}
              options={[
                { value: "sm", label: "Small" },
                { value: "md", label: "Medium" },
                { value: "lg", label: "Large" },
              ]}
            />
          </Group>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.compact}
              onChange={(e) => {
                set("compact", e.target.checked);
                void update({ compact: e.target.checked });
              }}
            />
            Compact mode (tighter message spacing)
          </label>
        </Section>

        <Section title="Ollama">
          <div className="flex items-center justify-between rounded-md border border-border p-3 text-sm">
            <div>
              <div className="flex items-center gap-2">
                <span className={cn("h-2 w-2 rounded-full", status?.online ? "bg-emerald-500" : "bg-danger")} />
                {status === undefined ? "Checking…" : status.online ? `Online · v${status.version}` : "Offline"}
              </div>
              {status && !status.online && <p className="mt-1 text-xs text-danger">{status.error}</p>}
              {status?.loadedModels.map((m) => (
                <p key={m.name} className="mt-1 text-xs text-muted">
                  Loaded in GPU: {m.name} ({(m.sizeVram / 2 ** 30).toFixed(1)} GiB{m.contextLength ? `, ctx ${m.contextLength}` : ""})
                </p>
              ))}
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void refresh();
                void refreshStatus();
              }}
            >
              <RefreshCw size={13} /> Refresh
            </Button>
          </div>
          <div>
            <h3 className="mb-2 text-sm">Installed models</h3>
            {modelsError && <p className="text-sm text-danger">{modelsError.message}</p>}
            <ul className="divide-y divide-border rounded-md border border-border">
              {models.map((m) => (
                <li key={m.name} className="flex items-center justify-between px-3 py-2 text-sm">
                  <span className="font-medium">{m.name}</span>
                  <span className="text-xs text-muted">{describeModel(m)}</span>
                </li>
              ))}
              {models.length === 0 && !modelsError && <li className="px-3 py-2 text-sm text-muted">No models installed.</li>}
            </ul>
          </div>
        </Section>

        <Section title="Keyboard shortcuts">
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
            {[
              ["Ctrl/⌘ + K", "Search conversations"],
              ["Ctrl/⌘ + N or Ctrl/⌘ + Shift + O", "New chat"],
              ["Ctrl/⌘ + /", "Focus prompt"],
              ["Esc", "Stop generation / close dialogs"],
              ["Enter / Shift + Enter", "Send / new line"],
            ].map(([k, v]) => (
              <div key={k} className="contents">
                <dt><kbd className="rounded border border-border px-1.5 py-0.5 text-xs">{k}</kbd></dt>
                <dd className="text-muted">{v}</dd>
              </div>
            ))}
          </dl>
        </Section>
      </div>
    </div>
  );
}
