// MarkdownView: renders markdown with GFM tables + syntax highlighting.
// Code blocks get a copy button; streaming phase uses plain <pre> instead
// (see ResultView) to avoid re-parsing cost per token.
import { memo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

/** Copy text to clipboard, supporting both browser and Tauri envs. */
async function copyText(text: string): Promise<void> {
  if (navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      /* fall through to Tauri */
    }
  }
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("set_clipboard_text", { text });
  }
}

/** Flatten React children to plain text (for the copy button).
 *  rehype-highlight turns code into <span class="hljs-*"> elements, so the
 *  children of <code> are an element tree, not a string. */
function nodeToText(node: React.ReactNode): string {
  if (node === null || node === undefined || node === false || node === true) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeToText).join("");
  if (typeof node === "object") {
    const props = (node as { props?: { children?: React.ReactNode } }).props;
    if (props) return nodeToText(props.children);
  }
  return "";
}

export interface Props {
  text: string;
}

function CodeBlock({ children, className }: { children?: React.ReactNode; className?: string }) {
  const [copied, setCopied] = useState(false);
  const match = /language-(\w+)/.exec(className ?? "");
  const raw = nodeToText(children);
  // 有语言标注、或内容含换行 => 代码块（含无语言标注的 ``` 围栏）
  const isBlock = match != null || /\n/.test(raw);

  const copy = async () => {
    try {
      await copyText(raw.replace(/\n$/, ""));
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* ignore */
    }
  };

  if (!isBlock) {
    return <code className={className}>{children}</code>;
  }
  return (
    <div className="code-block">
      <div className="code-head">
        <span className="dim">{match?.[1] ?? "text"}</span>
        <button className="ghost small" onClick={() => void copy()}>
          {copied ? "已复制 ✓" : "复制"}
        </button>
      </div>
      <pre>
        {/* 渲染 children 本身（保留 rehype-highlight 生成的 hljs span） */}
        <code className={className}>{children}</code>
      </pre>
    </div>
  );
}

export const MarkdownView = memo(function MarkdownView({ text }: Props) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { ignoreMissing: true }]]}
        components={{
          // 代码块的 <pre> 由 CodeBlock 自己渲染，避免 <pre> 嵌套 <pre>。
          pre: (p) => <>{p.children}</>,
          code: CodeBlock,
          a: (p) => (
            <a
              {...p}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => {
                e.preventDefault();
                const url = p.href;
                if (!url) return;
                if (isTauri()) void openUrl(url).catch(() => {});
                else window.open(url, "_blank");
              }}
            >
              {p.children}
            </a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
