"use client";
import { ArrowRight, Download, Pencil, RefreshCw } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { ChatMessage } from "@/types";
import { SentAttachments } from "./Attachments";
import { CopyButton } from "./CopyButton";
import { Markdown } from "./Markdown";
import { ThinkingBlock } from "./ThinkingBlock";

interface Props {
  message: ChatMessage;
  isLast: boolean;
  disabled: boolean;
  onEdit: (id: string, content: string) => void;
  onRegenerate: (id: string) => void;
  onContinue: () => void;
}

export function MessageItem({ message, isLast, disabled, onEdit, onRegenerate, onContinue }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);

  if (message.role === "user") {
    return (
      <div className="group msg flex flex-col items-end gap-1 py-3">
        <SentAttachments items={message.attachments ?? []} />
        {editing ? (
          <div className="w-full max-w-[85%] rounded-xl border border-border bg-surface p-2">
            <textarea
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={Math.min(10, draft.split("\n").length + 1)}
              className="w-full resize-none bg-transparent p-1 text-[0.95rem] outline-none"
              onKeyDown={(e) => {
                if (e.key === "Escape") setEditing(false);
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  if (draft.trim()) {
                    setEditing(false);
                    onEdit(message.id, draft.trim());
                  }
                }
              }}
            />
            <div className="mt-1 flex justify-end gap-2">
              <Button size="sm" variant="outline" onClick={() => setEditing(false)}>
                Cancel
              </Button>
              <Button
                size="sm"
                variant="primary"
                disabled={!draft.trim()}
                onClick={() => {
                  setEditing(false);
                  onEdit(message.id, draft.trim());
                }}
              >
                Save &amp; regenerate
              </Button>
            </div>
          </div>
        ) : (
          <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl bg-[var(--user-bubble)] px-4 py-2.5 text-[0.95rem] leading-relaxed">
            {message.content}
          </div>
        )}
        {!editing && (
          <div className="flex gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 max-md:opacity-100">
            <Button
              variant="ghost"
              size="icon"
              className="text-muted"
              title="Edit"
              aria-label="Edit message"
              disabled={disabled}
              onClick={() => {
                setDraft(message.content);
                setEditing(true);
              }}
            >
              <Pencil size={15} />
            </Button>
            <CopyButton text={message.content} />
          </div>
        )}
      </div>
    );
  }

  if (message.imageId) {
    const prompt = message.content.replace(/^Generated image: /, "");
    return (
      <div className="group msg py-3">
        <figure className="inline-block max-w-full">
          <a href={`/api/images/${message.imageId}`} target="_blank" rel="noopener noreferrer" title="Open full size">
            {/* eslint-disable-next-line @next/next/no-img-element -- private, authenticated PNG */}
            <img
              src={`/api/images/${message.imageId}`}
              alt={prompt}
              loading="lazy"
              className="max-h-[70vh] max-w-full rounded-xl border border-border"
              width={message.imageSize === "landscape" ? 768 : 512}
              height={message.imageSize === "portrait" ? 768 : 512}
            />
          </a>
          <figcaption className="mt-1.5 max-w-prose text-xs text-muted">{prompt}</figcaption>
        </figure>
        <div className="mt-1 flex items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 max-md:opacity-100">
          <a
            href={`/api/images/${message.imageId}`}
            download={`image-${message.imageId.slice(-6)}.png`}
            title="Download"
            aria-label="Download image"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-surface-2"
          >
            <Download size={15} />
          </a>
          <CopyButton text={prompt} label="Copy prompt" />
          {isLast && (
            <Button variant="ghost" size="icon" className="text-muted" title="New variation" aria-label="Generate a new variation" disabled={disabled} onClick={() => onRegenerate(message.id)}>
              <RefreshCw size={15} />
            </Button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="group msg py-3">
      {message.thinking && <ThinkingBlock text={message.thinking} />}
      <Markdown text={message.content} />
      <div className="mt-1 flex items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 max-md:opacity-100">
        <CopyButton text={message.content} label="Copy response" />
        {isLast && (
          <>
            <Button variant="ghost" size="icon" className="text-muted" title="Regenerate" aria-label="Regenerate response" disabled={disabled} onClick={() => onRegenerate(message.id)}>
              <RefreshCw size={15} />
            </Button>
            <Button variant="ghost" size="icon" className="text-muted" title="Continue" aria-label="Continue response" disabled={disabled} onClick={onContinue}>
              <ArrowRight size={15} />
            </Button>
          </>
        )}
        {message.model && <span className="ml-2 text-xs text-muted">{message.model}</span>}
      </div>
    </div>
  );
}
