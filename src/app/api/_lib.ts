import { NextResponse } from "next/server";
import { getCurrentUser, type CurrentUser } from "@/lib/auth/current-user";
import { OllamaError, toOllamaError } from "@/lib/ollama/errors";

export const json = <T>(data: T, status = 200) => NextResponse.json(data, { status });

export function errorResponse(err: unknown) {
  const e = err instanceof OllamaError ? err : toOllamaError(err);
  // Never leak stack traces; log server-side only.
  console.error("[api]", err);
  return NextResponse.json({ code: e.code, message: e.message }, { status: e.status });
}

export function notFound(what = "Not found") {
  return NextResponse.json({ code: "bad_request", message: what }, { status: 404 });
}

export async function readJson<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

type Authed = { ok: true; user: CurrentUser } | { ok: false; res: NextResponse };

/** Resolve the signed-in user (and optionally require admin). Use: `const a = await authed(); if (!a.ok) return a.res;` */
export async function authed(opts?: { admin?: boolean }): Promise<Authed> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, res: NextResponse.json({ code: "unauthorized", message: "Please sign in." }, { status: 401 }) };
  if (opts?.admin && user.role !== "admin") {
    return { ok: false, res: NextResponse.json({ code: "forbidden", message: "Admins only." }, { status: 403 }) };
  }
  return { ok: true, user };
}
