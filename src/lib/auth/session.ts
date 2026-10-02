// Edge/Node-safe (Web Crypto only) so it can run in proxy.ts and in route handlers.
export const COOKIE = "oc_session";
export const SESSION_SECONDS = 60 * 60 * 24 * 7;

/** Login is enforced whenever AUTH_SECRET is set. */
export const authEnabled = () => Boolean(process.env.AUTH_SECRET);

const enc = new TextEncoder();
const toHex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const b64 = (s: string) => btoa(String.fromCharCode(...enc.encode(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64 = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)));

async function hmac(data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(process.env.AUTH_SECRET ?? ""), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export interface Session {
  id: string;
  username: string;
  role: string;
}

export async function createSessionToken(s: Session): Promise<string> {
  const payload = b64(JSON.stringify({ i: s.id, u: s.username, r: s.role, exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS }));
  return `${payload}.${await hmac(payload)}`;
}

export async function verifySessionToken(token: string | undefined): Promise<Session | null> {
  if (!token || !process.env.AUTH_SECRET) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig || !safeEqual(sig, await hmac(payload))) return null;
  try {
    const d = JSON.parse(unb64(payload)) as { i?: string; u?: string; r?: string; exp?: number };
    if (!d.i || !d.u || !d.exp || d.exp < Date.now() / 1000) return null;
    return { id: d.i, username: d.u, role: d.r ?? "user" };
  } catch {
    return null;
  }
}
