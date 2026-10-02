import { NextResponse } from "next/server";
import { authEnabled } from "@/lib/auth/session";
import { getSignupMode } from "@/services/app-config";

export const dynamic = "force-dynamic";

/** Public: lets the landing page decide whether to offer "Create account". */
export async function GET() {
  return NextResponse.json({ enabled: authEnabled(), signupMode: await getSignupMode() });
}
