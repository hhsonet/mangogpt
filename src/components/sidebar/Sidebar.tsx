"use client";
import { FlaskConical, LogOut, PanelLeftClose, ShieldCheck, UserRound, Plus, Search, Settings, X } from "lucide-react";
import useSWR from "swr";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Button } from "@/components/ui/button";
import { useConversations, useModels, useSettings } from "@/hooks/api";
import { useLabMe } from "@/hooks/lab";
import { useApp } from "@/hooks/useApp";
import { APP_NAME } from "@/lib/brand";
import { cn } from "@/lib/utils/cn";
import { relativeGroup } from "@/lib/utils/format";
import type { ConversationSummary } from "@/types";
import { ConversationItem } from "./ConversationItem";
import { StatusBadge } from "./StatusBadge";

const GROUPS = ["Today", "Yesterday", "Previous 7 days", "Older"] as const;

function Section({ title, items, activeId }: { title: string; items: ConversationSummary[]; activeId?: string }) {
  if (items.length === 0) return null;
  return (
    <section className="mb-3">
      <h2 className="px-2.5 pb-1 text-[0.7rem] font-semibold uppercase tracking-wider text-muted">{title}</h2>
      {items.map((c) => (
        <ConversationItem key={c.id} conv={c} active={c.id === activeId} />
      ))}
    </section>
  );
}

export function Sidebar() {
  const { mobileOpen, setMobileOpen, collapsed, toggleCollapsed, setSearchOpen, newChat } = useApp();
  const pathname = usePathname();
  const activeId = pathname.startsWith("/c/") ? pathname.split("/")[2] : undefined;
  const { conversations, error } = useConversations();
  const { settings } = useSettings();
  const { models } = useModels();
  const { me: labMe } = useLabMe();
  const { data: auth } = useSWR<{ enabled: boolean; username: string | null; role: string | null }>("/api/auth/me", (u: string) => fetch(u).then((r) => r.json()), { revalidateOnFocus: false });
  const { data: pending } = useSWR<{ users: { status: string }[] }>(auth?.role === "admin" ? "/api/admin/users" : null, (u: string) => fetch(u).then((r) => r.json()), { refreshInterval: 30000 });
  const pendingCount = pending?.users?.filter((u) => u.status === "pending").length ?? 0;
  const logout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- full reload resets cached client data
    window.location.assign("/login");
  };

  const pinned = conversations.filter((c) => c.pinned);
  const rest = conversations.filter((c) => !c.pinned);
  const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);
  const mod = isMac ? "⌘" : "Ctrl";

  return (
    <>
      {mobileOpen && <div className="fixed inset-0 z-30 bg-black/50 md:hidden" onClick={() => setMobileOpen(false)} aria-hidden />}
      <aside
        aria-label="Sidebar"
        className={cn(
          "z-40 flex h-dvh w-72 shrink-0 flex-col border-r border-border bg-surface transition-transform",
          "max-md:fixed max-md:left-0 max-md:top-0",
          mobileOpen ? "max-md:translate-x-0" : "max-md:-translate-x-full",
          collapsed && "md:hidden",
        )}
      >
        <div className="flex h-12 items-center justify-between px-3">
          <Link href="/" className="text-sm font-semibold tracking-tight" onClick={() => setMobileOpen(false)}>
            {APP_NAME}
          </Link>
          <Button variant="ghost" size="icon" className="max-md:hidden" onClick={toggleCollapsed} aria-label="Collapse sidebar">
            <PanelLeftClose size={18} />
          </Button>
          <Button variant="ghost" size="icon" className="md:hidden" onClick={() => setMobileOpen(false)} aria-label="Close sidebar">
            <X size={18} />
          </Button>
        </div>

        <div className="space-y-1 px-2 pb-2">
          <Button variant="outline" className="w-full justify-start" onClick={newChat} title={`New chat (${mod}+Shift+O)`}>
            <Plus size={16} /> New chat
          </Button>
          <Button variant="ghost" className="w-full justify-start text-muted" onClick={() => setSearchOpen(true)}>
            <Search size={16} /> Search
            <kbd className="ml-auto rounded border border-border px-1.5 text-[0.65rem]">{mod} K</kbd>
          </Button>
        </div>

        <nav className="flex-1 overflow-y-auto px-2 py-1" aria-label="Conversations">
          {error && <p className="px-2.5 text-xs text-danger">Couldn’t load conversations.</p>}
          {conversations.length === 0 && !error && <p className="px-2.5 py-4 text-sm text-muted">No conversations yet.</p>}
          <Section title="Pinned" items={pinned} activeId={activeId} />
          {GROUPS.map((g) => (
            <Section key={g} title={g} items={rest.filter((c) => relativeGroup(c.updatedAt) === g)} activeId={activeId} />
          ))}
        </nav>

        <div className="space-y-2 border-t border-border p-3">
          <StatusBadge />
          {auth?.enabled && auth.username && (
            <div className="flex items-center justify-between rounded-md border border-border px-2.5 py-1.5 text-sm">
              <span className="flex min-w-0 items-center gap-2">
                <UserRound size={15} className="shrink-0 text-muted" />
                <span className="truncate">{auth.username}</span>
              </span>
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={logout} aria-label="Log out" title="Log out">
                <LogOut size={14} />
              </Button>
            </div>
          )}
          {labMe?.lab.enabled && (
            <Link href="/lab" onClick={() => setMobileOpen(false)} className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm hover:bg-surface-2">
              <FlaskConical size={15} className="text-muted" /> MangoLab
              <span className="ml-auto rounded border border-border px-1 text-[0.6rem] uppercase tracking-wide text-muted">beta</span>
            </Link>
          )}
          {auth?.role === "admin" && auth.enabled && (
            <Link href="/admin" onClick={() => setMobileOpen(false)} className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm hover:bg-surface-2">
              <ShieldCheck size={15} className="text-muted" /> Admin
              {pendingCount > 0 && <span className="ml-auto rounded-full bg-accent px-1.5 text-[0.7rem] font-semibold text-accent-fg">{pendingCount}</span>}
            </Link>
          )}
          <div className="flex items-center justify-between text-xs text-muted">
            <span className="truncate" title="Default model">
              Model: {settings?.defaultModel || models[0]?.name || "none"}
            </span>
            <Link href="/settings" onClick={() => setMobileOpen(false)} className="flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-fg hover:bg-surface-2">
              <Settings size={15} /> Settings
            </Link>
          </div>
        </div>
      </aside>
    </>
  );
}
