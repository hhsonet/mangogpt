import { NextResponse } from "next/server";
import { createUser, listUsers, UserError, type UserRole, type UserStatus } from "@/services/users";
import { clientIp, logEvent } from "@/services/usage";
import { authed, json, readJson } from "../../_lib";

export const dynamic = "force-dynamic";

export async function GET() {
  const a = await authed({ admin: true });
  if (!a.ok) return a.res;
  return json({ users: await listUsers(), currentUserId: a.user.id });
}

export async function POST(req: Request) {
  const a = await authed({ admin: true });
  if (!a.ok) return a.res;
  const body = await readJson<{ username?: string; email?: string; password?: string; role?: UserRole; status?: UserStatus }>(req);
  try {
    const u = await createUser({ username: body?.username ?? "", email: body?.email, password: body?.password ?? "", role: body?.role === "admin" ? "admin" : "user", status: "active" });
    logEvent({ type: "admin", userId: a.user.id, username: a.user.username, ip: clientIp(req), detail: `added user ${u.username} (${u.role})` });
    return json({ id: u.id }, 201);
  } catch (err) {
    if (err instanceof UserError) return NextResponse.json({ code: err.code, message: err.message }, { status: err.status });
    throw err;
  }
}
