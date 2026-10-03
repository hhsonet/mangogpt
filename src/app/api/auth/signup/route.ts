import { NextResponse } from "next/server";
import { COOKIE, createSessionToken, SESSION_SECONDS, authEnabled } from "@/lib/auth/session";
import { getSignupMode } from "@/services/app-config";
import { notifyNewSignup } from "@/lib/notify";
import { clientIp as ipOf, logEvent } from "@/services/usage";
import { createUser, UserError } from "@/services/users";

export const runtime = "nodejs";

// 3 sign-ups per IP per hour (in memory; resets on restart).
const attempts = new Map<string, { count: number; resetAt: number }>();
const MAX = 3;
const WINDOW_MS = 60 * 60_000;

const clientIp = (req: Request) => ipOf(req) ?? "local";

export async function POST(req: Request) {
  if (!authEnabled()) return NextResponse.json({ code: "bad_request", message: "Accounts are disabled on this server." }, { status: 400 });
  const mode = await getSignupMode();
  if (mode === "closed") {
    return NextResponse.json({ code: "signup_closed", message: "Sign-ups are closed. Ask an admin to create an account for you." }, { status: 403 });
  }

  const ip = clientIp(req);
  const now = Date.now();
  const rec = attempts.get(ip);
  if (rec && rec.resetAt > now && rec.count >= MAX) {
    return NextResponse.json({ code: "rate_limited", message: "Too many sign-up attempts from this network. Try again later." }, { status: 429 });
  }

  const body = (await req.json().catch(() => null)) as { username?: string; email?: string; password?: string } | null;
  try {
    const user = await createUser({
      username: body?.username ?? "",
      email: body?.email ?? "",
      requireEmail: true,
      password: body?.password ?? "",
      role: "user",
      status: mode === "open" ? "active" : "pending",
    });
    logEvent({ type: "signup", userId: user.id, username: user.username, ip: ipOf(req), detail: `${user.email ?? "no email"} (${user.status})` });
    notifyNewSignup({ username: user.username, email: user.email, status: user.status }, ipOf(req));
    attempts.set(ip, { count: (rec && rec.resetAt > now ? rec.count : 0) + 1, resetAt: rec && rec.resetAt > now ? rec.resetAt : now + WINDOW_MS });

    if (user.status === "pending") return NextResponse.json({ ok: true, status: "pending" }, { status: 201 });
    const res = NextResponse.json({ ok: true, status: "active" }, { status: 201 });
    res.cookies.set(COOKIE, await createSessionToken({ id: user.id, username: user.username, role: user.role }), {
      httpOnly: true,
      sameSite: "lax",
      secure: req.headers.get("x-forwarded-proto") === "https",
      path: "/",
      maxAge: SESSION_SECONDS,
    });
    return res;
  } catch (err) {
    if (err instanceof UserError) return NextResponse.json({ code: err.code, message: err.message }, { status: err.status });
    console.error("[signup]", err);
    return NextResponse.json({ code: "generation_failed", message: "Something went wrong. Please try again." }, { status: 500 });
  }
}
