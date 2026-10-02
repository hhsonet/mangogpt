import { discardPending, readAttachment } from "@/services/attachments";
import { authed, json, notFound } from "../../_lib";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Owner-only download. Images are shown inline; everything else is forced to download and never rendered. */
export async function GET(_req: Request, { params }: Ctx) {
  const a = await authed();
  if (!a.ok) return a.res;
  const file = await readAttachment(a.user.id, (await params).id);
  if (!file) return notFound("File not found");
  const isImage = file.row.kind === "image";
  const encoded = encodeURIComponent(file.row.filename);
  return new Response(new Uint8Array(file.data), {
    headers: {
      "Content-Type": isImage ? file.row.mimeType : "application/octet-stream",
      "Content-Disposition": `${isImage ? "inline" : "attachment"}; filename*=UTF-8''${encoded}`,
      "Content-Security-Policy": "sandbox; default-src 'none'",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, max-age=3600",
    },
  });
}

/** Remove an upload that hasn't been sent yet. */
export async function DELETE(_req: Request, { params }: Ctx) {
  const a = await authed();
  if (!a.ok) return a.res;
  return (await discardPending(a.user.id, (await params).id)) ? json({ ok: true }) : notFound("File not found");
}
