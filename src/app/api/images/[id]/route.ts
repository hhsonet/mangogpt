import { readImage } from "@/services/images";
import { authed, notFound } from "../../_lib";

export const dynamic = "force-dynamic";

/** Images are private: served only to the signed-in owner. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const a = await authed();
  if (!a.ok) return a.res;
  const bytes = await readImage(a.user.id, (await params).id);
  if (!bytes) return notFound("Image not found");
  return new Response(new Uint8Array(bytes), {
    headers: { "Content-Type": "image/png", "Cache-Control": "private, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff" },
  });
}
