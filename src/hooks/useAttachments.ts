"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AttachmentMeta } from "@/types";

export interface PendingAttachment {
  key: string;
  name: string;
  size: number;
  isImage: boolean;
  previewUrl?: string;
  status: "uploading" | "ready" | "error";
  error?: string;
  meta?: AttachmentMeta;
}

export const MAX_ATTACHMENTS = 5;

async function upload(file: File): Promise<AttachmentMeta> {
  const form = new FormData();
  form.append("file", file);
  let res: Response;
  try {
    res = await fetch("/api/attachments", { method: "POST", body: form });
  } catch {
    throw new Error("Upload failed. Check your connection and try again.");
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.message ?? `Upload failed (${res.status}).`);
  return data as AttachmentMeta;
}

/** Tracks files being attached to the next message: uploads immediately, lets the user remove them. */
export function useAttachments() {
  const [items, setItems] = useState<PendingAttachment[]>([]);
  const [notice, setNotice] = useState("");
  const itemsRef = useRef(items);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  const revoke = (it: PendingAttachment) => it.previewUrl && URL.revokeObjectURL(it.previewUrl);
  useEffect(() => () => itemsRef.current.forEach(revoke), []);

  const add = useCallback((files: File[]) => {
    setNotice("");
    const room = MAX_ATTACHMENTS - itemsRef.current.filter((i) => i.status !== "error").length;
    if (files.length > room) setNotice(`You can attach up to ${MAX_ATTACHMENTS} files per message.`);
    for (const file of files.slice(0, Math.max(0, room))) {
      const key = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const isImage = file.type.startsWith("image/");
      setItems((prev) => [...prev, { key, name: file.name, size: file.size, isImage, previewUrl: isImage ? URL.createObjectURL(file) : undefined, status: "uploading" }]);
      upload(file)
        .then((meta) => setItems((prev) => prev.map((i) => (i.key === key ? { ...i, status: "ready", meta } : i))))
        .catch((err: Error) => setItems((prev) => prev.map((i) => (i.key === key ? { ...i, status: "error", error: err.message } : i))));
    }
  }, []);

  const remove = useCallback((key: string) => {
    const it = itemsRef.current.find((i) => i.key === key);
    if (!it) return;
    revoke(it);
    setItems((prev) => prev.filter((i) => i.key !== key));
    if (it.meta) void fetch(`/api/attachments/${it.meta.id}`, { method: "DELETE" }).catch(() => undefined);
  }, []);

  /** After a successful send the server owns the files; just forget them here. */
  const clear = useCallback(() => {
    itemsRef.current.forEach(revoke);
    setItems([]);
    setNotice("");
  }, []);

  const ready = items.filter((i) => i.status === "ready" && i.meta);
  return {
    items,
    notice,
    add,
    remove,
    clear,
    uploading: items.some((i) => i.status === "uploading"),
    metas: ready.map((i) => i.meta!),
    tokens: ready.reduce((n, i) => n + (i.meta?.tokens ?? 0), 0),
    hasImage: ready.some((i) => i.meta?.kind === "image"),
  };
}
