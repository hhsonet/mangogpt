"use client";
import { isValidElement, memo, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { CodeBlock } from "./CodeBlock";

function nodeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return nodeText(node.props.children);
  return "";
}

const components: Components = {
  pre({ children }) {
    const code = Array.isArray(children) ? children[0] : children;
    const props = isValidElement<{ className?: string; children?: ReactNode }>(code) ? code.props : {};
    const language = /language-([\w+-]+)/.exec(props.className ?? "")?.[1] ?? "";
    return (
      <CodeBlock language={language} text={nodeText(props.children).replace(/\n$/, "")}>
        {code}
      </CodeBlock>
    );
  },
  a({ href, children }) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer nofollow">
        {children}
      </a>
    );
  },
};

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }], rehypeKatex]}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
