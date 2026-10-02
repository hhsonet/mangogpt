import { ensureSampler, history, takeSample } from "@/lib/monitor/sampler";
import { authed, json } from "../../_lib";

export const dynamic = "force-dynamic";

/** Current sample plus up to an hour of history. */
export async function GET() {
  const a = await authed({ admin: true });
  if (!a.ok) return a.res;
  ensureSampler();
  return json({ current: await takeSample(), history: history() });
}
