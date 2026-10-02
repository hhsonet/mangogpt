"use client";
import { BookOpen, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import useSWR from "swr";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { projectsApi } from "@/lib/lab/api";
import { humanSize } from "@/lib/lab/files";
import type { LabProject } from "@/lib/lab/types";

const when = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

function NewProject({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (v: boolean) => void; onCreated: (p: LabProject) => void }) {
  const [name, setName] = useState("");
  const [template, setTemplate] = useState<"welcome" | "blank">("welcome");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const submit = async () => {
    setBusy(true);
    setErr("");
    try {
      onCreated(await projectsApi.create({ name: name.trim(), template }));
      setName("");
      onOpenChange(false);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="New project" description="A project is a folder of notebooks and files with its own workspace.">
        <form onSubmit={(e) => { e.preventDefault(); if (name.trim()) void submit(); }} className="space-y-3">
          <label className="block text-sm">
            Name
            <Input autoFocus value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="Image classifier" className="mt-1" />
          </label>
          <fieldset className="space-y-1.5 text-sm">
            <legend className="mb-1">Start with</legend>
            {([["welcome", "A welcome notebook", "A short tour of how notebooks work."], ["blank", "An empty project", "Just a README."]] as const).map(([v, title, hint]) => (
              <label key={v} className="flex cursor-pointer items-start gap-2 rounded-md border border-border p-2 has-[:checked]:border-accent">
                <input type="radio" name="template" checked={template === v} onChange={() => setTemplate(v)} className="mt-1" />
                <span><span className="font-medium">{title}</span><br /><span className="text-xs text-muted">{hint}</span></span>
              </label>
            ))}
          </fieldset>
          {err && <p role="alert" className="text-sm text-danger">{err}</p>}
          <div className="flex justify-end gap-2">
            <DialogClose asChild><Button variant="ghost">Cancel</Button></DialogClose>
            <Button type="submit" variant="primary" disabled={busy || !name.trim()}>{busy ? "Creating…" : "Create project"}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ProjectsSection() {
  const router = useRouter();
  const { data, error, mutate, isLoading } = useSWR("lab-projects", projectsApi.list, { revalidateOnFocus: false });
  const [creating, setCreating] = useState(false);
  const [doomed, setDoomed] = useState<LabProject | null>(null);
  const [delErr, setDelErr] = useState("");
  const projects = data?.projects ?? [];
  const full = data ? projects.length >= data.limits.max_projects : false;

  return (
    <section aria-labelledby="projects-h">
      <div className="mb-2 mt-8 flex items-center justify-between">
        <h2 id="projects-h" className="text-sm font-semibold">Projects</h2>
        <Button size="sm" variant="primary" onClick={() => setCreating(true)} disabled={full} title={full ? `You can have up to ${data?.limits.max_projects} projects` : undefined}>
          <Plus size={15} /> New project
        </Button>
      </div>
      {isLoading && <p className="py-6 text-center text-sm text-muted">Loading projects…</p>}
      {error && <p role="alert" className="text-sm text-danger">Couldn’t load your projects. {(error as Error).message}</p>}
      {data && projects.length === 0 && (
        <div className="rounded-lg border border-dashed border-border p-8 text-center">
          <BookOpen size={22} className="mx-auto mb-2 text-muted" />
          <p className="font-medium">No projects yet</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted">Create a project to start a notebook. Everything you save stays on this server.</p>
          <Button variant="primary" className="mt-4" onClick={() => setCreating(true)}><Plus size={15} /> Create your first project</Button>
        </div>
      )}
      {projects.length > 0 && (
        <ul className="grid gap-3 sm:grid-cols-2">
          {projects.map((p) => (
            <li key={p.id} className="group relative rounded-lg border border-border p-4 hover:border-accent/60">
              <Link href={`/lab/p/${p.id}`} className="block after:absolute after:inset-0">
                <p className="truncate font-medium">{p.name}</p>
                <p className="mt-1 text-xs text-muted">
                  {p.notebook_count ?? 0} notebook{p.notebook_count === 1 ? "" : "s"} · {humanSize(p.used_bytes ?? 0)} · updated {when(p.updated_at)}
                </p>
              </Link>
              <button
                aria-label={`Delete ${p.name}`}
                onClick={() => { setDelErr(""); setDoomed(p); }}
                className="absolute right-2 top-2 z-10 cursor-pointer rounded p-1.5 text-muted opacity-0 hover:bg-surface-2 hover:text-danger focus:opacity-100 group-hover:opacity-100 max-md:opacity-100"
              >
                <Trash2 size={15} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <NewProject open={creating} onOpenChange={setCreating} onCreated={(p) => { void mutate(); router.push(`/lab/p/${p.id}`); }} />

      <Dialog open={Boolean(doomed)} onOpenChange={(v) => !v && setDoomed(null)}>
        <DialogContent title={`Delete “${doomed?.name ?? ""}”?`} description="All notebooks and files in this project are removed from the server. This can’t be undone.">
          {delErr && <p role="alert" className="mb-2 text-sm text-danger">{delErr}</p>}
          <div className="flex justify-end gap-2">
            <DialogClose asChild><Button variant="ghost">Keep project</Button></DialogClose>
            <Button
              variant="primary"
              className="bg-danger text-white hover:bg-danger/90"
              onClick={async () => {
                if (!doomed) return;
                try {
                  await projectsApi.remove(doomed.id);
                  setDoomed(null);
                  void mutate();
                } catch (e) {
                  setDelErr((e as Error).message);
                }
              }}
            >
              Delete project
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}
