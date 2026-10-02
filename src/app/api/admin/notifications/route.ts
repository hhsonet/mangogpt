import { channelStatus } from "@/lib/notify";
import { authed, json } from "../../_lib";

export const dynamic = "force-dynamic";

/** Which channels are configured (never the secrets themselves). */
export async function GET() {
  const a = await authed({ admin: true });
  if (!a.ok) return a.res;
  return json(channelStatus());
}
