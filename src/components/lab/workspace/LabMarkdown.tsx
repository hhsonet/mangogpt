"use client";
import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { filesApi } from "@/lib/lab/api";

/**
 * Markdown for notebook cells. Notebooks can come from anywhere, so:
 *  - remote images are NOT loaded (they could track the reader); the project's own images and data: images are
 *  - links open in a new tab without giving the page access to ours
 *  - raw HTML in Markdown is not rendered (react-markdown's default)
 */
export const LabMarkdown = memo(function LabMarkdown({ text, projectId, dir }: { text: string; projectId: string; dir: string }) {
  const components: Components = {
    img({ src, alt }) {
      const s = typeof src === "string" ? src : "";
      if (s.startsWith("data:image/") && !s.startsWith("data:image/svg")) {
        // eslint-disable-next-line @next/next/no-img-element -- notebook-embedded image
        return <img src={s} alt={alt ?? ""} className="max-w-full" />;
      }
      if (/^[a-z][a-z0-9+.-]*:/i.test(s) || s.startsWith("//") || s.startsWith("/")) {
        return <span className="rounded border border-border px-1.5 py-0.5 text-xs text-muted">External image blocked{alt ? `: ${alt}` : ""}</span>;
      }
      const parts = [...dir.split("/").filter(Boolean)];
      for (const seg of s.split("/")) seg === ".." ? parts.pop() : seg !== "." && seg !== "" && parts.push(decodeURIComponent(seg));
      // eslint-disable-next-line @next/next/no-img-element -- served from this project's workspace
      return <img src={filesApi.downloadUrl(projectId, parts.join("/"), true)} alt={alt ?? ""} className="max-w-full" />;
    },
    a({ href, children }) {
      return (
        <a href={href} target="_blank" rel="noopener noreferrer nofollow">
          {children}
        </a>
      );
    },
  };
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }], rehypeKatex]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
