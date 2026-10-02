// Self-contained (no path aliases) so scripts can import it directly with Node's type stripping.
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const KEYLEN = 64;
const PARAMS = { N: 16384, r: 8, p: 1 };

const derive = (password: string, salt: Buffer) =>
  new Promise<Buffer>((resolve, reject) => scrypt(password, salt, KEYLEN, PARAMS, (err, key) => (err ? reject(err) : resolve(key))));

/** Format: scrypt$<salt hex>$<hash hex> */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString("hex")}$${(await derive(password, salt)).toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, hashHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = await derive(password, Buffer.from(saltHex, "hex"));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

// Precomputed so unknown usernames cost the same time as wrong passwords.
export const DUMMY_HASH = `scrypt$${"00".repeat(16)}$${"00".repeat(KEYLEN)}`;
