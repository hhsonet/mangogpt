import "server-only";
import { prisma } from "@/lib/db/prisma";
import { imageFilesWhere, removeImageFiles } from "@/services/images";
import { attachmentFilesWhere, attachmentsForConversation, deleteAttachments, removeAttachmentFiles, toAttachmentInfo } from "@/services/attachments";
import type { ChatMessage, ConversationDetail, ConversationSummary, ImageSize, Role } from "@/types";

type ConvRow = Awaited<ReturnType<typeof prisma.conversation.findFirstOrThrow>>;
type MsgRow = Awaited<ReturnType<typeof prisma.message.findFirstOrThrow>>;

const toSummary = (c: ConvRow): ConversationSummary => ({
  id: c.id,
  title: c.title,
  model: c.model,
  projectId: c.projectId,
  pinned: c.pinned,
  createdAt: c.createdAt.toISOString(),
  updatedAt: c.updatedAt.toISOString(),
});

export const toMessage = (m: MsgRow): ChatMessage => ({
  id: m.id,
  conversationId: m.conversationId,
  role: m.role as Role,
  content: m.content,
  thinking: m.thinking,
  imageId: m.imageId,
  model: m.model,
  createdAt: m.createdAt.toISOString(),
});

export async function listConversations(userId: string, search?: string): Promise<ConversationSummary[]> {
  const q = search?.trim();
  const rows = await prisma.conversation.findMany({
    where: {
      userId,
      ...(q ? { OR: [{ title: { contains: q, mode: "insensitive" } }, { messages: { some: { content: { contains: q, mode: "insensitive" } } } }] } : {}),
    },
    orderBy: [{ pinned: "desc" }, { updatedAt: "desc" }],
    take: 500,
  });
  return rows.map(toSummary);
}

export async function getConversation(userId: string, id: string): Promise<ConversationDetail | null> {
  const row = await prisma.conversation.findFirst({
    where: { id, userId },
    include: { messages: { orderBy: { createdAt: "asc" } }, images: { select: { id: true, size: true } } },
  });
  if (!row) return null;
  const sizes = new Map(row.images.map((i) => [i.id, i.size as ImageSize]));
  const byMessage = new Map<string, ReturnType<typeof toAttachmentInfo>[]>();
  for (const a of await attachmentsForConversation(row.id)) byMessage.set(a.messageId!, [...(byMessage.get(a.messageId!) ?? []), toAttachmentInfo(a)]);
  return {
    ...toSummary(row),
    messages: row.messages.map((m) => ({ ...toMessage(m), imageSize: m.imageId ? (sizes.get(m.imageId) ?? "square") : null, attachments: byMessage.get(m.id) ?? [] })),
  };
}

export async function createConversation(userId: string, input: { model: string; projectId?: string | null; title?: string }) {
  return toSummary(
    await prisma.conversation.create({
      data: { userId, model: input.model, projectId: input.projectId ?? null, title: input.title ?? "New chat" },
    }),
  );
}

export async function updateConversation(
  userId: string,
  id: string,
  patch: { title?: string; pinned?: boolean; model?: string; projectId?: string | null },
) {
  const data: typeof patch = {};
  if (typeof patch.title === "string" && patch.title.trim()) data.title = patch.title.trim().slice(0, 200);
  if (typeof patch.pinned === "boolean") data.pinned = patch.pinned;
  if (typeof patch.model === "string") data.model = patch.model;
  if (patch.projectId !== undefined) data.projectId = patch.projectId;
  const { count } = await prisma.conversation.updateMany({ where: { id, userId }, data });
  if (count === 0) return null;
  return toSummary(await prisma.conversation.findFirstOrThrow({ where: { id, userId } }));
}

export async function deleteConversation(userId: string, id: string): Promise<boolean> {
  const files = await imageFilesWhere({ userId, conversationId: id });
  const attFiles = await attachmentFilesWhere({ userId, conversationId: id });
  const ok = (await prisma.conversation.deleteMany({ where: { id, userId } })).count > 0;
  if (ok) {
    await removeImageFiles(files);
    await removeAttachmentFiles(attFiles);
  }
  return ok;
}

export async function deleteAllConversations(userId: string) {
  const files = await imageFilesWhere({ userId });
  const attFiles = await attachmentFilesWhere({ userId });
  await prisma.conversation.deleteMany({ where: { userId } });
  await removeImageFiles(files);
  await removeAttachmentFiles(attFiles);
}

export async function duplicateConversation(userId: string, id: string): Promise<ConversationSummary | null> {
  const src = await getConversation(userId, id);
  if (!src) return null;
  const copy = await prisma.conversation.create({
    data: {
      userId,
      title: `${src.title} (copy)`.slice(0, 200),
      model: src.model,
      projectId: src.projectId,
      messages: {
        create: src.messages.map((m) => ({ role: m.role, content: m.content, thinking: m.thinking, model: m.model })), // generated images are not copied
      },
    },
  });
  return toSummary(copy);
}

export async function addMessage(input: {
  conversationId: string;
  role: Role;
  content: string;
  thinking?: string | null;
  model?: string | null;
  imageId?: string | null;
}) {
  const [msg] = await prisma.$transaction([
    prisma.message.create({ data: { ...input, thinking: input.thinking || null } }),
    prisma.conversation.update({ where: { id: input.conversationId }, data: { updatedAt: new Date() } }),
  ]);
  return toMessage(msg);
}

/** Delete `messageId` and everything after it (used by edit/regenerate). */
/** `preserve`: attachment ids to keep (an edited message keeps its files and re-links them to the new message). */
export async function truncateFrom(conversationId: string, messageId: string, preserve: string[] = []) {
  const target = await prisma.message.findFirst({ where: { id: messageId, conversationId } });
  if (!target) return;
  const doomed = await prisma.message.findMany({ where: { conversationId, createdAt: { gte: target.createdAt } }, select: { id: true, imageId: true } });
  const doomedAttachments = (await prisma.attachment.findMany({ where: { messageId: { in: doomed.map((m) => m.id) } }, select: { id: true } })).map((a) => a.id);
  const keep = new Set(preserve);
  if (keep.size) await prisma.attachment.updateMany({ where: { id: { in: [...keep] } }, data: { messageId: null } });
  const imageIds = doomed.map((m) => m.imageId).filter((id): id is string => Boolean(id));
  await prisma.message.deleteMany({ where: { conversationId, createdAt: { gte: target.createdAt } } });
  await deleteAttachments(doomedAttachments.filter((id) => !keep.has(id)));
  if (imageIds.length) {
    // Regenerating or editing drops the old images: remove the files as well as the rows.
    const files = (await prisma.image.findMany({ where: { id: { in: imageIds } }, select: { filepath: true } })).map((i) => i.filepath);
    await prisma.image.deleteMany({ where: { id: { in: imageIds } } });
    await removeImageFiles(files.filter((f) => f !== "pending"));
  }
}
