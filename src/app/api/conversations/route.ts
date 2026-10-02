import { createConversation, deleteAllConversations, listConversations } from "@/services/conversations";
import { getSettings } from "@/services/settings";
import { authed, errorResponse, json, readJson } from "../_lib";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const a = await authed();
  if (!a.ok) return a.res;
  const q = new URL(req.url).searchParams.get("q") ?? undefined;
  try {
    return json({ conversations: await listConversations(a.user.id, q) });
  } catch (err) {
    // The database cancels queries that run too long (statement_timeout) so one slow search can't hog it.
    if (String((err as Error)?.message).toLowerCase().includes("statement timeout")) {
      return json({ code: "search_timeout", message: "That search took too long. Try a more specific word." }, 503);
    }
    return errorResponse(err);
  }
}

export async function POST(req: Request) {
  const a = await authed();
  if (!a.ok) return a.res;
  const body = await readJson<{ model?: string; projectId?: string | null }>(req);
  try {
    const model = body?.model || (await getSettings(a.user.id)).defaultModel;
    if (!model) return json({ code: "bad_request", message: "No model selected." }, 400);
    return json(await createConversation(a.user.id, { model, projectId: body?.projectId }), 201);
  } catch (err) {
    return errorResponse(err);
  }
}

// Used by Settings > Data > Delete all conversations. Requires explicit confirmation.
export async function DELETE(req: Request) {
  const a = await authed();
  if (!a.ok) return a.res;
  if (new URL(req.url).searchParams.get("confirm") !== "yes") {
    return json({ code: "bad_request", message: "Missing confirm=yes" }, 400);
  }
  await deleteAllConversations(a.user.id);
  return json({ ok: true });
}
