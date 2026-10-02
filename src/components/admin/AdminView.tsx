"use client";
import { ArrowLeft, Ban, Check, KeyRound, Menu, MoreHorizontal, Plus, RotateCcw, ShieldCheck, ShieldOff, Trash2, UserPlus, X } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import useSWR from "swr";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown";
import { api } from "@/hooks/api";
import { useApp } from "@/hooks/useApp";
import { cn } from "@/lib/utils/cn";
import { formatDate } from "@/lib/utils/format";
import { AdminHeader } from "./AdminNav";
import { AddUserDialog, ConfirmDialog, ResetPasswordDialog } from "./UserDialogs";

interface UserRow {
  id: string;
  username: string;
  email: string | null;
  role: "admin" | "user";
  status: "active" | "pending" | "disabled";
  createdAt: string;
  lastLoginAt: string | null;
  conversationCount: number;
}
type SignupMode = "closed" | "approval" | "open";

const MODES: { value: SignupMode; label: string; help: string }[] = [
  { value: "closed", label: "Closed", help: "Nobody can sign up. Add users yourself." },
  { value: "approval", label: "Approval required", help: "New accounts wait here until you approve them." },
  { value: "open", label: "Open", help: "Anyone who can reach this page can create an account and use your GPU." },
];

const STATUS_STYLE = {
  active: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  pending: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  disabled: "bg-surface-2 text-muted",
} as const;

export function AdminView() {
  const { setMobileOpen } = useApp();
  const me = useSWR<{ role: string | null }>("/api/auth/me", (u: string) => fetch(u).then((r) => r.json()));
  const isAdmin = me.data?.role === "admin";
  const users = useSWR<{ users: UserRow[]; currentUserId: string }>(isAdmin ? "/api/admin/users" : null, (u: string) => api<{ users: UserRow[]; currentUserId: string }>(u));
  const config = useSWR<{ signupMode: SignupMode; imagesEnabled: boolean }>(isAdmin ? "/api/admin/config" : null, (u: string) => api<{ signupMode: SignupMode; imagesEnabled: boolean }>(u));

  const notif = useSWR<{ slack: boolean; telegram: boolean }>(isAdmin ? "/api/admin/notifications" : null, (u: string) => api<{ slack: boolean; telegram: boolean }>(u));
  const [testResult, setTestResult] = useState<string>("");
  const [testing, setTesting] = useState(false);
  const sendTest = async () => {
    setTesting(true);
    setTestResult("");
    try {
      const r = await api<{ slack: string; telegram: string }>("/api/admin/notifications/test", { method: "POST" });
      const parts = [notif.data?.slack && `Slack: ${r.slack}`, notif.data?.telegram && `Telegram: ${r.telegram}`].filter(Boolean);
      setTestResult(parts.length ? parts.join(" · ") : "Nothing is configured yet.");
    } catch (err) {
      setTestResult((err as Error).message);
    }
    setTesting(false);
  };
  const [adding, setAdding] = useState(false);
  const [resetting, setResetting] = useState<UserRow | null>(null);
  const [deleting, setDeleting] = useState<UserRow | null>(null);
  const [error, setError] = useState("");

  const refresh = () => users.mutate();
  const act = async (fn: () => Promise<unknown>) => {
    setError("");
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const patch = (u: UserRow, body: object) => act(() => api(`/api/admin/users/${u.id}`, { method: "PATCH", body: JSON.stringify(body) }));
  const setMode = (m: SignupMode) => act(async () => { await api("/api/admin/config", { method: "PATCH", body: JSON.stringify({ signupMode: m }) }); await config.mutate(); });

  const setImages = (on: boolean) => act(async () => { await api("/api/admin/config", { method: "PATCH", body: JSON.stringify({ imagesEnabled: on }) }); await config.mutate(); });

  const header = <AdminHeader />;

  if (me.data && !isAdmin) {
    return (
      <div className="mx-auto max-w-2xl px-4">
        {header}
        <p className="py-16 text-center text-sm text-muted">This page is for admins only.</p>
      </div>
    );
  }

  const list = users.data?.users ?? [];
  const pending = list.filter((u) => u.status === "pending");
  const mode = config.data?.signupMode;

  return (
    <div className="h-dvh overflow-y-auto">
      <div className="mx-auto max-w-4xl px-4 pb-16">
        {header}
        <div className="mb-6 mt-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">Users</h1>
            <p className="text-sm text-muted">
              {list.length} {list.length === 1 ? "account" : "accounts"}
              {pending.length > 0 && ` · ${pending.length} waiting for approval`}
            </p>
          </div>
          <Button variant="primary" onClick={() => setAdding(true)}>
            <Plus size={16} /> Add user
          </Button>
        </div>

        {error && (
          <p role="alert" className="mb-4 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm">
            {error}
          </p>
        )}

        <section className="mb-6 rounded-lg border border-border p-4">
          <h2 className="text-sm font-semibold">Sign-ups</h2>
          <p className="mb-3 text-sm text-muted">Who can create an account from the public sign-in page.</p>
          <div role="radiogroup" aria-label="Sign-up mode" className="inline-flex flex-wrap rounded-md border border-border p-0.5">
            {MODES.map((m) => (
              <button
                key={m.value}
                role="radio"
                aria-checked={mode === m.value}
                onClick={() => setMode(m.value)}
                className={cn("cursor-pointer rounded px-3 py-1 text-sm", mode === m.value ? "bg-surface-2 font-medium" : "text-muted hover:text-fg")}
              >
                {m.label}
              </button>
            ))}
          </div>
          {mode && <p className={cn("mt-2 text-xs", mode === "open" ? "text-amber-600 dark:text-amber-400" : "text-muted")}>{MODES.find((m) => m.value === mode)?.help}</p>}
        </section>

        <section className="mb-6 rounded-lg border border-border p-4">
          <h2 className="text-sm font-semibold">Notifications</h2>
          <p className="mb-3 text-sm text-muted">Get a Slack or Telegram message when someone requests an account.</p>
          <div className="flex flex-wrap items-center gap-3 text-sm">
            {([["Slack", notif.data?.slack], ["Telegram", notif.data?.telegram]] as const).map(([name, on]) => (
              <span key={name} className={cn("inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs", on ? "border-emerald-500/40 text-emerald-600 dark:text-emerald-400" : "border-border text-muted")}>
                <span className={cn("h-2 w-2 rounded-full", on ? "bg-emerald-500" : "bg-muted")} />
                {name}: {on ? "connected" : "not set up"}
              </span>
            ))}
            <Button variant="outline" size="sm" onClick={sendTest} disabled={testing || (!notif.data?.slack && !notif.data?.telegram)}>
              {testing ? "Sending…" : "Send test"}
            </Button>
            {testResult && <span role="status" className="text-xs text-muted">{testResult}</span>}
          </div>
          {notif.data && !notif.data.slack && !notif.data.telegram && (
            <p className="mt-3 text-xs text-muted">Add <code>SLACK_WEBHOOK_URL</code> or <code>TELEGRAM_BOT_TOKEN</code> and <code>TELEGRAM_CHAT_ID</code> to the server’s <code>.env</code> and restart. See the README.</p>
          )}
        </section>

        <section className="mb-6 rounded-lg border border-border p-4">
          <h2 className="text-sm font-semibold">Image generation</h2>
          <p className="mb-3 text-sm text-muted">Lets people create images in chat. Each image briefly takes over the GPU from the chat model.</p>
          <div role="radiogroup" aria-label="Image generation" className="inline-flex rounded-md border border-border p-0.5">
            {([[true, "On"], [false, "Off"]] as const).map(([v, label]) => (
              <button
                key={label}
                role="radio"
                aria-checked={config.data?.imagesEnabled === v}
                onClick={() => setImages(v)}
                className={cn("cursor-pointer rounded px-3 py-1 text-sm", config.data?.imagesEnabled === v ? "bg-surface-2 font-medium" : "text-muted hover:text-fg")}
              >
                {label}
              </button>
            ))}
          </div>
        </section>

        {pending.length > 0 && (
          <section className="mb-6 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4" aria-label="Pending approvals">
            <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
              <UserPlus size={15} /> Waiting for approval
            </h2>
            <ul className="divide-y divide-border">
              {pending.map((u) => (
                <li key={u.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <div>
                    <p className="font-medium">{u.username}</p>
                    {u.email && <p className="text-xs text-muted">{u.email}</p>}
                    <p className="text-xs text-muted">Requested {formatDate(u.createdAt)}</p>
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" variant="primary" onClick={() => patch(u, { status: "active" })}>
                      <Check size={14} /> Approve
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setDeleting(u)}>
                      <X size={14} /> Reject
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

        <div className="overflow-hidden rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-surface text-left text-xs text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">User</th>
                <th className="px-3 py-2 font-medium max-sm:hidden">Role</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium max-md:hidden">Last sign-in</th>
                <th className="px-3 py-2 font-medium max-md:hidden">Chats</th>
                <th className="w-10 px-2 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {list.map((u) => {
                const self = u.id === users.data?.currentUserId;
                return (
                  <tr key={u.id}>
                    <td className="px-3 py-2.5">
                      <span className="font-medium">{u.username}</span>
                      {self && <span className="ml-2 text-xs text-muted">you</span>}
                      {u.email && <span className="block break-all text-xs text-muted">{u.email}</span>}
                      <span className="block text-xs capitalize text-muted sm:hidden">{u.role}</span>
                    </td>
                    <td className="px-3 py-2.5 capitalize max-sm:hidden">{u.role}</td>
                    <td className="px-3 py-2.5">
                      <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium capitalize", STATUS_STYLE[u.status])}>{u.status}</span>
                    </td>
                    <td className="px-3 py-2.5 text-muted max-md:hidden">{u.lastLoginAt ? formatDate(u.lastLoginAt) : "Never"}</td>
                    <td className="px-3 py-2.5 text-muted max-md:hidden">{u.conversationCount}</td>
                    <td className="px-2 py-2.5">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" aria-label={`Actions for ${u.username}`}>
                            <MoreHorizontal size={16} />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {u.status === "pending" && (
                            <DropdownMenuItem onSelect={() => patch(u, { status: "active" })}>
                              <Check size={14} /> Approve
                            </DropdownMenuItem>
                          )}
                          {!self && u.status === "active" && (
                            <DropdownMenuItem onSelect={() => patch(u, { status: "disabled" })}>
                              <Ban size={14} /> Disable
                            </DropdownMenuItem>
                          )}
                          {u.status === "disabled" && (
                            <DropdownMenuItem onSelect={() => patch(u, { status: "active" })}>
                              <RotateCcw size={14} /> Enable
                            </DropdownMenuItem>
                          )}
                          {!self && (
                            <DropdownMenuItem onSelect={() => patch(u, { role: u.role === "admin" ? "user" : "admin" })}>
                              {u.role === "admin" ? <ShieldOff size={14} /> : <ShieldCheck size={14} />}
                              {u.role === "admin" ? "Make regular user" : "Make admin"}
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuItem onSelect={() => setResetting(u)}>
                            <KeyRound size={14} /> Reset password
                          </DropdownMenuItem>
                          {!self && (
                            <>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem danger onSelect={() => setDeleting(u)}>
                                <Trash2 size={14} /> Delete user
                              </DropdownMenuItem>
                            </>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </td>
                  </tr>
                );
              })}
              {list.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-10 text-center text-muted">
                    {users.isLoading ? "Loading…" : "No users yet. Add the first one."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <AddUserDialog open={adding} onOpenChange={setAdding} onDone={refresh} />
      <ResetPasswordDialog user={resetting} onClose={() => setResetting(null)} onDone={refresh} />
      <ConfirmDialog
        open={Boolean(deleting)}
        title={deleting?.status === "pending" ? `Reject ${deleting?.username}?` : `Delete ${deleting?.username}?`}
        description={
          deleting?.conversationCount
            ? `This permanently deletes the account and its ${deleting.conversationCount} conversation${deleting.conversationCount === 1 ? "" : "s"}. This can’t be undone.`
            : "This permanently deletes the account. This can’t be undone."
        }
        confirmLabel={deleting?.status === "pending" ? "Reject request" : "Delete user"}
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          const u = deleting;
          setDeleting(null);
          if (u) void act(() => api(`/api/admin/users/${u.id}`, { method: "DELETE" }));
        }}
      />
    </div>
  );
}
