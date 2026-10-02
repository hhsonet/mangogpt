import { chatOnce } from "@/lib/ollama/client";
import { getConversation, updateConversation } from "@/services/conversations";
import { authed, json, notFound } from "../../../_lib";

/** Ask the model for a short title. Falls back silently to the existing title. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const a = await authed();
  if (!a.ok) return a.res;
  const conv = await getConversation(a.user.id, (await params).id);
  if (!conv) return notFound("Conversation not found");
  const first = conv.messages.find((m) => m.role === "user");
  const reply = conv.messages.find((m) => m.role === "assistant");
  if (!first) return json(conv);
  try {
    const raw = await chatOnce({
      model: conv.model,
      options: { temperature: 0.2, numCtx: 2048 },
      messages: [
        { role: "system", content: "Write a concise title (max 6 words) for this conversation. Reply with the title only: no quotes, no punctuation at the end." },
        { role: "user", content: `User: ${first.content.slice(0, 600)}\n\nAssistant: ${(reply?.content ?? "").slice(0, 600)}` },
      ],
    });
    const title = raw.split("\n")[0]?.replace(/^["'`#*\s]+|["'`.*\s]+$/g, "").slice(0, 80);
    if (title) return json(await updateConversation(a.user.id, conv.id, { title }));
  } catch {
    /* keep fallback title */
  }
  return json(conv);
}
