"use client";
import { useEffect, useRef, useState } from "react";
import { applyCarriageReturns, parseAnsi } from "@/lib/lab/ansi";
import { textOf } from "@/lib/lab/notebook";
import type { NbOutput } from "@/lib/lab/types";
import { LabMarkdown } from "./LabMarkdown";

const MAX_CHARS = 100_000;

function Ansi({ text }: { text: string }) {
  return (
    <>
      {parseAnsi(applyCarriageReturns(text)).map((s, i) => (
        <span key={i} style={{ color: s.fg, backgroundColor: s.bg, fontWeight: s.bold ? 600 : undefined, fontStyle: s.italic ? "italic" : undefined, textDecoration: s.underline ? "underline" : undefined }}>
          {s.text}
        </span>
      ))}
    </>
  );
}

function Pre({ text, tone }: { text: string; tone?: "error" | "stderr" }) {
  const [all, setAll] = useState(false);
  const long = text.length > MAX_CHARS;
  // Long output shows its end (what a running job just printed), with the rest one click away.
  const shown = all || !long ? text : text.slice(text.length - MAX_CHARS);
  return (
    <div className={tone === "error" ? "rounded bg-danger/5 p-2" : tone === "stderr" ? "rounded bg-amber-500/10 p-2" : undefined}>
      {long && !all && (
        <button onClick={() => setAll(true)} className="mb-1 cursor-pointer text-xs text-accent hover:underline">
          Showing the last {Math.round(MAX_CHARS / 1000)}k of {Math.round(text.length / 1000)}k characters. Show everything
        </button>
      )}
      <pre className="m-0 max-h-[40rem] overflow-auto whitespace-pre-wrap break-words font-mono text-[0.8rem] leading-relaxed">
        <Ansi text={shown} />
      </pre>
    </div>
  );
}

/**
 * HTML output (pandas tables, plotly, ...) runs in a sandboxed frame: scripts may run, but the frame gets a unique
 * origin, so it can never read our cookies or page, and it cannot navigate or open anything. Its height is reported
 * back with postMessage and only accepted from this frame.
 */
function HtmlFrame({ html }: { html: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(60);
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.source !== ref.current?.contentWindow) return;
      const h = Number((e.data as { mangoHeight?: number })?.mangoHeight);
      if (Number.isFinite(h)) setHeight(Math.min(Math.max(Math.ceil(h), 20), 1200));
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);
  const doc = `<!doctype html><meta charset="utf-8"><style>body{margin:0;font:13px system-ui,sans-serif;color:#222;background:#fff;padding:4px}table{border-collapse:collapse}td,th{border:1px solid #ddd;padding:2px 8px;text-align:right}th{background:#f5f5f5}</style>${html}<script>new ResizeObserver(function(){parent.postMessage({mangoHeight:document.documentElement.scrollHeight},"*")}).observe(document.documentElement)</script>`;
  return <iframe ref={ref} title="Notebook output" sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={doc} style={{ height }} className="w-full rounded border border-border bg-white" />;
}

function DisplayData({ data, projectId, dir }: { data: Record<string, unknown>; projectId: string; dir: string }) {
  if (typeof data["image/png"] === "string" || typeof data["image/jpeg"] === "string" || typeof data["image/gif"] === "string") {
    const mime = data["image/png"] ? "image/png" : data["image/jpeg"] ? "image/jpeg" : "image/gif";
    // eslint-disable-next-line @next/next/no-img-element -- notebook-embedded image (data URI)
    return <img src={`data:${mime};base64,${textOf(data[mime]).replace(/\s/g, "")}`} alt="Notebook output" className="max-w-full rounded bg-white" />;
  }
  if (data["image/svg+xml"]) {
    // As an <img>, an SVG cannot run scripts.
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(textOf(data["image/svg+xml"]))}`} alt="Notebook output" className="max-w-full rounded bg-white" />;
  }
  if (data["text/html"]) return <HtmlFrame html={textOf(data["text/html"])} />;
  if (data["application/vnd.jupyter.widget-view+json"]) return <p className="text-xs text-muted">Interactive widgets aren’t supported yet.</p>;
  if (data["text/markdown"]) return <LabMarkdown text={textOf(data["text/markdown"])} projectId={projectId} dir={dir} />;
  if (data["application/json"]) return <Pre text={JSON.stringify(data["application/json"], null, 2)} />;
  if (data["text/plain"] !== undefined) return <Pre text={textOf(data["text/plain"])} />;
  return <p className="text-xs text-muted">Output type not shown ({Object.keys(data).join(", ") || "empty"}).</p>;
}

export function OutputView({ outputs, projectId, dir }: { outputs: NbOutput[]; projectId: string; dir: string }) {
  if (!outputs.length) return null;
  return (
    <div className="space-y-2 border-t border-border bg-bg/40 px-3 py-2" aria-label="Cell output">
      {outputs.map((o, i) => {
        switch (o.output_type) {
          case "stream":
            return <Pre key={i} text={textOf(o.text)} tone={o.name === "stderr" ? "stderr" : undefined} />;
          case "error":
            return <Pre key={i} tone="error" text={Array.isArray(o.traceback) && o.traceback.length ? o.traceback.join("\n") : `${textOf(o.ename)}: ${textOf(o.evalue)}`} />;
          case "display_data":
          case "execute_result":
            return <DisplayData key={i} data={(o.data as Record<string, unknown>) ?? {}} projectId={projectId} dir={dir} />;
          default:
            return null;
        }
      })}
    </div>
  );
}
