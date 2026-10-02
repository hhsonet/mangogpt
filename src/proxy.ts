import { NextResponse, type NextRequest } from "next/server";
import { authEnabled, COOKIE, verifySessionToken } from "@/lib/auth/session";

const PUBLIC = ["/login", "/api/auth/login", "/api/auth/signup", "/api/auth/config"];

/** Gate everything behind the session cookie when APP_PASSWORD is set. */
export async function proxy(req: NextRequest) {
  if (!authEnabled()) return NextResponse.next();
  const { pathname } = req.nextUrl;
  if (PUBLIC.includes(pathname)) return NextResponse.next();
  if (await verifySessionToken(req.cookies.get(COOKIE)?.value)) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ code: "unauthorized", message: "Please sign in." }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
