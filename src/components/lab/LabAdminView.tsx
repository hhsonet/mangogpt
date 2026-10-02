"use client";
import { AlertTriangle, Settings2 } from "lucide-react";
import { useState } from "react";
import useSWR from "swr";
import { AdminHeader } from "@/components/admin/AdminNav";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { labApi, type LabLimits } from "@/hooks/lab";
import { cn } from "@/lib/utils/cn";

interface LabUser {
  id: string;
  username: string;
  role: string;
  status: string;
  lab_enabled: boolean;
  explicit_grant: boolean;
  limits: LabLimits;
}

const FIELDS: { key: keyof LabLimits; label: string; unit: string; min: number; max: number }[] = [
  { key: "gpu_budget_mib", label: "GPU memory", unit: "MiB", min: 512, max: 15360 },
  { key: "cpu_quota_pct", label: "CPU", unit: "% (100 = one core)", min: 50, max: 1000 },
  { key: "mem_max_mb", label: "RAM", unit: "MB", min: 512, max: 16384 },
  { key: "disk_quota_mb", label: "Workspace disk", unit: "MB", min: 256, max: 512000 },
  { key: "max_runtimes", label: "Runtimes at once", unit: "", min: 1, max: 4 },
  { key: "idle_timeout_min", label: "Stop after idle", unit: "minutes", min: 5, max: 1440 },
];

export function LabAdminView() {
  const me = useSWR<{ lab: unknown; user: { role: string } }>("/lab-api/v1/me", (u: string) => fetch(u).then((r) => r.json()));
  const isAdmin = me.data?.user?.role === "admin";
  const users = useSWR<{ users: LabUser[] }>(isAdmin ? "/lab-api/v1/admin/users" : null, () => labApi<{ users: LabUser[] }>("/admin/users"));
  const [editing, setEditing] = useState<LabUser | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [error, setError] = useState("");

  const save = async (u: LabUser, body: Record<string, unknown>) => {
    setError("");
    try {
      await labApi(`/admin/users/${u.id}/access`, { method: "PUT", body: JSON.stringify(body) });
      await users.mutate();
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    }
  };

  const openEditor = (u: LabUser) => {
    setEditing(u);
    setDraft(Object.fromEntries(FIELDS.map((f) => [f.key, String(u.limits[f.key])])));
  };

  return (
    <div className="h-dvh overflow-y-auto">
      <div className="mx-auto max-w-4xl px-4 pb-16">
        <AdminHeader />
        <h1 className="text-xl font-semibold">MangoLab access</h1>
        <p className="mb-4 text-sm text-muted">Choose who can run notebooks, and how much of the shared server each person may use.</p>

        <p role="note" className="mb-5 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-500" />
          <span>
            <strong>Only enable people you trust.</strong> Notebook code runs on this server as the same Linux account as the rest of the system, so it could read other users’ files and the server’s secrets. Per-user isolation needs extra setup on the server (see the MangoLab docs).
          </span>
        </p>

        {error && (
          <p role="alert" className="mb-4 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm">
            {error}
          </p>
        )}
        {me.data && !isAdmin && <p className="py-12 text-center text-sm text-muted">This page is for admins only.</p>}

        {isAdmin && (
          <div className="overflow-hidden rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="bg-surface text-left text-xs text-muted">
                <tr>
                  <th className="px-3 py-2 font-medium">User</th>
                  <th className="px-3 py-2 font-medium">MangoLab</th>
                  <th className="px-3 py-2 font-medium max-sm:hidden">Limits</th>
                  <th className="w-10 px-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {users.data?.users.map((u) => (
                  <tr key={u.id}>
                    <td className="px-3 py-2.5">
                      <span className="font-medium">{u.username}</span>
                      <span className="ml-2 text-xs capitalize text-muted">{u.role}{u.status !== "active" ? ` · ${u.status}` : ""}</span>
                    </td>
                    <td className="px-3 py-2.5">
                      {u.role === "admin" ? (
                        <span className="text-xs text-muted">Always on (admin)</span>
                      ) : (
                        <button
                          role="switch"
                          aria-checked={u.lab_enabled}
                          aria-label={`MangoLab access for ${u.username}`}
                          onClick={() => save(u, { enabled: !u.lab_enabled })}
                          className={cn("relative h-5 w-9 cursor-pointer rounded-full transition-colors", u.lab_enabled ? "bg-accent" : "bg-surface-2")}
                        >
                          <span className={cn("absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all", u.lab_enabled ? "left-[1.1rem]" : "left-0.5")} />
                        </button>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-xs text-muted max-sm:hidden">
                      {(u.limits.gpu_budget_mib / 1024).toFixed(1)} GiB GPU · {u.limits.cpu_quota_pct / 100} cores · {(u.limits.mem_max_mb / 1024).toFixed(1)} GiB RAM
                    </td>
                    <td className="px-2 py-2.5">
                      <Button variant="ghost" size="icon" aria-label={`Edit limits for ${u.username}`} onClick={() => openEditor(u)}>
                        <Settings2 size={16} />
                      </Button>
                    </td>
                  </tr>
                ))}
                {users.isLoading && (
                  <tr>
                    <td colSpan={4} className="px-3 py-8 text-center text-muted">Loading…</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Dialog open={Boolean(editing)} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent title={`Limits for ${editing?.username ?? ""}`} description="Applied the next time they start a runtime.">
          <form
            className="space-y-3"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!editing) return;
              const body = Object.fromEntries(FIELDS.map((f) => [f.key, Number(draft[f.key])]));
              if (await save(editing, body)) setEditing(null);
            }}
          >
            {FIELDS.map((f) => (
              <label key={f.key} className="block text-sm">
                <span className="mb-1 block font-medium">
                  {f.label} <span className="font-normal text-muted">{f.unit}</span>
                </span>
                <Input type="number" min={f.min} max={f.max} value={draft[f.key] ?? ""} onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })} />
              </label>
            ))}
            <div className="flex justify-end gap-2 pt-2">
              <DialogClose asChild>
                <Button variant="outline">Cancel</Button>
              </DialogClose>
              <Button type="submit" variant="primary">
                Save limits
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
