import { listLogs, parseRange } from "@/services/usage";
import { authed, json } from "../../_lib";

export const dynamic = "force-dynamic";

const RANGE_MS = { "24h": 86_400_000, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000 } as const;
const csv = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""').replace(/^([=+\-@])/, "'$1")}"`; // neutralise spreadsheet formulas

export async function GET(req: Request) {
  const a = await authed({ admin: true });
  if (!a.ok) return a.res;
  const p = new URL(req.url).searchParams;
  const range = parseRange(p.get("range"));
  const query = {
    type: p.get("type") || undefined,
    status: p.get("status") || undefined,
    userId: p.get("user") || undefined,
    q: p.get("q") || undefined,
    cursor: p.get("cursor") || undefined,
    since: new Date(Date.now() - RANGE_MS[range]),
  };

  if (p.get("format") === "csv") {
    const { events } = await listLogs({ ...query, cursor: undefined, limit: 500 });
    const head = "time,type,status,user,model,tokens_in,tokens_out,duration_ms,bytes,ip,detail";
    const rows = events.map((e) => [e.createdAt, e.type, e.status, e.username, e.model, e.tokensIn, e.tokensOut, e.durationMs, e.bytes, e.ip, e.detail].map(csv).join(","));
    return new Response([head, ...rows].join("\n"), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="mangogpt-logs-${range}.csv"`, "Cache-Control": "no-store" } });
  }
  return json(await listLogs({ ...query, limit: Number(p.get("limit") ?? 50) }));
}
