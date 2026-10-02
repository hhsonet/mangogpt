import { deleteConversation, getConversation, updateConversation } from "@/services/conversations";
import { authed, errorResponse, json, notFound, readJson } from "../../_lib";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const a = await authed();
  if (!a.ok) return a.res;
  const conv = await getConversation(a.user.id, (await params).id);
  return conv ? json(conv) : notFound("Conversation not found");
}

export async function PATCH(req: Request, { params }: Ctx) {
  const a = await authed();
  if (!a.ok) return a.res;
  const body = await readJson<{ title?: string; pinned?: boolean; model?: string; projectId?: string | null }>(req);
  if (!body) return json({ code: "bad_request", message: "Invalid JSON" }, 400);
  try {
    const updated = await updateConversation(a.user.id, (await params).id, body);
    return updated ? json(updated) : notFound("Conversation not found");
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const a = await authed();
  if (!a.ok) return a.res;
  try {
    return (await deleteConversation(a.user.id, (await params).id)) ? json({ ok: true }) : notFound("Conversation not found");
  } catch (err) {
    return errorResponse(err);
  }
}
