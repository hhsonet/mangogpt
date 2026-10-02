import "server-only";
import { cookies } from "next/headers";
import { prisma } from "@/lib/db/prisma";
import { hashPassword } from "./password";
import { authEnabled, COOKIE, verifySessionToken } from "./session";

export interface CurrentUser {
  id: string;
  username: string;
  role: "admin" | "user";
}

/** Without AUTH_SECRET the app is single-user (SSH-tunnel mode): everything belongs to a built-in admin. */
async function localUser(): Promise<CurrentUser> {
  let u = await prisma.user.findUnique({ where: { username: "local" } });
  if (!u) {
    await prisma.user.createMany({ data: [{ username: "local", role: "admin", passwordHash: await hashPassword(crypto.randomUUID()) }], skipDuplicates: true });
    u = await prisma.user.findUniqueOrThrow({ where: { username: "local" } });
  }
  return { id: u.id, username: u.username, role: "admin" };
}

/**
 * Resolve the signed-in user from the session cookie, then re-check the database so a disabled or
 * deleted account loses access immediately instead of when its 7-day cookie expires.
 */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  if (!authEnabled()) return localUser();
  const session = await verifySessionToken((await cookies()).get(COOKIE)?.value);
  if (!session) return null;
  const user = await prisma.user.findUnique({ where: { id: session.id } });
  if (!user || user.status !== "active") return null;
  return { id: user.id, username: user.username, role: user.role === "admin" ? "admin" : "user" };
}
