import { getImagesEnabled, getSignupMode, setImagesEnabled, setSignupMode, SIGNUP_MODES, type SignupMode } from "@/services/app-config";
import { clientIp, logEvent } from "@/services/usage";
import { authed, json, readJson } from "../../_lib";

export const dynamic = "force-dynamic";

export async function GET() {
  const a = await authed({ admin: true });
  if (!a.ok) return a.res;
  return json({ signupMode: await getSignupMode(), imagesEnabled: await getImagesEnabled() });
}

export async function PATCH(req: Request) {
  const a = await authed({ admin: true });
  if (!a.ok) return a.res;
  const body = await readJson<{ signupMode?: SignupMode; imagesEnabled?: boolean }>(req);
  if (!body) return json({ code: "bad_request", message: "Invalid JSON" }, 400);
  if (body.signupMode !== undefined) {
    if (!SIGNUP_MODES.includes(body.signupMode)) return json({ code: "bad_request", message: "Invalid sign-up mode." }, 400);
    await setSignupMode(body.signupMode);
  }
  if (typeof body.imagesEnabled === "boolean") await setImagesEnabled(body.imagesEnabled);
  logEvent({ type: "admin", userId: a.user.id, username: a.user.username, ip: clientIp(req), detail: [body.signupMode && `sign-ups: ${body.signupMode}`, typeof body.imagesEnabled === "boolean" && `images: ${body.imagesEnabled ? "on" : "off"}`].filter(Boolean).join(", ") });
  return json({ signupMode: await getSignupMode(), imagesEnabled: await getImagesEnabled() });
}
