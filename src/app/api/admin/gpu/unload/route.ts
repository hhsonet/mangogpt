import { unloadImageModel } from "@/lib/images/client";
import { unloadAllModels } from "@/lib/ollama/client";
import { clientIp, logEvent } from "@/services/usage";
import { authed, json } from "../../../_lib";

/** Admin action: free GPU memory by evicting the chat model(s) and the image model. */
export async function POST(req: Request) {
  const a = await authed({ admin: true });
  if (!a.ok) return a.res;
  await Promise.all([unloadAllModels(), unloadImageModel()]);
  logEvent({ type: "admin", userId: a.user.id, username: a.user.username, ip: clientIp(req), detail: "unloaded GPU models" });
  return json({ ok: true });
}
