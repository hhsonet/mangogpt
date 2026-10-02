"use client";
import { FileImage, FileText, Loader2, X } from "lucide-react";
import { formatBytes } from "@/lib/utils/format";
import type { PendingAttachment } from "@/hooks/useAttachments";
import type { AttachmentMeta } from "@/types";
import { cn } from "@/lib/utils/cn";

/** Files waiting in the composer (uploading / ready / failed). */
export function PendingChips({ items, onRemove }: { items: PendingAttachment[]; onRemove: (key: string) => void }) {
  if (items.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-2 px-1 pb-2" aria-label="Attached files">
      {items.map((it) => (
        <li
          key={it.key}
          className={cn(
            "flex max-w-full items-center gap-2 rounded-lg border bg-bg py-1 pl-1.5 pr-1 text-xs",
            it.status === "error" ? "border-danger/50" : "border-border",
          )}
          title={it.error ?? it.name}
        >
          {it.isImage && it.previewUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- local blob preview
            <img src={it.previewUrl} alt="" className="h-8 w-8 rounded object-cover" />
          ) : (
            <span className="flex h-8 w-8 items-center justify-center rounded bg-surface-2 text-muted">
              <FileText size={15} />
            </span>
          )}
          <span className="min-w-0">
            <span className="block max-w-[10rem] truncate font-medium sm:max-w-[14rem]">{it.name}</span>
            <span className={cn("block", it.status === "error" ? "text-danger" : "text-muted")}>
              {it.status === "uploading" ? "Uploading…" : it.status === "error" ? it.error : formatBytes(it.size)}
            </span>
          </span>
          {it.status === "uploading" ? (
            <Loader2 size={14} className="mx-1 animate-spin text-muted" />
          ) : (
            <button onClick={() => onRemove(it.key)} aria-label={`Remove ${it.name}`} className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-muted hover:bg-surface-2 hover:text-fg">
              <X size={14} />
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Files that were sent with a message. Images show as thumbnails; documents download. */
export function SentAttachments({ items }: { items: AttachmentMeta[] }) {
  if (items.length === 0) return null;
  const images = items.filter((a) => a.kind === "image");
  const files = items.filter((a) => a.kind !== "image");
  return (
    <div className="flex max-w-[85%] flex-wrap justify-end gap-2">
      {images.map((a) => (
        <a key={a.id} href={`/api/attachments/${a.id}`} target="_blank" rel="noopener noreferrer" title={a.filename}>
          {/* eslint-disable-next-line @next/next/no-img-element -- private, authenticated image */}
          <img src={`/api/attachments/${a.id}`} alt={a.filename} loading="lazy" className="max-h-44 max-w-[16rem] rounded-xl border border-border object-cover" />
        </a>
      ))}
      {files.map((a) => (
        <a
          key={a.id}
          href={`/api/attachments/${a.id}`}
          download={a.filename}
          className="flex items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2 text-xs hover:bg-surface-2"
          title={`Download ${a.filename}`}
        >
          {a.kind === "document" ? <FileText size={16} className="text-muted" /> : <FileImage size={16} className="text-muted" />}
          <span className="min-w-0">
            <span className="block max-w-[14rem] truncate font-medium">{a.filename}</span>
            <span className="block text-muted">{formatBytes(a.size)}</span>
          </span>
        </a>
      ))}
    </div>
  );
}
