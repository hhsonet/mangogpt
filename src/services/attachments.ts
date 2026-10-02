import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/db/prisma";
import { AttachmentError, extractText, inspectFile, sanitizeFilename, type AttachmentKind } from "@/lib/extract";

const ROOT = path.resolve(/* turbopackIgnore: true */ process.env.UPLOAD_DIR ?? "./uploads", "files");
const MAX_MB = Number(process.env.MAX_UPLOAD_MB ?? 25);
export const MAX_FILE_BYTES = MAX_MB * 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_PER_MESSAGE = 5;
const MAX_PENDING = 20;
const USER_QUOTA_BYTES = 500 * 1024 * 1024;
const ID_RE = /^[a-z0-9]{20,40}$/i;

export interface AttachmentInfo {
  id: string;
  filename: string;
  kind: AttachmentKind;
  mimeType: string;
  size: number;
  /** Rough token count of extracted text (chars / 4); 0 for images. */
  tokens: number;
}

const toInfo = (a: { id: string; filename: string; kind: string; mimeType: string; size: number; extractedText: string | null }): AttachmentInfo => ({
  id: a.id,
  filename: a.filename,
  kind: a.kind as AttachmentKind,
  mimeType: a.mimeType,
  size: a.size,
  tokens: a.extractedText ? Math.ceil(a.extractedText.length / 4) : 0,
});

/** Resolve a stored relative path, refusing anything that escapes the files directory. */
function safePath(rel: string): string {
  const full = path.resolve(/* turbopackIgnore: true */ ROOT, rel);
  if (!full.startsWith(ROOT + path.sep)) throw new Error("Invalid attachment path");
  return full;
}

// 60 uploads per hour per user (in memory).
const uploads = new Map<string, number[]>();
function uploadAllowed(userId: string): boolean {
  const now = Date.now();
  const recent = (uploads.get(userId) ?? []).filter((t) => now - t < 3_600_000);
  if (recent.length >= 60) return false;
  recent.push(now);
  uploads.set(userId, recent);
  return true;
}

export async function saveUpload(userId: string, file: File): Promise<AttachmentInfo> {
  if (!uploadAllowed(userId)) throw new AttachmentError("You've uploaded a lot of files in the last hour. Try again later.", 429);
  const filename = sanitizeFilename(file.name);
  const data = Buffer.from(await file.arrayBuffer());
  if (data.length === 0) throw new AttachmentError(`“${filename}” is empty.`);

  const inspected = inspectFile(filename, data);
  const limit = inspected.kind === "image" ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
  if (data.length > limit) throw new AttachmentError(`“${filename}” is too large. The limit is ${Math.round(limit / 1024 / 1024)} MB for ${inspected.kind === "image" ? "images" : "files"}.`, 413);

  const [pending, used] = await Promise.all([
    prisma.attachment.count({ where: { userId, messageId: null } }),
    prisma.attachment.aggregate({ where: { userId }, _sum: { size: true } }),
  ]);
  if (pending >= MAX_PENDING) throw new AttachmentError("Too many files are waiting to be sent. Remove some or send your message first.", 429);
  if ((used._sum.size ?? 0) + data.length > USER_QUOTA_BYTES) throw new AttachmentError("You've reached your storage limit. Delete some conversations with attachments to free up space.", 413);

  const extractedText = await extractText(inspected.kind, inspected.ext, filename, data);

  const row = await prisma.attachment.create({
    data: { userId, filename, mimeType: inspected.mimeType, kind: inspected.kind, size: data.length, filepath: "pending", extractedText },
  });
  const rel = path.join(/* turbopackIgnore: true */ userId, `${row.id}.${inspected.ext}`);
  try {
    await fs.mkdir(path.dirname(safePath(rel)), { recursive: true });
    await fs.writeFile(safePath(rel), data, { mode: 0o600 });
    return toInfo(await prisma.attachment.update({ where: { id: row.id }, data: { filepath: rel } }));
  } catch (err) {
    await prisma.attachment.delete({ where: { id: row.id } }).catch(() => undefined);
    throw err;
  }
}

export async function readAttachment(userId: string, id: string) {
  if (!ID_RE.test(id)) return null;
  const row = await prisma.attachment.findFirst({ where: { id, userId } });
  if (!row || row.filepath === "pending") return null;
  const data = await fs.readFile(safePath(row.filepath)).catch(() => null);
  return data ? { row, data } : null;
}

/** Throws if any id isn't one of the user's unsent uploads; returns the rows. */
export async function validatePending(userId: string, ids: string[]) {
  const unique = [...new Set(ids)];
  if (unique.length > MAX_PER_MESSAGE) throw new AttachmentError(`You can attach up to ${MAX_PER_MESSAGE} files per message.`);
  const rows = await prisma.attachment.findMany({ where: { id: { in: unique }, userId, messageId: null } });
  if (rows.length !== unique.length) throw new AttachmentError("One of the attached files is no longer available. Remove it and try again.", 409);
  return rows;
}

/** Link pending uploads to a message. Only the owner's unattached files, at most MAX_PER_MESSAGE. */
export async function linkAttachments(userId: string, ids: string[], conversationId: string, messageId: string) {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return;
  if (unique.length > MAX_PER_MESSAGE) throw new AttachmentError(`You can attach up to ${MAX_PER_MESSAGE} files per message.`);
  const rows = await prisma.attachment.findMany({ where: { id: { in: unique }, userId, messageId: null } });
  if (rows.length !== unique.length) throw new AttachmentError("One of the attached files is no longer available. Remove it and try again.", 409);
  await prisma.attachment.updateMany({ where: { id: { in: unique } }, data: { conversationId, messageId } });
}

export async function attachmentIdsOfMessage(messageId: string): Promise<string[]> {
  return (await prisma.attachment.findMany({ where: { messageId }, select: { id: true } })).map((a) => a.id);
}

export async function attachmentsForConversation(conversationId: string) {
  const rows = await prisma.attachment.findMany({ where: { conversationId, messageId: { not: null } }, orderBy: { createdAt: "asc" } });
  return rows;
}

export const toAttachmentInfo = toInfo;

export async function removeAttachmentFiles(files: string[]) {
  await Promise.all(files.filter((f) => f !== "pending").map((f) => fs.rm(safePath(f), { force: true }).catch(() => undefined)));
}

export async function attachmentFilesWhere(where: { userId?: string; conversationId?: string; id?: { in: string[] } }) {
  return (await prisma.attachment.findMany({ where, select: { filepath: true } })).map((a) => a.filepath);
}

/** Delete rows and files for these ids (used when messages are truncated). */
export async function deleteAttachments(ids: string[]) {
  if (ids.length === 0) return;
  const files = await attachmentFilesWhere({ id: { in: ids } });
  await prisma.attachment.deleteMany({ where: { id: { in: ids } } });
  await removeAttachmentFiles(files);
}

/** Remove a pending (unsent) upload owned by the user. */
export async function discardPending(userId: string, id: string): Promise<boolean> {
  const row = await prisma.attachment.findFirst({ where: { id, userId, messageId: null } });
  if (!row) return false;
  await deleteAttachments([id]);
  return true;
}

/** Opportunistic cleanup of uploads that were never sent (older than 24 h). */
export async function sweepStalePending() {
  const stale = await prisma.attachment.findMany({ where: { messageId: null, createdAt: { lt: new Date(Date.now() - 86_400_000) } }, select: { id: true } });
  await deleteAttachments(stale.map((s) => s.id));
}

export async function removeUserFileDir(userId: string) {
  await fs.rm(path.join(/* turbopackIgnore: true */ ROOT, userId), { recursive: true, force: true }).catch(() => undefined);
}
