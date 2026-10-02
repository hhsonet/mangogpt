import { NextResponse } from "next/server";
import { authEnabled } from "@/lib/auth/session";
import { getCurrentUser } from "@/lib/auth/current-user";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getCurrentUser();
  return NextResponse.json({ enabled: authEnabled(), username: user?.username ?? null, role: user?.role ?? null });
}
