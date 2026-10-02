import "server-only";
import { prisma } from "@/lib/db/prisma";

export type EventType = "chat" | "image" | "upload" | "login" | "login_failed" | "signup" | "admin" | "error";
export type EventStatus = "ok" | "error" | "cancelled";

export interface LogInput {
  type: EventType;
  status?: EventStatus;
  userId?: string | null;
  username?: string | null;
  model?: string | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  durationMs?: number | null;
  bytes?: number | null;
  detail?: string | null;
  ip?: string | null;
}

const RETENTION_DAYS = Number(process.env.LOG_RETENTION_DAYS ?? 90);
let lastPrune = 0;

/** Fire-and-forget: logging must never break the request that triggered it. */
export function logEvent(input: LogInput): void {
  void prisma.usageEvent
    .create({
      data: {
        type: input.type,
        status: input.status ?? "ok",
        userId: input.userId ?? null,
        username: input.username ?? null,
        model: input.model ?? null,
        tokensIn: input.tokensIn ?? null,
        tokensOut: input.tokensOut ?? null,
        durationMs: input.durationMs ?? null,
        bytes: input.bytes ?? null,
        detail: input.detail ? input.detail.slice(0, 300) : null,
        ip: input.ip ?? null,
      },
    })
    .then(() => prune())
    .catch((err) => console.error("[usage] could not record event", err));
}

async function prune() {
  if (Date.now() - lastPrune < 3_600_000) return;
  lastPrune = Date.now();
  await prisma.usageEvent.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - RETENTION_DAYS * 86_400_000) } } });
}

export const clientIp = (req: Request) =>
  req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;

export type Range = "24h" | "7d" | "30d";
const RANGE_MS: Record<Range, number> = { "24h": 86_400_000, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000 };
export const parseRange = (v: string | null): Range => (v === "7d" || v === "30d" ? v : "24h");

export interface UserUsage {
  userId: string;
  username: string;
  role: string;
  status: string;
  chats: number;
  images: number;
  uploads: number;
  errors: number;
  tokensIn: number;
  tokensOut: number;
  genSeconds: number;
  lastActive: string | null;
}

export async function usageSummary(range: Range) {
  const since = new Date(Date.now() - RANGE_MS[range]);
  const [users, events] = await Promise.all([
    prisma.user.findMany({ where: { username: { not: "local" } }, select: { id: true, username: true, role: true, status: true, lastLoginAt: true } }),
    prisma.usageEvent.findMany({ where: { createdAt: { gte: since } }, select: { userId: true, type: true, status: true, model: true, tokensIn: true, tokensOut: true, durationMs: true, createdAt: true }, orderBy: { createdAt: "asc" }, take: 200_000 }),
  ]);

  const per = new Map<string, UserUsage>(
    users.map((u) => [u.id, { userId: u.id, username: u.username, role: u.role, status: u.status, chats: 0, images: 0, uploads: 0, errors: 0, tokensIn: 0, tokensOut: 0, genSeconds: 0, lastActive: u.lastLoginAt?.toISOString() ?? null }]),
  );
  const buckets = new Map<string, { t: string; chats: number; images: number; tokens: number; errors: number }>();
  const models = new Map<string, { model: string; requests: number; tokensOut: number }>();
  const hourly = range === "24h";
  const totals = { chats: 0, images: 0, uploads: 0, errors: 0, tokensIn: 0, tokensOut: 0, activeUsers: new Set<string>() };

  for (const e of events) {
    const key = hourly ? e.createdAt.toISOString().slice(0, 13) : e.createdAt.toISOString().slice(0, 10);
    const b = buckets.get(key) ?? { t: key, chats: 0, images: 0, tokens: 0, errors: 0 };
    const u = e.userId ? per.get(e.userId) : undefined;
    if (e.status === "error") {
      b.errors++;
      totals.errors++;
      if (u) u.errors++;
    }
    if (e.type === "chat") {
      b.chats++; totals.chats++;
      b.tokens += (e.tokensIn ?? 0) + (e.tokensOut ?? 0);
      totals.tokensIn += e.tokensIn ?? 0; totals.tokensOut += e.tokensOut ?? 0;
      if (e.model) {
        const m = models.get(e.model) ?? { model: e.model, requests: 0, tokensOut: 0 };
        m.requests++; m.tokensOut += e.tokensOut ?? 0; models.set(e.model, m);
      }
      if (u) { u.chats++; u.tokensIn += e.tokensIn ?? 0; u.tokensOut += e.tokensOut ?? 0; u.genSeconds += (e.durationMs ?? 0) / 1000; }
    } else if (e.type === "image") {
      b.images++; totals.images++; if (u) { u.images++; u.genSeconds += (e.durationMs ?? 0) / 1000; }
    } else if (e.type === "upload") {
      totals.uploads++; if (u) u.uploads++;
    }
    if (e.userId && ["chat", "image", "upload"].includes(e.type)) {
      totals.activeUsers.add(e.userId);
      if (u && (!u.lastActive || e.createdAt.toISOString() > u.lastActive)) u.lastActive = e.createdAt.toISOString();
    }
    buckets.set(key, b);
  }

  // Fill gaps so charts have a continuous axis.
  const series: { t: string; chats: number; images: number; tokens: number; errors: number }[] = [];
  const step = hourly ? 3_600_000 : 86_400_000;
  const end = Date.now();
  for (let t = Math.floor((end - RANGE_MS[range]) / step) * step; t <= end; t += step) {
    const key = new Date(t).toISOString().slice(0, hourly ? 13 : 10);
    series.push(buckets.get(key) ?? { t: key, chats: 0, images: 0, tokens: 0, errors: 0 });
  }

  return {
    range,
    totals: { ...totals, activeUsers: totals.activeUsers.size },
    users: [...per.values()].sort((a, b) => b.tokensOut + b.images * 500 - (a.tokensOut + a.images * 500)),
    series,
    models: [...models.values()].sort((a, b) => b.requests - a.requests),
  };
}

export interface LogQuery {
  type?: string;
  status?: string;
  userId?: string;
  q?: string;
  cursor?: string;
  limit?: number;
  since?: Date;
}

export async function listLogs(q: LogQuery) {
  const take = Math.min(Math.max(q.limit ?? 50, 1), 500);
  const search = q.q?.trim();
  const rows = await prisma.usageEvent.findMany({
    where: {
      ...(q.type ? { type: q.type } : {}),
      ...(q.status ? { status: q.status } : {}),
      ...(q.userId ? { userId: q.userId } : {}),
      ...(q.since ? { createdAt: { gte: q.since } } : {}),
      ...(search ? { OR: (['username', 'detail', 'model', 'ip'] as const).map((f) => ({ [f]: { contains: search, mode: 'insensitive' as const } })) } : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: take + 1,
    ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
  });
  const more = rows.length > take;
  const page = rows.slice(0, take);
  return { events: page.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })), nextCursor: more ? page[page.length - 1]!.id : null };
}
