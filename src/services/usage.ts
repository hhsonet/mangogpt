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

type Summary = Awaited<ReturnType<typeof computeSummary>>;

// Shared across route bundles. Results are cached briefly and identical in-flight requests are merged,
// so many admins refreshing at once cost one calculation instead of many.
const g = globalThis as unknown as { __mangoUsageCache?: { done: Map<Range, { at: number; value: Summary }>; inflight: Map<Range, Promise<Summary>> } };
const cache = (g.__mangoUsageCache ??= { done: new Map(), inflight: new Map() });
const CACHE_MS = 15_000;

export async function usageSummary(range: Range): Promise<Summary> {
  const hit = cache.done.get(range);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const running = cache.inflight.get(range);
  if (running) return running;
  const p = computeSummary(range)
    .then((value) => {
      cache.done.set(range, { at: Date.now(), value });
      return value;
    })
    .finally(() => cache.inflight.delete(range));
  cache.inflight.set(range, p);
  return p;
}

interface PerUserRow { userId: string; chats: number; images: number; uploads: number; errors: number; tokensIn: bigint; tokensOut: bigint; durMs: bigint; lastActive: Date | null }
interface TotalsRow { chats: number; images: number; uploads: number; errors: number; tokensIn: bigint; tokensOut: bigint; active: number }
interface BucketRow { t: string; chats: number; images: number; tokens: bigint; errors: number }
interface ModelRow { model: string; requests: number; tokensOut: bigint }

/** All counting and summing happens in PostgreSQL; only the small result set reaches the app. */
async function computeSummary(range: Range) {
  const since = new Date(Date.now() - RANGE_MS[range]);
  const hourly = range === "24h";
  const bucketFormat = hourly ? 'YYYY-MM-DD"T"HH24' : "YYYY-MM-DD";

  const [users, perUser, totalsRows, buckets, models] = await Promise.all([
    prisma.user.findMany({ where: { username: { not: "local" } }, select: { id: true, username: true, role: true, status: true, lastLoginAt: true } }),
    prisma.$queryRaw<PerUserRow[]>`
      SELECT "userId",
             (count(*) FILTER (WHERE type = 'chat'))::int AS chats,
             (count(*) FILTER (WHERE type = 'image'))::int AS images,
             (count(*) FILTER (WHERE type = 'upload'))::int AS uploads,
             (count(*) FILTER (WHERE status = 'error'))::int AS errors,
             coalesce(sum("tokensIn") FILTER (WHERE type = 'chat'), 0)::bigint AS "tokensIn",
             coalesce(sum("tokensOut") FILTER (WHERE type = 'chat'), 0)::bigint AS "tokensOut",
             coalesce(sum("durationMs") FILTER (WHERE type IN ('chat', 'image')), 0)::bigint AS "durMs",
             max("createdAt") FILTER (WHERE type IN ('chat', 'image', 'upload')) AS "lastActive"
      FROM "UsageEvent"
      WHERE "createdAt" >= ${since} AND "userId" IS NOT NULL
      GROUP BY "userId"`,
    prisma.$queryRaw<TotalsRow[]>`
      SELECT (count(*) FILTER (WHERE type = 'chat'))::int AS chats,
             (count(*) FILTER (WHERE type = 'image'))::int AS images,
             (count(*) FILTER (WHERE type = 'upload'))::int AS uploads,
             (count(*) FILTER (WHERE status = 'error'))::int AS errors,
             coalesce(sum("tokensIn") FILTER (WHERE type = 'chat'), 0)::bigint AS "tokensIn",
             coalesce(sum("tokensOut") FILTER (WHERE type = 'chat'), 0)::bigint AS "tokensOut",
             (count(DISTINCT "userId") FILTER (WHERE type IN ('chat', 'image', 'upload')))::int AS active
      FROM "UsageEvent"
      WHERE "createdAt" >= ${since}`,
    prisma.$queryRaw<BucketRow[]>`
      SELECT to_char("createdAt" AT TIME ZONE 'UTC', ${bucketFormat}) AS t,
             (count(*) FILTER (WHERE type = 'chat'))::int AS chats,
             (count(*) FILTER (WHERE type = 'image'))::int AS images,
             coalesce(sum(coalesce("tokensIn", 0) + coalesce("tokensOut", 0)) FILTER (WHERE type = 'chat'), 0)::bigint AS tokens,
             (count(*) FILTER (WHERE status = 'error'))::int AS errors
      FROM "UsageEvent"
      WHERE "createdAt" >= ${since}
      GROUP BY 1`,
    prisma.$queryRaw<ModelRow[]>`
      SELECT model, count(*)::int AS requests, coalesce(sum("tokensOut"), 0)::bigint AS "tokensOut"
      FROM "UsageEvent"
      WHERE "createdAt" >= ${since} AND type = 'chat' AND model IS NOT NULL
      GROUP BY model
      ORDER BY requests DESC`,
  ]);

  const stats = new Map(perUser.map((r) => [r.userId, r]));
  const userRows: UserUsage[] = users
    .map((u) => {
      const r = stats.get(u.id);
      const lastEvent = r?.lastActive ?? null;
      const last = lastEvent && (!u.lastLoginAt || lastEvent > u.lastLoginAt) ? lastEvent : u.lastLoginAt;
      return {
        userId: u.id,
        username: u.username,
        role: u.role,
        status: u.status,
        chats: r?.chats ?? 0,
        images: r?.images ?? 0,
        uploads: r?.uploads ?? 0,
        errors: r?.errors ?? 0,
        tokensIn: Number(r?.tokensIn ?? 0),
        tokensOut: Number(r?.tokensOut ?? 0),
        genSeconds: Number(r?.durMs ?? 0) / 1000,
        lastActive: last?.toISOString() ?? null,
      };
    })
    .sort((a, b) => b.tokensOut + b.images * 500 - (a.tokensOut + a.images * 500));

  // Fill gaps so charts have a continuous axis.
  const byKey = new Map(buckets.map((b) => [b.t, b]));
  const series: { t: string; chats: number; images: number; tokens: number; errors: number }[] = [];
  const step = hourly ? 3_600_000 : 86_400_000;
  const end = Date.now();
  for (let t = Math.floor((end - RANGE_MS[range]) / step) * step; t <= end; t += step) {
    const key = new Date(t).toISOString().slice(0, hourly ? 13 : 10);
    const b = byKey.get(key);
    series.push(b ? { t: key, chats: b.chats, images: b.images, tokens: Number(b.tokens), errors: b.errors } : { t: key, chats: 0, images: 0, tokens: 0, errors: 0 });
  }

  const t = totalsRows[0];
  return {
    range,
    totals: { chats: t?.chats ?? 0, images: t?.images ?? 0, uploads: t?.uploads ?? 0, errors: t?.errors ?? 0, tokensIn: Number(t?.tokensIn ?? 0), tokensOut: Number(t?.tokensOut ?? 0), activeUsers: t?.active ?? 0 },
    users: userRows,
    series,
    models: models.map((m) => ({ model: m.model, requests: m.requests, tokensOut: Number(m.tokensOut) })),
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
