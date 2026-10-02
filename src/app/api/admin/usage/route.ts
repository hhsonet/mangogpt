import { parseRange, usageSummary } from "@/services/usage";
import { authed, json } from "../../_lib";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const a = await authed({ admin: true });
  if (!a.ok) return a.res;
  return json(await usageSummary(parseRange(new URL(req.url).searchParams.get("range"))));
}
