import { AttachmentError, SUPPORTED_HELP } from "@/lib/extract";
import { MAX_FILE_BYTES, saveUpload, sweepStalePending } from "@/services/attachments";
import { logEvent } from "@/services/usage";
import { authed, json } from "../_lib";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** Upload one file (multipart field "file"). Returns its metadata; link it by sending its id with a chat message. */
export async function POST(req: Request) {
  const a = await authed();
  if (!a.ok) return a.res;

  // Refuse oversized bodies before buffering them.
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_FILE_BYTES + 1024 * 1024) {
    return json({ code: "attachment_error", message: `That file is too large. The limit is ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB.` }, 413);
  }
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json({ code: "attachment_error", message: "The upload was interrupted. Please try again." }, 400);
  }
  const file = form.get("file");
  if (!(file instanceof File)) return json({ code: "attachment_error", message: `No file received. ${SUPPORTED_HELP}` }, 400);

  try {
    void sweepStalePending().catch(() => undefined);
    const saved = await saveUpload(a.user.id, file);
    logEvent({ type: "upload", userId: a.user.id, username: a.user.username, bytes: saved.size, detail: saved.kind });
    return json(saved, 201);
  } catch (err) {
    if (err instanceof AttachmentError) logEvent({ type: "upload", status: "error", userId: a.user.id, username: a.user.username, detail: err.message.slice(0, 120) });
    if (err instanceof AttachmentError) return json({ code: "attachment_error", message: err.message }, err.status);
    console.error("[upload]", err);
    return json({ code: "attachment_error", message: "Couldn't save that file. Please try again." }, 500);
  }
}
