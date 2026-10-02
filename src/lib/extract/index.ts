import "server-only";

export type AttachmentKind = "image" | "text" | "document";

export interface Inspected {
  kind: AttachmentKind;
  mimeType: string;
  /** Extension taken from our own whitelist, never from the user's filename. */
  ext: string;
}

export const MAX_EXTRACTED_CHARS = 400_000;

const IMAGE_TYPES: Record<string, { mime: string; magic: (b: Buffer) => boolean }> = {
  png: { mime: "image/png", magic: (b) => b.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])) },
  jpg: { mime: "image/jpeg", magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  jpeg: { mime: "image/jpeg", magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  gif: { mime: "image/gif", magic: (b) => b.subarray(0, 4).toString("latin1") === "GIF8" },
  webp: { mime: "image/webp", magic: (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP" },
};

const TEXT_EXTS = new Set(
  ("txt md markdown rst csv tsv json jsonl xml yaml yml toml ini cfg conf env log tex bib " +
    "html htm css scss sass less js mjs cjs jsx ts tsx vue svelte py ipynb rb php java kt kts scala c h cc cpp cxx hpp cs go rs swift m mm " +
    "sh bash zsh fish ps1 bat sql r jl lua pl pm dart ex exs erl hs clj ml fs vb asm gradle make cmake proto graphql tf dockerfile")
    .split(" "),
);
const TEXT_NAMES = new Set(["dockerfile", "makefile", "readme", "license", "gemfile", "procfile"]);

export const SUPPORTED_HELP = "Use a PDF, Word (.docx), text or code file, or an image (PNG, JPEG, WebP or GIF).";

export class AttachmentError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

/** Strip any path, control characters and shell/HTML-hostile characters; keep it short. */
export function sanitizeFilename(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[\u0000-\u001f\u007f<>:"|?*‮]/g, "").replace(/\s+/g, " ").replace(/^\.+/, "").trim();
  if (!cleaned) return "file";
  if (cleaned.length <= 120) return cleaned;
  const dot = cleaned.lastIndexOf(".");
  const ext = dot > 0 && cleaned.length - dot <= 10 ? cleaned.slice(dot) : "";
  return cleaned.slice(0, 120 - ext.length) + ext;
}

/** Decide what a file really is from its bytes plus a whitelisted extension. Throws AttachmentError if unsupported. */
export function inspectFile(filename: string, data: Buffer): Inspected {
  const name = filename.toLowerCase();
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot + 1) : "";

  if (IMAGE_TYPES[ext]) {
    if (!IMAGE_TYPES[ext].magic(data)) throw new AttachmentError(`“${filename}” isn't a valid ${ext.toUpperCase()} image.`);
    return { kind: "image", mimeType: IMAGE_TYPES[ext].mime, ext: ext === "jpeg" ? "jpg" : ext };
  }
  if (ext === "pdf") {
    if (data.subarray(0, 5).toString("latin1") !== "%PDF-") throw new AttachmentError(`“${filename}” isn't a valid PDF.`);
    return { kind: "document", mimeType: "application/pdf", ext: "pdf" };
  }
  if (ext === "docx") {
    if (!data.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) throw new AttachmentError(`“${filename}” isn't a valid Word (.docx) file.`);
    return { kind: "document", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ext: "docx" };
  }
  if (TEXT_EXTS.has(ext) || (!ext && TEXT_NAMES.has(name))) {
    if (data.subarray(0, 8192).includes(0)) throw new AttachmentError(`“${filename}” looks like a binary file, not text.`);
    return { kind: "text", mimeType: "text/plain", ext: "txt" };
  }
  throw new AttachmentError(`“${filename}” isn't a supported file type. ${SUPPORTED_HELP}`, 415);
}

const withTimeout = <T>(p: Promise<T>, ms: number, msg: string) =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new AttachmentError(msg, 422)), ms))]);

/** Extract plain text for the model. Images return null. */
export async function extractText(kind: AttachmentKind, ext: string, filename: string, data: Buffer): Promise<string | null> {
  if (kind === "image") return null;
  let text: string;
  try {
    if (kind === "text") {
      text = new TextDecoder("utf-8", { fatal: true }).decode(data);
    } else if (ext === "pdf") {
      const { extractText: pdfText, getDocumentProxy } = await import("unpdf");
      const result = await withTimeout(
        (async () => pdfText(await getDocumentProxy(new Uint8Array(data)), { mergePages: true }))(),
        45_000,
        `“${filename}” took too long to read. Try a smaller file.`,
      );
      text = Array.isArray(result.text) ? result.text.join("\n\n") : result.text;
    } else {
      const mammoth = await import("mammoth");
      text = (await withTimeout(mammoth.extractRawText({ buffer: data }), 30_000, `“${filename}” took too long to read.`)).value;
    }
  } catch (err) {
    if (err instanceof AttachmentError) throw err;
    if (kind === "text") throw new AttachmentError(`“${filename}” isn't UTF-8 text. Save it as UTF-8 and try again.`, 422);
    console.error("[extract]", err);
    throw new AttachmentError(`Couldn't read “${filename}”. The file may be damaged or password-protected.`, 422);
  }
  text = text.replace(/\r\n/g, "\n").replace(/\u0000/g, "").replace(/\n{4,}/g, "\n\n\n").trim();
  if (!text) {
    throw new AttachmentError(
      kind === "document" && ext === "pdf" ? `No readable text in “${filename}”. It may be a scan; attach its pages as images instead.` : `“${filename}” has no text in it.`,
      422,
    );
  }
  return text.length > MAX_EXTRACTED_CHARS ? `${text.slice(0, MAX_EXTRACTED_CHARS)}\n[…file truncated at ${MAX_EXTRACTED_CHARS.toLocaleString()} characters]` : text;
}
