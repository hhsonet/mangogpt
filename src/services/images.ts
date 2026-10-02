import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/db/prisma";
import type { ImageSize } from "@/types";

const ROOT = path.resolve(/* turbopackIgnore: true */ process.env.UPLOAD_DIR ?? "./uploads", "images");
const ID_RE = /^[a-z0-9]{20,40}$/i;

const sizes: ImageSize[] = ["square", "portrait", "landscape"];
export const parseSize = (v: unknown): ImageSize => (sizes.includes(v as ImageSize) ? (v as ImageSize) : "square");

const dirFor = (userId: string) => path.join(/* turbopackIgnore: true */ ROOT, userId);

/** Resolve a stored relative path, refusing anything that escapes the images directory. */
function safePath(rel: string): string {
  const full = path.resolve(/* turbopackIgnore: true */ ROOT, rel);
  if (!full.startsWith(ROOT + path.sep)) throw new Error("Invalid image path");
  return full;
}

export async function saveImage(input: { userId: string; conversationId: string; prompt: string; size: ImageSize; steps: number; seed: number; png: Buffer }) {
  const row = await prisma.image.create({
    data: { userId: input.userId, conversationId: input.conversationId, prompt: input.prompt, size: input.size, steps: input.steps, seed: input.seed, filepath: "pending" },
  });
  const rel = path.join(input.userId, `${row.id}.png`);
  await fs.mkdir(dirFor(input.userId), { recursive: true });
  await fs.writeFile(safePath(rel), input.png, { mode: 0o600 });
  return prisma.image.update({ where: { id: row.id }, data: { filepath: rel } });
}

/** Image bytes, only if it belongs to `userId`. */
export async function readImage(userId: string, id: string): Promise<Buffer | null> {
  if (!ID_RE.test(id)) return null;
  const row = await prisma.image.findFirst({ where: { id, userId } });
  if (!row) return null;
  return fs.readFile(safePath(row.filepath)).catch(() => null);
}

export async function removeImageFiles(files: string[]) {
  await Promise.all(files.map((f) => fs.rm(safePath(f), { force: true }).catch(() => undefined)));
}

export async function imageFilesWhere(where: { userId?: string; conversationId?: string }) {
  return (await prisma.image.findMany({ where, select: { filepath: true } })).map((r) => r.filepath).filter((p) => p !== "pending");
}

export async function removeUserImageDir(userId: string) {
  await fs.rm(dirFor(userId), { recursive: true, force: true }).catch(() => undefined);
}

// Per-user sliding-window limit (in memory; resets on restart): 20/hour, admins 100/hour.
const history = new Map<string, number[]>();
export function imageRateLimit(userId: string, isAdmin: boolean): { ok: boolean; retryAfterMin: number } {
  const limit = isAdmin ? 100 : 20;
  const now = Date.now();
  const recent = (history.get(userId) ?? []).filter((t) => now - t < 3_600_000);
  if (recent.length >= limit) return { ok: false, retryAfterMin: Math.max(1, Math.ceil((3_600_000 - (now - recent[0]!)) / 60_000)) };
  recent.push(now);
  history.set(userId, recent);
  return { ok: true, retryAfterMin: 0 };
}
