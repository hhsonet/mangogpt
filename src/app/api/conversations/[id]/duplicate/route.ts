import { duplicateConversation } from "@/services/conversations";
import { authed, json, notFound } from "../../../_lib";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const a = await authed();
  if (!a.ok) return a.res;
  const copy = await duplicateConversation(a.user.id, (await params).id);
  return copy ? json(copy, 201) : notFound("Conversation not found");
}
