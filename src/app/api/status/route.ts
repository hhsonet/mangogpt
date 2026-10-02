import { getStatus } from "@/lib/ollama/client";
import { authed, json } from "../_lib";

export const dynamic = "force-dynamic";

export async function GET() {
  const a = await authed();
  if (!a.ok) return a.res;
  return json(await getStatus());
}
