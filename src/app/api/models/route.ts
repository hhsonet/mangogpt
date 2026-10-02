import { listModels } from "@/lib/ollama/client";
import { authed, errorResponse, json } from "../_lib";

export const dynamic = "force-dynamic";

export async function GET() {
  const a = await authed();
  if (!a.ok) return a.res;
  try {
    return json({ models: await listModels() });
  } catch (err) {
    return errorResponse(err);
  }
}
