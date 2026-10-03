"use client";
import { ArrowLeft, BookOpen, FileText, FlaskConical, Menu, Package, PanelLeftClose, PanelLeftOpen, Plus, Sparkles, TerminalSquare, X } from "lucide-react";
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
import { AssistantBridgeProvider } from "./AssistantBridge";
import { AssistantPanel, type AskRequest } from "./AssistantPanel";
import { BottomPanel, type PanelTab } from "./BottomPanel";
import { NotebookEditor } from "./NotebookEditor";
import { RuntimeBar, RuntimeNotices } from "./RuntimeBar";
import { RuntimeProvider } from "./RuntimeContext";
import { TextFileEditor } from "./TextFileEditor";

type TabKind = "notebook" | "text" | "image" | "binary";
interface Tab {
  path: string;
  kind: TabKind;
  size?: number;
}
type Flush = () => Promise<void>;

const kindFor = (name: string, size = 0): TabKind => (isNotebookFile(name) ? "notebook" : isImageFile(name) ? "image" : isProbablyText(name, size) ? "text" : "binary");

function NotebookLoader({ projectId, path, registerFlush, onOpenAsText, active, onAskAI }: { projectId: string; path: string; registerFlush: (p: string, f: Flush | null) => void; onOpenAsText: (p: string) => void; active: boolean; onAskAI: (path: string, cellId: string, mode: "explain" | "fix") => void }) {
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
  return <NotebookEditor projectId={projectId} opened={state.opened} registerFlush={registerFlush} active={active} onAskAI={onAskAI} />;
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
  const [assistant, setAssistant] = useState<{ open: boolean; used: boolean }>({ open: false, used: false });
  const [ask, setAsk] = useState<AskRequest | null>(null);
  const askAI = useCallback((path: string, cellId: string, mode: "explain" | "fix") => {
    setAssistant({ open: true, used: true });
    setAsk((a) => ({ path, cellId, mode, nonce: (a?.nonce ?? 0) + 1 }));
  }, []);
  const [panel, setPanel] = useState<{ open: boolean; tab: PanelTab; height: number }>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("lab-panel") ?? "{}") as Partial<{ open: boolean; tab: PanelTab; height: number }>;
      return { open: false, tab: saved.tab === "packages" ? "packages" : "terminal", height: Math.min(Math.max(Number(saved.height) || 300, 160), 700) };
    } catch {
      return { open: false, tab: "terminal", height: 300 };
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("lab-panel", JSON.stringify({ tab: panel.tab, height: panel.height }));
    } catch {
      /* storage unavailable */
    }
  }, [panel.tab, panel.height]);
  const [panelUsed, setPanelUsed] = useState(false); // mount the tools only once they have been opened
  const openPanel = (tab: PanelTab) => {
    setPanelUsed(true);
    setPanel((p) => (p.open && p.tab === tab ? { ...p, open: false } : { ...p, open: true, tab }));
  };
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = panel.height;
    const move = (ev: PointerEvent) => setPanel((p) => ({ ...p, height: Math.min(Math.max(startH + (startY - ev.clientY), 160), Math.floor(window.innerHeight * 0.75)) }));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const [drawer, setDrawer] = useState(false);
  const flushers = useRef(new Map<string, Flush>());
  const registerFlush = useCallback((path: string, f: Flush | null) => void (f ? flushers.current.set(path, f) : flushers.current.delete(path)), []);

  const activeTab = tabs.find((t) => t.path === active) ?? null;
  const activeNotebook = activeTab?.kind === "notebook" ? activeTab.path : null;

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
          <Button size="icon" variant="ghost" aria-label="Terminal" aria-pressed={panel.open && panel.tab === "terminal"} title="Terminal" onClick={() => openPanel("terminal")} className={cn(panel.open && panel.tab === "terminal" && "bg-surface-2")}><TerminalSquare size={16} /></Button>
          <Button size="icon" variant="ghost" aria-label="Packages" aria-pressed={panel.open && panel.tab === "packages"} title="Packages" onClick={() => openPanel("packages")} className={cn(panel.open && panel.tab === "packages" && "bg-surface-2")}><Package size={16} /></Button>
          <RuntimeBar />
          <Button size="icon" variant="ghost" title="MangoLab AI assistant" aria-label="AI assistant" aria-pressed={assistant.open} onClick={() => setAssistant((a) => ({ open: !a.open, used: true }))} className={cn(assistant.open && "bg-surface-2")}><Sparkles size={16} className="text-accent" /></Button>
        </div>
      </header>
      <RuntimeNotices />

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

          <div className="min-h-0 flex-1" style={panel.open ? { flexBasis: 0 } : undefined}>
            {/* Every open notebook and text file stays mounted (hidden when not shown) so runs, undo history and unsaved edits survive a tab switch. */}
            {tabs.map((t) => (
              <div key={t.path} hidden={t.path !== active} role="tabpanel" aria-label={baseOf(t.path)} className="h-full">
                {t.kind === "notebook" && <NotebookLoader projectId={projectId} path={t.path} registerFlush={registerFlush} active={t.path === active} onAskAI={askAI} onOpenAsText={(p) => { setTabs((all) => all.map((x) => (x.path === p ? { ...x, kind: "text" } : x))); }} />}
                {t.kind === "text" && <TextFileEditor projectId={projectId} path={t.path} registerFlush={registerFlush} />}
                {t.kind === "image" && t.path === active && (
                  <div className="flex h-full items-center justify-center overflow-auto bg-surface p-6">
                    {/* eslint-disable-next-line @next/next/no-img-element -- private, authenticated workspace file */}
                    <img src={filesApi.downloadUrl(projectId, t.path, true)} alt={baseOf(t.path)} className="max-h-full max-w-full rounded border border-border bg-white" />
                  </div>
                )}
                {t.kind === "binary" && t.path === active && (
                  <div className="mx-auto max-w-sm p-10 text-center">
                    <p className="mb-1 font-medium">{baseOf(t.path)}</p>
                    <p className="mb-4 text-sm text-muted">This file can’t be shown here.</p>
                    <a href={filesApi.downloadUrl(projectId, t.path)} download className="text-sm text-accent underline">Download</a>
                  </div>
                )}
              </div>
            ))}
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

          {/* The panel is mounted from the first time it opens and then only hidden, so a shell or an install keeps going. */}
          {(panel.open || panel.height > 0) && (
            <div hidden={!panel.open} className="shrink-0" style={{ height: panel.height }}>
              <div role="separator" aria-orientation="horizontal" aria-label="Resize panel" tabIndex={0} onPointerDown={startResize}
                onKeyDown={(e) => { if (e.key === "ArrowUp") setPanel((p) => ({ ...p, height: Math.min(p.height + 24, 700) })); if (e.key === "ArrowDown") setPanel((p) => ({ ...p, height: Math.max(p.height - 24, 160) })); }}
                className="-mb-1 h-1 cursor-row-resize bg-border/0 hover:bg-accent/40 focus-visible:bg-accent/60" />
              <div className="h-full">
                {panelUsed && <BottomPanel projectId={projectId} tab={panel.tab} onTab={(t) => setPanel((p) => ({ ...p, tab: t }))} onClose={() => setPanel((p) => ({ ...p, open: false }))} />}
              </div>
            </div>
          )}
        </main>

        {assistant.used && (
          <aside hidden={!assistant.open} aria-label="Assistant" className="fixed inset-0 z-40 bg-bg md:static md:inset-auto md:z-auto md:w-[26rem] md:shrink-0 md:border-l md:border-border">
            <AssistantPanel projectId={projectId} path={activeNotebook} ask={ask} onClose={() => setAssistant((a) => ({ ...a, open: false }))} onOpenPackages={() => { setPanelUsed(true); setPanel((p) => ({ ...p, open: true, tab: "packages" })); }} />
          </aside>
        )}
      </div>
    </div>
  );
}

export function Workspace({ projectId }: { projectId: string }) {
  const mounted = useMounted(); // tabs come from localStorage, so render only on the client to avoid a hydration mismatch
  return mounted ? (
    <RuntimeProvider projectId={projectId}>
      <AssistantBridgeProvider>
        <Inner projectId={projectId} />
      </AssistantBridgeProvider>
    </RuntimeProvider>
  ) : (
    <div className="h-dvh" />
  );
}
