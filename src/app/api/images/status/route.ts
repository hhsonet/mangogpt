import { imageHealth } from "@/lib/images/client";
import { getImagesEnabled } from "@/services/app-config";
import { authed, json } from "../../_lib";

export const dynamic = "force-dynamic";

/** Tells the UI whether to offer image mode. */
export async function GET() {
  const a = await authed();
  if (!a.ok) return a.res;
  const [enabled, health] = await Promise.all([getImagesEnabled(), imageHealth()]);
  return json({ enabled, running: health.ok, available: enabled && health.ok, loaded: health.loaded ?? false, model: health.model ?? null });
}
