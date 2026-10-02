"use client";
import { ArrowUp, Brain, ImageIcon, Paperclip, Square, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils/cn";
import { useModels } from "@/hooks/api";
import { MAX_ATTACHMENTS, useAttachments } from "@/hooks/useAttachments";
import type { AttachmentMeta, ImageSize } from "@/types";
import { PendingChips } from "./Attachments";
import { ModelSelector } from "./ModelSelector";

interface Props {
  model: string;
  onModelChange: (m: string) => void;
  think: boolean;
  onThinkChange: (v: boolean) => void;
  generating: boolean;
  disabled?: boolean;
  onSend: (text: string, attachments: AttachmentMeta[]) => void;
  /** Context length in tokens, used to warn when attached text won't fit. */
  numCtx: number;
  onStop: () => void;
  imageAvailable: boolean;
  onGenerateImage: (prompt: string, size: ImageSize) => void;
}

const SIZES: { value: ImageSize; label: string }[] = [
  { value: "square", label: "Square" },
  { value: "portrait", label: "Portrait" },
  { value: "landscape", label: "Landscape" },
];

export function Composer({ model, onModelChange, think, onThinkChange, generating, disabled, onSend, numCtx, onStop, imageAvailable, onGenerateImage }: Props) {
  const [text, setText] = useState("");
  const [imageMode, setImageMode] = useState(false);
  const [size, setSize] = useState<ImageSize>("square");
  const imaging = imageMode && imageAvailable;
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const files = useAttachments();
  const { models } = useModels();
  const [dragging, setDragging] = useState(false);
  const visionOk = models.find((m) => m.name === model)?.vision ?? true;
  const tooLong = files.tokens > numCtx * 0.5;

  // Auto-grow up to ~40% of the viewport.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, window.innerHeight * 0.4)}px`;
  }, [text]);

  const canSend = text.trim().length > 0 && !generating && !disabled && !files.uploading && (imaging || Boolean(model));

  const submit = () => {
    if (!canSend) return;
    if (imaging) onGenerateImage(text.trim(), size);
    else {
      onSend(text.trim(), files.metas);
      files.clear();
    }
    setText("");
  };

  return (
    <div className="mx-auto w-full max-w-3xl px-3 pb-3 sm:px-4">
      <div
        className={cn("relative rounded-2xl border bg-surface p-2 shadow-sm focus-within:border-accent/60", dragging ? "border-accent" : "border-border")}
        onDragOver={(e) => {
          if (imaging) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
        }}
        onDrop={(e) => {
          if (imaging) return;
          e.preventDefault();
          setDragging(false);
          files.add(Array.from(e.dataTransfer.files));
        }}
      >
        {dragging && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-2xl bg-bg/80 text-sm font-medium text-accent">
            Drop files to attach
          </div>
        )}
        {!imaging && <PendingChips items={files.items} onRemove={files.remove} />}
        {!imaging && (files.notice || (files.hasImage && !visionOk) || tooLong) && (
          <p role="status" className="px-1 pb-2 text-xs text-amber-600 dark:text-amber-400">
            {files.notice ||
              (files.hasImage && !visionOk
                ? `${model} can't read images. Switch to a vision model (marked "vision") or remove the image.`
                : "This is a long file, so only part of it may fit. You can raise Context length in Settings.")}
          </p>
        )}
        <textarea
          id="composer-input"
          ref={ref}
          value={text}
          rows={1}
          autoFocus
          placeholder={imaging ? "Describe the image you want…" : files.items.length ? "Ask about the attached files…" : "Ask anything…"}
          aria-label="Message"
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            const pasted = Array.from(e.clipboardData.files);
            if (!imaging && pasted.length) {
              e.preventDefault();
              files.add(pasted);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          className="block max-h-[40vh] w-full resize-none bg-transparent px-2 py-1.5 text-base outline-none placeholder:text-muted"
        />
        <div className="flex items-center justify-between gap-2 pt-1">
          <div className="flex min-w-0 items-center gap-1">
            {!imaging && (
              <>
                <input
                  ref={fileInput}
                  type="file"
                  multiple
                  hidden
                  onChange={(e) => {
                    files.add(Array.from(e.target.files ?? []));
                    e.target.value = "";
                  }}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  title={`Attach files (up to ${MAX_ATTACHMENTS}): PDF, Word, text, code or images`}
                  aria-label="Attach files"
                  disabled={generating}
                  onClick={() => fileInput.current?.click()}
                  className="text-muted"
                >
                  <Paperclip size={16} />
                </Button>
              </>
            )}
            {imageAvailable && (
              <Button
                variant="ghost"
                size="sm"
                aria-pressed={imaging}
                title={imaging ? "Image mode on. Click to chat instead." : "Create an image instead of chatting"}
                aria-label="Toggle image mode"
                onClick={() => setImageMode((v) => !v)}
                className={cn("gap-1.5", imaging ? "bg-accent/15 text-accent" : "text-muted")}
              >
                <ImageIcon size={15} /> {imaging ? "Image" : <span className="max-sm:hidden">Image</span>}
              </Button>
            )}
            {imaging ? (
              <div role="radiogroup" aria-label="Image shape" className="ml-1 inline-flex rounded-md border border-border p-0.5">
                {SIZES.map((s) => (
                  <button
                    key={s.value}
                    role="radio"
                    aria-checked={size === s.value}
                    onClick={() => setSize(s.value)}
                    className={cn("cursor-pointer rounded px-2 py-0.5 text-xs", size === s.value ? "bg-surface-2 font-medium" : "text-muted hover:text-fg")}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            ) : (
              <>
            <ModelSelector value={model} onChange={onModelChange} disabled={generating} />
            <Button
              variant="ghost"
              size="icon"
              aria-pressed={think}
              title={think ? "Reasoning on (model default). Click to turn off for faster answers." : "Reasoning off"}
              aria-label="Toggle reasoning"
              onClick={() => onThinkChange(!think)}
              className={cn(think ? "text-accent" : "text-muted")}
            >
              <Brain size={16} />
            </Button>
              </>
            )}
            {text && !generating && (
              <Button variant="ghost" size="icon" className="text-muted" title="Clear" aria-label="Clear message" onClick={() => setText("")}>
                <X size={15} />
              </Button>
            )}
          </div>
          {generating ? (
            <Button variant="primary" size="icon" onClick={onStop} aria-label="Stop generation" title="Stop (Esc)" className="rounded-full">
              <Square size={13} fill="currentColor" />
            </Button>
          ) : (
            <Button variant="primary" size="icon" onClick={submit} disabled={!canSend} aria-label="Send" title="Send (Enter)" className="rounded-full">
              <ArrowUp size={16} />
            </Button>
          )}
        </div>
      </div>
      <p className="mt-1.5 hidden text-center text-xs text-muted sm:block">
        Enter to send · Shift+Enter for new line · Ctrl+K search · Ctrl+/ focus
      </p>
    </div>
  );
}
