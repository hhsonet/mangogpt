"use client";
import { BookOpen, ChevronDown, ChevronRight, Download, File as FileIcon, FilePlus, FileText, Folder, FolderOpen, FolderPlus, Image as ImageIcon, Link2, MoreHorizontal, Pencil, RefreshCw, Trash2, Upload, X } from "lucide-react";
import { createContext, useCallback, useContext, useRef, useState } from "react";
import useSWR, { mutate } from "swr";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown";
import { Input } from "@/components/ui/input";
import { filesApi, notebooksApi, uploadFiles } from "@/lib/lab/api";
import { baseOf, dirOf, humanSize, isImageFile } from "@/lib/lab/files";
import type { FileEntry } from "@/lib/lab/types";
import { cn } from "@/lib/utils/cn";

type Dialog =
  | { kind: "newNotebook" | "newFile" | "newFolder"; dir: string }
  | { kind: "rename"; entry: FileEntry }
  | { kind: "delete"; entry: FileEntry }
  | null;

interface Props {
  projectId: string;
  activePath: string | null;
  onOpen: (entry: FileEntry) => void;
  onOpenPath: (path: string, kind: "notebook" | "text") => void;
  /** Called before a path is renamed/deleted so open editors can save first. */
  beforeChange: (path: string) => Promise<void>;
  onRenamed: (from: string, to: string) => void;
  onDeleted: (path: string) => void;
}

interface UploadItem {
  id: number;
  label: string;
  progress: number;
  error?: string;
}

const refresh = (projectId: string) => mutate((k) => Array.isArray(k) && k[0] === "lab-files" && k[1] === projectId);

function EntryIcon({ e, open }: { e: FileEntry; open?: boolean }) {
  if (e.kind === "dir") return open ? <FolderOpen size={15} className="text-accent" /> : <Folder size={15} className="text-accent" />;
  if (e.kind === "link") return <Link2 size={15} className="text-muted" />;
  if (e.is_notebook) return <BookOpen size={15} className="text-amber-500" />;
  if (isImageFile(e.name)) return <ImageIcon size={15} className="text-muted" />;
  return /\.(py|js|ts|json|md|txt|yml|yaml|csv|sh|sql|html|css)$/i.test(e.name) ? <FileText size={15} className="text-muted" /> : <FileIcon size={15} className="text-muted" />;
}

function NameDialog({ title, label, initial, confirm, onClose, onSubmit }: { title: string; label: string; initial: string; confirm: string; onClose: () => void; onSubmit: (v: string) => Promise<void> }) {
  const [v, setV] = useState(initial);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={title}>
        <form
          className="space-y-3"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setErr("");
            try {
              await onSubmit(v.trim());
              onClose();
            } catch (x) {
              setErr((x as Error).message);
              setBusy(false);
            }
          }}
        >
          <label className="block text-sm">
            <span className="mb-1 block font-medium">{label}</span>
            <Input autoFocus value={v} onChange={(e) => setV(e.target.value)} maxLength={200} onFocus={(e) => e.currentTarget.select()} />
          </label>
          {err && <p role="alert" className="text-sm text-danger">{err}</p>}
          <div className="flex justify-end gap-2">
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button type="submit" variant="primary" disabled={!v.trim() || busy}>
              {confirm}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

interface TreeCtx {
  projectId: string;
  expanded: Set<string>;
  toggle: (path: string) => void;
  activePath: string | null;
  dragging: string | null;
  onOpen: (entry: FileEntry) => void;
  setDialog: (d: Dialog) => void;
  pickUploadDir: (dir: string) => void;
}
const TreeContext = createContext<TreeCtx | null>(null);

function Rows({ dir, depth }: { dir: string; depth: number }) {
  const { projectId, expanded, toggle, activePath, dragging, onOpen, setDialog, pickUploadDir } = useContext(TreeContext)!;
  const { data, error, isLoading } = useSWR(["lab-files", projectId, dir], () => filesApi.list(projectId, dir), { revalidateOnFocus: false });
  if (isLoading) return <p className="py-1 text-xs text-muted" style={{ paddingLeft: depth * 12 + 28 }}>Loading…</p>;
  if (error) return <p className="py-1 text-xs text-danger" style={{ paddingLeft: depth * 12 + 28 }}>{(error as Error).message}</p>;
  if (!data?.entries.length) return depth === 0 ? <p className="px-3 py-4 text-sm text-muted">This project is empty. Create a notebook, or drop files here.</p> : <p className="py-1 text-xs text-muted" style={{ paddingLeft: depth * 12 + 28 }}>Empty folder</p>;
  return (
    <ul role={depth === 0 ? "tree" : "group"}>
      {data.entries.map((e) => {
        const open = expanded.has(e.path);
        return (
          <li key={e.path} role="treeitem" aria-expanded={e.kind === "dir" ? open : undefined} aria-selected={activePath === e.path}>
            <div
              data-dropdir={e.kind === "dir" ? e.path : dirOf(e.path)}
              className={cn("group/row flex items-center rounded-md pr-1 text-sm", activePath === e.path ? "bg-surface-2" : "hover:bg-surface-2/60", dragging === (e.kind === "dir" ? e.path : dirOf(e.path)) && "ring-1 ring-accent")}
              style={{ paddingLeft: depth * 12 + 4 }}
            >
              <button
                className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 py-1 text-left disabled:cursor-default"
                disabled={e.kind === "link"}
                title={e.kind === "link" ? "Links are shown but never opened" : e.name}
                onClick={() => (e.kind === "dir" ? toggle(e.path) : onOpen(e))}
              >
                {e.kind === "dir" ? open ? <ChevronDown size={13} className="shrink-0 text-muted" /> : <ChevronRight size={13} className="shrink-0 text-muted" /> : <span className="w-[13px] shrink-0" />}
                <EntryIcon e={e} open={open} />
                <span className="truncate">{e.name}</span>
              </button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button aria-label={`Actions for ${e.name}`} className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded text-muted opacity-0 hover:bg-surface-2 focus-visible:opacity-100 group-hover/row:opacity-100 data-[state=open]:opacity-100 max-md:opacity-100">
                    <MoreHorizontal size={14} />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  {e.kind === "dir" && (
                    <>
                      <DropdownMenuItem onSelect={() => setDialog({ kind: "newNotebook", dir: e.path })}><BookOpen size={14} /> New notebook</DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => setDialog({ kind: "newFile", dir: e.path })}><FilePlus size={14} /> New file</DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => setDialog({ kind: "newFolder", dir: e.path })}><FolderPlus size={14} /> New folder</DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => pickUploadDir(e.path)}><Upload size={14} /> Upload here</DropdownMenuItem>
                      <DropdownMenuSeparator />
                    </>
                  )}
                  {e.kind === "file" && (
                    <DropdownMenuItem asChild>
                      <a href={filesApi.downloadUrl(projectId, e.path)} download><Download size={14} /> Download</a>
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem onSelect={() => setDialog({ kind: "rename", entry: e })}><Pencil size={14} /> Rename or move</DropdownMenuItem>
                  <DropdownMenuItem danger onSelect={() => setDialog({ kind: "delete", entry: e })}><Trash2 size={14} /> Delete</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            {e.kind === "dir" && open && <Rows dir={e.path} depth={depth + 1} />}
            {e.kind !== "dir" && e.size > 0 && null}
          </li>
        );
      })}
    </ul>
  );
}


export function FileTree({ projectId, activePath, onOpen, onOpenPath, beforeChange, onRenamed, onDeleted }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(`lab-expanded-${projectId}`) ?? "[]") as string[]);
    } catch {
      return new Set();
    }
  });
  const [dialog, setDialog] = useState<Dialog>(null);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [dragging, setDragging] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const uploadDir = useRef("");
  const nextId = useRef(1);

  const toggle = useCallback(
    (path: string) =>
      setExpanded((s) => {
        const n = new Set(s);
        n.has(path) ? n.delete(path) : n.add(path);
        try {
          localStorage.setItem(`lab-expanded-${projectId}`, JSON.stringify([...n]));
        } catch {
          /* storage unavailable */
        }
        return n;
      }),
    [projectId],
  );

  const startUpload = useCallback(
    async (dir: string, files: File[]) => {
      if (!files.length) return;
      const id = nextId.current++;
      const label = files.length === 1 ? files[0]!.name : `${files.length} files`;
      setUploads((u) => [...u, { id, label, progress: 0 }]);
      try {
        const r = await uploadFiles(projectId, dir, files, (p) => setUploads((u) => u.map((x) => (x.id === id ? { ...x, progress: p } : x))));
        const bad = r.rejected.map((x) => `${x.name}: ${x.message}`).join(" ");
        setUploads((u) => u.map((x) => (x.id === id ? { ...x, progress: 1, error: bad || undefined } : x)));
        if (!bad) setTimeout(() => setUploads((u) => u.filter((x) => x.id !== id)), 2500);
        if (dir) setExpanded((s) => new Set(s).add(dir));
      } catch (e) {
        setUploads((u) => u.map((x) => (x.id === id ? { ...x, progress: 1, error: (e as Error).message } : x)));
      }
      await refresh(projectId);
    },
    [projectId],
  );

  const dropTarget = (e: React.DragEvent) => ((e.target as HTMLElement).closest("[data-dropdir]") as HTMLElement | null)?.dataset.dropdir ?? "";

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDragging(dropTarget(e));
      }}
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setDragging(null)}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        const dir = dropTarget(e);
        setDragging(null);
        void startUpload(dir, Array.from(e.dataTransfer.files));
      }}
    >
      <div className="flex items-center gap-0.5 border-b border-border px-2 py-1.5">
        <span className="mr-auto px-1 text-xs font-semibold uppercase tracking-wide text-muted">Files</span>
        <Button size="icon" variant="ghost" title="New notebook" aria-label="New notebook" onClick={() => setDialog({ kind: "newNotebook", dir: "" })}><BookOpen size={15} /></Button>
        <Button size="icon" variant="ghost" title="New file" aria-label="New file" onClick={() => setDialog({ kind: "newFile", dir: "" })}><FilePlus size={15} /></Button>
        <Button size="icon" variant="ghost" title="New folder" aria-label="New folder" onClick={() => setDialog({ kind: "newFolder", dir: "" })}><FolderPlus size={15} /></Button>
        <Button size="icon" variant="ghost" title="Upload files" aria-label="Upload files" onClick={() => { uploadDir.current = ""; fileInput.current?.click(); }}><Upload size={15} /></Button>
        <Button size="icon" variant="ghost" title="Refresh" aria-label="Refresh files" onClick={() => void refresh(projectId)}><RefreshCw size={14} /></Button>
        <input ref={fileInput} type="file" multiple hidden onChange={(e) => { void startUpload(uploadDir.current, Array.from(e.target.files ?? [])); e.target.value = ""; }} />
      </div>
      <div className={cn("min-h-0 flex-1 overflow-y-auto p-1", dragging === "" && "ring-1 ring-inset ring-accent")} data-dropdir="">
        <TreeContext.Provider value={{ projectId, expanded, toggle, activePath, dragging, onOpen, setDialog, pickUploadDir: (d) => { uploadDir.current = d; fileInput.current?.click(); } }}>
          <Rows dir="" depth={0} />
        </TreeContext.Provider>
      </div>
      {uploads.length > 0 && (
        <ul className="space-y-1 border-t border-border p-2 text-xs" aria-label="Uploads">
          {uploads.map((u) => (
            <li key={u.id}>
              <div className="flex items-center justify-between gap-2">
                <span className="truncate">{u.label}</span>
                <button aria-label="Dismiss" className="cursor-pointer text-muted hover:text-fg" onClick={() => setUploads((x) => x.filter((i) => i.id !== u.id))}><X size={12} /></button>
              </div>
              {u.error ? <p className="text-danger">{u.error}</p> : <div className="mt-1 h-1 overflow-hidden rounded-full bg-surface-2"><div className="h-full bg-accent transition-all" style={{ width: `${u.progress * 100}%` }} /></div>}
            </li>
          ))}
        </ul>
      )}

      {dialog && (dialog.kind === "newNotebook" || dialog.kind === "newFile" || dialog.kind === "newFolder") && (
        <NameDialog
          title={dialog.kind === "newNotebook" ? "New notebook" : dialog.kind === "newFile" ? "New file" : "New folder"}
          label={dialog.dir ? `Name (in ${dialog.dir}/)` : "Name"}
          initial={dialog.kind === "newNotebook" ? "Untitled.ipynb" : dialog.kind === "newFile" ? "untitled.py" : "new-folder"}
          confirm="Create"
          onClose={() => setDialog(null)}
          onSubmit={async (name) => {
            if (name.includes("/")) throw new Error("A name can't contain “/”. Use the folder's menu to create things inside it.");
            const path = [dialog.dir, dialog.kind === "newNotebook" && !name.endsWith(".ipynb") ? `${name}.ipynb` : name].filter(Boolean).join("/");
            if (dialog.kind === "newNotebook") await notebooksApi.create(projectId, path);
            else if (dialog.kind === "newFile") await filesApi.write(projectId, { path, content: "", create_only: true });
            else await filesApi.mkdir(projectId, path);
            if (dialog.dir) setExpanded((s) => new Set(s).add(dialog.dir));
            await refresh(projectId);
            if (dialog.kind !== "newFolder") onOpenPath(path, dialog.kind === "newNotebook" ? "notebook" : "text");
          }}
        />
      )}
      {dialog?.kind === "rename" && (
        <NameDialog
          title={`Rename ${dialog.entry.name}`}
          label="New name or path (a path moves it)"
          initial={dialog.entry.path}
          confirm="Rename"
          onClose={() => setDialog(null)}
          onSubmit={async (to) => {
            const from = dialog.entry.path;
            await beforeChange(from);
            await filesApi.rename(projectId, from, to);
            onRenamed(from, to);
            await refresh(projectId);
          }}
        />
      )}
      {dialog?.kind === "delete" && (
        <Dialog open onOpenChange={(o) => !o && setDialog(null)}>
          <DialogContent title={`Delete ${baseOf(dialog.entry.path)}?`} description={dialog.entry.kind === "dir" ? "The folder and everything in it will be permanently deleted." : `This ${dialog.entry.size ? `(${humanSize(dialog.entry.size)}) ` : ""}file will be permanently deleted.`}>
            <div className="flex justify-end gap-2 pt-2">
              <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
              <Button variant="danger" onClick={async () => { const p = dialog.entry.path; setDialog(null); await filesApi.remove(projectId, p).catch(() => undefined); onDeleted(p); await refresh(projectId); }}>Delete</Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
