"use client";
import { Download, RefreshCw, Search, X } from "lucide-react";
import { useEffect, useState } from "react";
import useSWR from "swr";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/hooks/api";
import { cn } from "@/lib/utils/cn";
import { formatDate } from "@/lib/utils/format";
import { AdminHeader } from "./AdminNav";
import { Bars, TimeSeries } from "./charts";

type Range = "24h" | "7d" | "30d";

interface Summary {
  range: Range;
  totals: { chats: number; images: number; uploads: number; errors: number; tokensIn: number; tokensOut: number; activeUsers: number };
  users: { userId: string; username: string; role: string; status: string; chats: number; images: number; uploads: number; errors: number; tokensIn: number; tokensOut: number; genSeconds: number; lastActive: string | null }[];
  series: { t: string; chats: number; images: number; tokens: number; errors: number }[];
  models: { model: string; requests: number; tokensOut: number }[];
}

interface LogEvent {
  id: string;
  createdAt: string;
  type: string;
  status: string;
  username: string | null;
  model: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  durationMs: number | null;
  bytes: number | null;
  ip: string | null;
  detail: string | null;
}
interface LogPage {
  events: LogEvent[];
  nextCursor: string | null;
}

const TYPES = ["chat", "image", "upload", "login", "login_failed", "signup", "admin"];
const nf = new Intl.NumberFormat();
const compact = (n: number) => (n >= 10_000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : nf.format(n));
const dur = (s: number) => (s < 90 ? `${Math.round(s)}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`);
const ago = (iso: string | null) => {
  if (!iso) return "never";
  const s = (Date.now() - Date.parse(iso)) / 1000;
  return s < 60 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
};

const TYPE_STYLE: Record<string, string> = {
  chat: "bg-accent/15 text-accent",
  image: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  upload: "bg-indigo-500/15 text-indigo-600 dark:text-indigo-300",
  login: "bg-surface-2 text-muted",
  login_failed: "bg-danger/15 text-danger",
  signup: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  admin: "bg-violet-500/15 text-violet-600 dark:text-violet-300",
};

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-border p-3">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-0.5 text-2xl font-semibold tabular-nums">{value}</p>
      {sub && <p className="text-xs text-muted">{sub}</p>}
    </div>
  );
}

function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-md border border-border p-0.5">
      {options.map((o) => (
        <button key={o.value} role="radio" aria-checked={value === o.value} onClick={() => onChange(o.value)} className={cn("cursor-pointer rounded px-3 py-1 text-sm", value === o.value ? "bg-surface-2 font-medium" : "text-muted hover:text-fg")}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function UsageView() {
  const me = useSWR<{ role: string | null }>("/api/auth/me", (u: string) => fetch(u).then((r) => r.json()));
  const isAdmin = me.data?.role === "admin";
  const [range, setRange] = useState<Range>("24h");
  const [type, setType] = useState("");
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [qDebounced, setQDebounced] = useState("");
  const [user, setUser] = useState<{ id: string; name: string } | null>(null);
  // Older pages loaded via "Load older events"; tied to the filters they were loaded with.
  const [extra, setExtra] = useState<{ key: string; events: LogEvent[]; cursor: string | null | undefined }>({ key: "", events: [], cursor: undefined });
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setQDebounced(q), 300);
    return () => clearTimeout(t);
  }, [q]);

  const summary = useSWR<Summary>(isAdmin ? `/api/admin/usage?range=${range}` : null, (u: string) => api<Summary>(u), { refreshInterval: 20000, keepPreviousData: true });
  const params = new URLSearchParams({ range, ...(type && { type }), ...(status && { status }), ...(qDebounced && { q: qDebounced }), ...(user && { user: user.id }) });
  const logs = useSWR<LogPage>(isAdmin ? `/api/admin/logs?${params}` : null, (u: string) => api<LogPage>(u), { refreshInterval: 10000, keepPreviousData: true });

  const filterKey = params.toString();
  const loaded = extra.key === filterKey ? extra : { key: filterKey, events: [] as LogEvent[], cursor: undefined };
  const cursor = loaded.cursor;
  const more = loaded.events;

  const loadMore = async () => {
    const next = cursor === undefined ? logs.data?.nextCursor : cursor;
    if (!next) return;
    setLoadingMore(true);
    try {
      const page = await api<LogPage>(`/api/admin/logs?${params}&cursor=${next}`);
      setExtra({ key: filterKey, events: [...more, ...page.events], cursor: page.nextCursor });
    } finally {
      setLoadingMore(false);
    }
  };

  if (me.data && !isAdmin) {
    return (
      <div className="mx-auto max-w-5xl px-4">
        <AdminHeader />
        <p className="py-16 text-center text-sm text-muted">This page is for admins only.</p>
      </div>
    );
  }

  const s = summary.data;
  const events = [...(logs.data?.events ?? []), ...more];
  const hasMore = (cursor === undefined ? logs.data?.nextCursor : cursor) != null;
  const times = s?.series.map((p) => Date.parse(p.t.length === 13 ? `${p.t}:00:00Z` : `${p.t}T00:00:00Z`)) ?? [];
  const maxTokens = Math.max(1, ...(s?.users.map((u) => u.tokensIn + u.tokensOut) ?? [1]));

  return (
    <div className="h-dvh overflow-y-auto">
      <div className="mx-auto max-w-6xl px-4 pb-16">
        <AdminHeader />
        <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">Usage & logs</h1>
            <p className="text-sm text-muted">Who used what, and what happened. Message text and prompts are never recorded here.</p>
          </div>
          <Segmented label="Time range" value={range} onChange={setRange} options={[{ value: "24h", label: "24 hours" }, { value: "7d", label: "7 days" }, { value: "30d", label: "30 days" }]} />
        </div>

        <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Kpi label="Active users" value={s ? String(s.totals.activeUsers) : "–"} />
          <Kpi label="Chat requests" value={s ? compact(s.totals.chats) : "–"} />
          <Kpi label="Images" value={s ? compact(s.totals.images) : "–"} />
          <Kpi label="Tokens generated" value={s ? compact(s.totals.tokensOut) : "–"} sub={s ? `${compact(s.totals.tokensIn)} read` : undefined} />
          <Kpi label="Uploads" value={s ? compact(s.totals.uploads) : "–"} />
          <Kpi label="Errors" value={s ? compact(s.totals.errors) : "–"} sub={s && s.totals.errors ? "see logs below" : undefined} />
        </div>

        <div className="mb-5 grid gap-4 lg:grid-cols-2">
          <section className="rounded-lg border border-border p-4">
            <h2 className="mb-2 text-sm font-semibold">Requests {range === "24h" ? "per hour" : "per day"}</h2>
            {s && <Bars title="Requests over time" labels={s.series.map((p) => p.t)} a={s.series.map((p) => p.chats)} b={s.series.map((p) => p.images)} aLabel="Chats" bLabel="Images" />}
          </section>
          <section className="rounded-lg border border-border p-4">
            <h2 className="mb-2 text-sm font-semibold">Tokens processed {range === "24h" ? "per hour" : "per day"}</h2>
            {s && <TimeSeries title="Tokens over time" series={[{ name: "Tokens", color: "var(--chart-3)", values: s.series.map((p) => p.tokens) }]} times={times} format={(v) => compact(Math.round(v))} />}
          </section>
        </div>

        <section className="mb-5 rounded-lg border border-border">
          <h2 className="border-b border-border px-4 py-3 text-sm font-semibold">Usage by user</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted">
                <tr>
                  <th className="px-4 py-2 font-medium">User</th>
                  <th className="px-3 py-2 font-medium text-right">Chats</th>
                  <th className="px-3 py-2 font-medium text-right">Images</th>
                  <th className="px-3 py-2 font-medium text-right">Uploads</th>
                  <th className="px-3 py-2 font-medium">Tokens (read / generated)</th>
                  <th className="px-3 py-2 font-medium text-right">GPU time</th>
                  <th className="px-3 py-2 font-medium text-right">Errors</th>
                  <th className="px-4 py-2 font-medium">Last active</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {s?.users.map((u) => (
                  <tr key={u.userId}>
                    <td className="px-4 py-2.5">
                      <button onClick={() => setUser({ id: u.userId, name: u.username })} className="cursor-pointer font-medium hover:underline" title="Filter the log to this user">
                        {u.username}
                      </button>
                      <span className="ml-2 text-xs capitalize text-muted">{u.role}{u.status !== "active" ? ` · ${u.status}` : ""}</span>
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{nf.format(u.chats)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{nf.format(u.images)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{nf.format(u.uploads)}</td>
                    <td className="min-w-40 px-3 py-2.5">
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-surface-2">
                          <div className="h-full rounded-full bg-accent" style={{ width: `${((u.tokensIn + u.tokensOut) / maxTokens) * 100}%` }} />
                        </div>
                        <span className="text-xs tabular-nums text-muted">{compact(u.tokensIn)} / {compact(u.tokensOut)}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-muted">{dur(u.genSeconds)}</td>
                    <td className={cn("px-3 py-2.5 text-right tabular-nums", u.errors ? "text-danger" : "text-muted")}>{u.errors}</td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-muted">{ago(u.lastActive)}</td>
                  </tr>
                ))}
                {s && s.users.length === 0 && <tr><td colSpan={8} className="px-4 py-8 text-center text-muted">No users yet.</td></tr>}
              </tbody>
            </table>
          </div>
          {s && s.models.length > 0 && (
            <div className="flex flex-wrap gap-x-6 gap-y-1 border-t border-border px-4 py-3 text-xs text-muted">
              <span className="font-medium text-fg">Models:</span>
              {s.models.map((m) => (
                <span key={m.model}>{m.model} · {nf.format(m.requests)} requests · {compact(m.tokensOut)} tokens</span>
              ))}
            </div>
          )}
        </section>

        <section className="rounded-lg border border-border">
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
            <h2 className="mr-auto text-sm font-semibold">Event log</h2>
            <div className="relative">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search user, IP, model, note…" aria-label="Search the log" className="h-8 w-56 pl-8 text-xs" />
            </div>
            <select value={type} onChange={(e) => setType(e.target.value)} aria-label="Event type" className="h-8 rounded-md border border-border bg-bg px-2 text-xs">
              <option value="">All types</option>
              {TYPES.map((t) => <option key={t} value={t}>{t.replace("_", " ")}</option>)}
            </select>
            <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status" className="h-8 rounded-md border border-border bg-bg px-2 text-xs">
              <option value="">Any status</option>
              <option value="ok">ok</option>
              <option value="error">error</option>
              <option value="cancelled">cancelled</option>
            </select>
            {user && (
              <button onClick={() => setUser(null)} className="inline-flex cursor-pointer items-center gap-1 rounded-full bg-accent/15 px-2.5 py-1 text-xs text-accent">
                {user.name} <X size={12} />
              </button>
            )}
            <Button variant="outline" size="sm" onClick={() => { void logs.mutate(); void summary.mutate(); }} aria-label="Refresh">
              <RefreshCw size={13} />
            </Button>
            <a href={`/api/admin/logs?${params}&format=csv`} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs hover:bg-surface-2">
              <Download size={13} /> CSV
            </a>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted">
                <tr>
                  <th className="px-4 py-2 font-medium">Time</th>
                  <th className="px-3 py-2 font-medium">Event</th>
                  <th className="px-3 py-2 font-medium">User</th>
                  <th className="px-3 py-2 font-medium">Model</th>
                  <th className="px-3 py-2 font-medium text-right">Tokens</th>
                  <th className="px-3 py-2 font-medium text-right">Time taken</th>
                  <th className="px-3 py-2 font-medium">IP</th>
                  <th className="px-4 py-2 font-medium">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {events.map((e) => (
                  <tr key={e.id} className={e.status === "error" ? "bg-danger/5" : undefined}>
                    <td className="whitespace-nowrap px-4 py-2 text-xs text-muted" title={e.createdAt}>{formatDate(e.createdAt)}</td>
                    <td className="px-3 py-2">
                      <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", TYPE_STYLE[e.type] ?? "bg-surface-2 text-muted")}>{e.type.replace("_", " ")}</span>
                      {e.status !== "ok" && <span className={cn("ml-1.5 text-xs", e.status === "error" ? "text-danger" : "text-muted")}>{e.status}</span>}
                    </td>
                    <td className="px-3 py-2">{e.username ?? <span className="text-muted">–</span>}</td>
                    <td className="px-3 py-2 text-xs text-muted">{e.model ?? ""}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-right text-xs tabular-nums text-muted">{e.tokensIn !== null || e.tokensOut !== null ? `${e.tokensIn ?? 0} → ${e.tokensOut ?? 0}` : ""}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-right text-xs tabular-nums text-muted">{e.durationMs !== null ? (e.durationMs >= 1000 ? `${(e.durationMs / 1000).toFixed(1)} s` : `${e.durationMs} ms`) : ""}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-xs text-muted">{e.ip ?? ""}</td>
                    <td className="max-w-xs truncate px-4 py-2 text-xs text-muted" title={e.detail ?? undefined}>{e.detail ?? ""}</td>
                  </tr>
                ))}
                {events.length === 0 && <tr><td colSpan={8} className="px-4 py-10 text-center text-muted">{logs.isLoading ? "Loading…" : "No events match these filters."}</td></tr>}
              </tbody>
            </table>
          </div>
          {hasMore && (
            <div className="border-t border-border p-3 text-center">
              <Button variant="outline" size="sm" onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? "Loading…" : "Load older events"}
              </Button>
            </div>
          )}
        </section>
        <p className="mt-3 text-xs text-muted">Events are kept for 90 days. IP addresses are recorded for sign-ins, sign-ups and admin actions only.</p>
      </div>
    </div>
  );
}
