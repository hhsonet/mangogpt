import { notifyAdmins } from "@/lib/notify";
import { clientIp, logEvent } from "@/services/usage";
import { authed, json } from "../../../_lib";

export async function POST(req: Request) {
  const a = await authed({ admin: true });
  if (!a.ok) return a.res;
  const result = await notifyAdmins(
    { title: "Test notification", lines: [["Sent by", a.user.username], ["Time", new Date().toUTCString()]], linkPath: "/admin" },
    { force: true },
  );
  logEvent({ type: "admin", userId: a.user.id, username: a.user.username, ip: clientIp(req), detail: `test notification: slack ${result.slack}, telegram ${result.telegram}` });
  return json(result);
}
