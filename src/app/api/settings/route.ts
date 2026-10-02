import { getSettings, updateSettings } from "@/services/settings";
import type { AppSettings } from "@/types";
import { authed, errorResponse, json, readJson } from "../_lib";

export const dynamic = "force-dynamic";

export async function GET() {
  const a = await authed();
  if (!a.ok) return a.res;
  return json(await getSettings(a.user.id));
}

export async function PATCH(req: Request) {
  const a = await authed();
  if (!a.ok) return a.res;
  const body = await readJson<Partial<AppSettings>>(req);
  if (!body) return json({ code: "bad_request", message: "Invalid JSON" }, 400);
  try {
    return json(await updateSettings(a.user.id, body));
  } catch (err) {
    return errorResponse(err);
  }
}
