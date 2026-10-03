import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { DUMMY_HASH, verifyPassword } from "@/lib/auth/password";
import { authEnabled, COOKIE, createSessionToken, SESSION_SECONDS } from "@/lib/auth/session";
import { clientIp as ipOf, logEvent } from "@/services/usage";

export const runtime = "nodejs";

// Failed-attempt limiter keyed by IP and by username (in memory; resets on restart).
const attempts = new Map<string, { count: number; resetAt: number }>();
const MAX_FAILS = 5;
const WINDOW_MS = 60_000;

const clientIp = (req: Request) => ipOf(req) ?? "local";

function limited(key: string, now: number) {
  const r = attempts.get(key);
  return Boolean(r && r.resetAt > now && r.count >= MAX_FAILS);
}
function fail(key: string, now: number) {
  const r = attempts.get(key);
  attempts.set(key, r && r.resetAt > now ? { ...r, count: r.count + 1 } : { count: 1, resetAt: now + WINDOW_MS });
}

export async function POST(req: Request) {
  if (!authEnabled()) return NextResponse.json({ ok: true });
  const body = (await req.json().catch(() => null)) as { username?: string; password?: string } | null;
  const username = typeof body?.username === "string" ? body.username.trim().toLowerCase().slice(0, 254) : "";
  const password = typeof body?.password === "string" ? body.password.slice(0, 256) : "";

  const now = Date.now();
  const keys = [`ip:${clientIp(req)}`, `user:${username}`];
  if (keys.some((k) => limited(k, now))) {
    logEvent({ type: "login_failed", status: "error", username: username || null, ip: ipOf(req), detail: "rate limited" });
    return NextResponse.json({ code: "rate_limited", message: "Too many attempts. Try again in a minute." }, { status: 429 });
  }

  const user = username
    ? await prisma.user.findUnique({ where: username.includes("@") ? { email: username } : { username } })
    : null;
  // Always run a hash comparison so response time does not reveal whether the user exists.
  const ok = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !ok) {
    logEvent({ type: "login_failed", status: "error", userId: user?.id, username: username || null, ip: ipOf(req), detail: user ? "wrong password" : "unknown user" });
    keys.forEach((k) => fail(k, now));
    return NextResponse.json({ code: "bad_credentials", message: "That username and password don't match. Check them and try again." }, { status: 401 });
  }

  // Only after the password is proven do we reveal the account state.
  if (user.status !== "active") logEvent({ type: "login_failed", status: "error", userId: user.id, username: user.username, ip: ipOf(req), detail: `account ${user.status}` });
  if (user.status === "pending") {
    return NextResponse.json({ code: "pending", message: "Your account is waiting for admin approval. You'll be able to sign in once it's approved." }, { status: 403 });
  }
  if (user.status !== "active") {
    return NextResponse.json({ code: "disabled", message: "This account is disabled. Contact an admin to get access back." }, { status: 403 });
  }

  keys.forEach((k) => attempts.delete(k));
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  logEvent({ type: "login", userId: user.id, username: user.username, ip: ipOf(req) });
  const res = NextResponse.json({ ok: true, username: user.username });
  res.cookies.set(COOKIE, await createSessionToken({ id: user.id, username: user.username, role: user.role }), {
    httpOnly: true,
    sameSite: "lax",
    secure: req.headers.get("x-forwarded-proto") === "https",
    path: "/",
    maxAge: SESSION_SECONDS,
  });
  return res;
}
