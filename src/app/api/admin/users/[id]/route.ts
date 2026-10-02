import { NextResponse } from "next/server";
import { deleteUser, updateUser, UserError, type UserRole, type UserStatus } from "@/services/users";
import { clientIp, logEvent } from "@/services/usage";
import { prisma } from "@/lib/db/prisma";
import { authed, json, readJson } from "../../../_lib";

type Ctx = { params: Promise<{ id: string }> };

const fail = (err: unknown) => {
  if (err instanceof UserError) return NextResponse.json({ code: err.code, message: err.message }, { status: err.status });
  throw err;
};

export async function PATCH(req: Request, { params }: Ctx) {
  const a = await authed({ admin: true });
  if (!a.ok) return a.res;
  const body = await readJson<{ role?: UserRole; status?: UserStatus; password?: string }>(req);
  if (!body) return json({ code: "bad_request", message: "Invalid JSON" }, 400);
  try {
    const updated = await updateUser(a.user.id, (await params).id, { role: body.role, status: body.status, password: body.password });
    const what = [body.status && `status → ${body.status}`, body.role && `role → ${body.role}`, body.password && "password reset"].filter(Boolean).join(", ");
    logEvent({ type: "admin", userId: a.user.id, username: a.user.username, ip: clientIp(req), detail: `${updated.username}: ${what}` });
    return json(updated);
  } catch (err) {
    return fail(err);
  }
}

export async function DELETE(req: Request, { params }: Ctx) {
  const a = await authed({ admin: true });
  if (!a.ok) return a.res;
  try {
    const id = (await params).id;
    const target = await prisma.user.findUnique({ where: { id }, select: { username: true } });
    await deleteUser(a.user.id, id);
    logEvent({ type: "admin", userId: a.user.id, username: a.user.username, ip: clientIp(req), detail: `deleted user ${target?.username ?? id}` });
    return json({ ok: true });
  } catch (err) {
    return fail(err);
  }
}
