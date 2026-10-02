"use client";
import { ArrowLeft, BookOpen, FileText, FlaskConical, Menu, PanelLeftClose, PanelLeftOpen, Plus, Sparkles, X } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { Button } from "@/components/ui/button";
import { useMounted } from "@/hooks/useLocalFlag";
import { filesApi, notebooksApi, projectsApi } from "@/lib/lab/api";
import { baseOf, humanSize, isImageFile, isNotebookFile, isProbablyText } from "@/lib/lab/files";
import type { FileEntry, OpenedNotebook } from "@/lib/lab/types";
import { cn } from "@/lib/utils/cn";
import { FileTree } from "./FileTree";
import { NotebookEditor } from "./NotebookEditor";
import { TextFileEditor } from "./TextFileEditor";

type TabKind = "notebook" | "text" | "image" | "binary";
interface Tab {
  path: string;
  kind: TabKind;
  size?: number;
}
type Flush = () => Promise<void>;

const kindFor = (name: string, size = 0): TabKind => (isNotebookFile(name) ? "notebook" : isImageFile(name) ? "image" : isProbablyText(name, size) ? "text" : "binary");

function NotebookLoader({ projectId, path, registerFlush, onOpenAsText }: { projectId: string; path: string; registerFlush: (p: string, f: Flush | null) => void; onOpenAsText: (p: string) => void }) {
  const [state, setState] = useState<{ opened?: OpenedNotebook; error?: string }>({});
  useEffect(() => {
    let live = true;
    notebooksApi
      .open(projectId, path)
      .then((opened) => live && setState({ opened }))
      .catch((e: Error) => live && setState({ error: e.message }));
    return () => {
      live = false;
    };
  }, [projectId, path]);
  if (state.error)
    return (
      <div className="mx-auto max-w-md p-10 text-center">
        <p role="alert" className="mb-3 text-sm text-danger">{state.error}</p>
        <Button variant="outline" onClick={() => onOpenAsText(path)}>Open as text instead</Button>
      </div>
    );
  if (!state.opened) return <p className="p-6 text-sm text-muted">Opening notebook…</p>;
  return <NotebookEditor projectId={projectId} opened={state.opened} registerFlush={registerFlush} />;
}

function Inner({ projectId }: { projectId: string }) {
  const { data: project, error } = useSWR(["lab-project", projectId], () => projectsApi.get(projectId), { revalidateOnFocus: false, shouldRetryOnError: false });
  const [tabs, setTabs] = useState<Tab[]>(() => {
    try {
      const fromUrl = new URLSearchParams(location.search).get("open");
      const saved = JSON.parse(localStorage.getItem(`lab-tabs-${projectId}`) ?? "[]") as Tab[];
      const list = saved.filter((t) => t && typeof t.path === "string");
      return fromUrl && !list.some((t) => t.path === fromUrl) ? [...list, { path: fromUrl, kind: kindFor(baseOf(fromUrl)) }] : list;
    } catch {
      return [];
    }
  });
  const [active, setActive] = useState<string | null>(() => {
    const fromUrl = new URLSearchParams(location.search).get("open");
    if (fromUrl) return fromUrl;
    try {
      return (localStorage.getItem(`lab-active-${projectId}`) as string | null) ?? null;
    } catch {
      return null;
    }
  });
  const [sidebar, setSidebar] = useState(true);
  const [drawer, setDrawer] = useState(false);
  const flushers = useRef(new Map<string, Flush>());
  const registerFlush = useCallback((path: string, f: Flush | null) => void (f ? flushers.current.set(path, f) : flushers.current.delete(path)), []);

  const activeTab = tabs.find((t) => t.path === active) ?? null;

  useEffect(() => {
    try {
      localStorage.setItem(`lab-tabs-${projectId}`, JSON.stringify(tabs));
      localStorage.setItem(`lab-active-${projectId}`, active ?? "");
    } catch {
      /* storage unavailable */
    }
    const url = new URL(location.href);
    active ? url.searchParams.set("open", active) : url.searchParams.delete("open");
    history.replaceState(null, "", url);
  }, [tabs, active, projectId]);

  const openPath = useCallback((path: string, kind?: TabKind, size?: number) => {
    setTabs((t) => (t.some((x) => x.path === path) ? t : [...t, { path, kind: kind ?? kindFor(baseOf(path), size), size }]));
    setActive(path);
    setDrawer(false);
  }, []);
  const openEntry = useCallback((e: FileEntry) => openPath(e.path, kindFor(e.name, e.size), e.size), [openPath]);

  const flushUnder = useCallback(async (path: string) => {
    await Promise.all([...flushers.current].filter(([p]) => p === path || p.startsWith(`${path}/`)).map(([, f]) => f()));
  }, []);

  const close = useCallback(
    async (path: string) => {
      await flushers.current.get(path)?.(); // finish saving before the editor goes away
      setTabs((t) => {
        const i = t.findIndex((x) => x.path === path);
        const next = t.filter((x) => x.path !== path);
        setActive((cur) => (cur !== path ? cur : (next[Math.min(i, next.length - 1)]?.path ?? null)));
        return next;
      });
    },
    [],
  );

  const renamed = useCallback((from: string, to: string) => {
    const swap = (p: string) => (p === from ? to : p.startsWith(`${from}/`) ? to + p.slice(from.length) : p);
    setTabs((t) => t.map((x) => ({ ...x, path: swap(x.path), kind: kindFor(baseOf(swap(x.path)), x.size) })));
    setActive((a) => (a ? swap(a) : a));
  }, []);
  const deleted = useCallback((path: string) => {
    setTabs((t) => t.filter((x) => x.path !== path && !x.path.startsWith(`${path}/`)));
    setActive((a) => (a && (a === path || a.startsWith(`${path}/`)) ? null : a));
  }, []);

  if (error)
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-3 text-center">
        <p className="font-medium">Project not found</p>
        <p className="text-sm text-muted">It may have been deleted, or it belongs to someone else.</p>
        <Link href="/lab" className="text-accent underline">Back to projects</Link>
      </div>
    );

  const tree = <FileTree projectId={projectId} activePath={active} onOpen={openEntry} onOpenPath={(p, k) => openPath(p, k)} beforeChange={flushUnder} onRenamed={renamed} onDeleted={deleted} />;

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-2">
        <Button variant="ghost" size="icon" className="md:hidden" aria-label="Show files" onClick={() => setDrawer(true)}><Menu size={18} /></Button>
        <Button variant="ghost" size="icon" className="max-md:hidden" aria-label={sidebar ? "Hide files" : "Show files"} onClick={() => setSidebar((s) => !s)}>
          {sidebar ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}
        </Button>
        <Link href="/lab" className="flex items-center gap-1.5 text-sm text-muted hover:text-fg" title="All projects">
          <ArrowLeft size={14} /> <FlaskConical size={15} className="text-accent" /> <span className="max-sm:hidden">MangoLab</span>
        </Link>
        <span className="text-muted">/</span>
        <h1 className="min-w-0 truncate text-sm font-medium">{project?.name ?? "…"}</h1>
        {project?.used_bytes !== undefined && project.limits && (
          <span className="ml-1 hidden text-xs text-muted lg:inline" title="Workspace disk used">{humanSize(project.used_bytes)} of {Math.round(project.limits.disk_quota_mb / 1024)} GiB</span>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          <span title="Running code arrives in the next build step" className="flex items-center gap-2 rounded-full border border-border px-2.5 py-1 text-xs text-muted">
            <span className="h-2 w-2 rounded-full bg-muted" /> <span className="max-sm:sr-only">Runtime: not connected</span>
          </span>
          <Button size="sm" variant="outline" disabled title="Connecting a runtime arrives in the next build step" className="max-sm:hidden">Connect</Button>
          <Button size="icon" variant="ghost" disabled title="MangoLab AI assistant arrives in a later step" aria-label="AI assistant (not available yet)"><Sparkles size={16} /></Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {sidebar && <aside className="hidden w-72 shrink-0 border-r border-border bg-surface md:block" aria-label="Project files">{tree}</aside>}
        {drawer && (
          <>
            <div className="fixed inset-0 z-30 bg-black/50 md:hidden" onClick={() => setDrawer(false)} aria-hidden />
            <aside className="fixed inset-y-0 left-0 z-40 flex w-80 max-w-[85vw] flex-col border-r border-border bg-surface md:hidden" aria-label="Project files">
              <div className="flex h-12 items-center justify-between border-b border-border px-3">
                <span className="text-sm font-medium">{project?.name}</span>
                <Button size="icon" variant="ghost" aria-label="Close files" onClick={() => setDrawer(false)}><X size={16} /></Button>
              </div>
              <div className="min-h-0 flex-1">{tree}</div>
            </aside>
          </>
        )}

        <main className="flex min-w-0 flex-1 flex-col">
          {tabs.length > 0 && (
            <div role="tablist" aria-label="Open files" className="flex shrink-0 overflow-x-auto border-b border-border bg-surface/50">
              {tabs.map((t) => (
                <div key={t.path} className={cn("group/tab flex shrink-0 items-center gap-1.5 border-r border-border pl-3 pr-1 text-sm", t.path === active ? "bg-bg font-medium" : "text-muted hover:text-fg")}>
                  <button role="tab" aria-selected={t.path === active} onClick={() => setActive(t.path)} className="flex cursor-pointer items-center gap-1.5 py-1.5" title={t.path}>
                    {t.kind === "notebook" ? <BookOpen size={14} className="text-amber-500" /> : <FileText size={14} />}
                    <span className="max-w-40 truncate">{baseOf(t.path)}</span>
                  </button>
                  <button aria-label={`Close ${baseOf(t.path)}`} onClick={() => void close(t.path)} className="flex h-6 w-6 cursor-pointer items-center justify-center rounded hover:bg-surface-2"><X size={13} /></button>
                </div>
              ))}
            </div>
          )}

          <div className="min-h-0 flex-1" role="tabpanel">
            {activeTab?.kind === "notebook" && <NotebookLoader key={activeTab.path} projectId={projectId} path={activeTab.path} registerFlush={registerFlush} onOpenAsText={(p) => { setTabs((t) => t.map((x) => (x.path === p ? { ...x, kind: "text" } : x))); }} />}
            {activeTab?.kind === "text" && <TextFileEditor key={activeTab.path} projectId={projectId} path={activeTab.path} registerFlush={registerFlush} />}
            {activeTab?.kind === "image" && (
              <div className="flex h-full items-center justify-center overflow-auto bg-surface p-6">
                {/* eslint-disable-next-line @next/next/no-img-element -- private, authenticated workspace file */}
                <img src={filesApi.downloadUrl(projectId, activeTab.path, true)} alt={baseOf(activeTab.path)} className="max-h-full max-w-full rounded border border-border bg-white" />
              </div>
            )}
            {activeTab?.kind === "binary" && (
              <div className="mx-auto max-w-sm p-10 text-center">
                <p className="mb-1 font-medium">{baseOf(activeTab.path)}</p>
                <p className="mb-4 text-sm text-muted">This file can’t be shown here.</p>
                <a href={filesApi.downloadUrl(projectId, activeTab.path)} download className="text-sm text-accent underline">Download</a>
              </div>
            )}
            {!activeTab && (
              <div className="mx-auto flex h-full max-w-md flex-col items-center justify-center gap-3 p-8 text-center">
                <FlaskConical size={28} className="text-muted" />
                <p className="font-medium">Open a file, or start a notebook</p>
                <p className="text-sm text-muted">Pick something from the file list, drop files onto it to upload them, or create a new notebook.</p>
                <div className="flex gap-2">
                  <Button variant="primary" onClick={() => {
                    const name = `Untitled${Math.floor(Math.random() * 900 + 100)}.ipynb`;
                    notebooksApi.create(projectId, name).then(() => { openPath(name, "notebook"); void import("swr").then(({ mutate }) => mutate((k) => Array.isArray(k) && k[0] === "lab-files")); });
                  }}><Plus size={15} /> New notebook</Button>
                </div>
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

export function Workspace({ projectId }: { projectId: string }) {
  const mounted = useMounted(); // tabs come from localStorage, so render only on the client to avoid a hydration mismatch
  return mounted ? <Inner projectId={projectId} /> : <div className="h-dvh" />;
}
