"use client";
import { History } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent } from "@/components/ui/dialog";
import { notebooksApi } from "@/lib/lab/api";
import { humanSize } from "@/lib/lab/files";
import type { OpenedNotebook, Revision } from "@/lib/lab/types";
import { formatDate } from "@/lib/utils/format";

export function HistoryDialog({ projectId, path, open, onOpenChange, onRestored }: { projectId: string; path: string; open: boolean; onOpenChange: (v: boolean) => void; onRestored: (nb: OpenedNotebook) => void }) {
  const [revs, setRevs] = useState<Revision[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let live = true;
    notebooksApi
      .revisions(projectId, path)
      .then((r) => live && (setRevs(r.revisions), setError("")))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [open, projectId, path]);

  const restore = async (id: string) => {
    setBusy(id);
    try {
      onRestored(await notebooksApi.restore(projectId, path, id));
      onOpenChange(false);
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(null);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Version history" description="MangoLab keeps a copy at most every few minutes while you work. Restoring keeps your current version too, so you can undo it.">
        {error && <p role="alert" className="mb-2 text-sm text-danger">{error}</p>}
        {revs === null && !error && <p className="py-6 text-center text-sm text-muted">Loading…</p>}
        {revs?.length === 0 && <p className="py-6 text-center text-sm text-muted">No saved versions yet. They appear as you edit.</p>}
        <ul className="max-h-[50vh] divide-y divide-border overflow-y-auto">
          {revs?.map((r, i) => (
            <li key={r.id} className="flex items-center justify-between gap-3 py-2 text-sm">
              <span>
                {formatDate(r.created_at)} <span className="text-xs text-muted">· {humanSize(r.size)}{i === 0 ? " · latest" : ""}</span>
              </span>
              <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => restore(r.id)}>
                <History size={13} /> {busy === r.id ? "Restoring…" : "Restore"}
              </Button>
            </li>
          ))}
        </ul>
        <div className="flex justify-end pt-3">
          <DialogClose asChild>
            <Button variant="outline">Close</Button>
          </DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  );
}
