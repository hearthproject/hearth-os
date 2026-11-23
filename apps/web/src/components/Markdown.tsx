import { isValidElement, useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "lucide-react";
import { copyToClipboard } from "../lib/clipboard.ts";

export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={className}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
          pre: CodeBlock,
          table: ({ node: _node, ...props }) => (
            <div className="table-wrap">
              <table {...props} />
            </div>
          )
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

function CodeBlock({ children, node: _node, ...props }: ComponentProps<"pre"> & { node?: unknown }) {
  const preRef = useRef<HTMLPreElement | null>(null);
  const timer = useRef<number | undefined>();
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const language = codeLanguage(children);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  async function copy() {
    window.clearTimeout(timer.current);
    try {
      await copyToClipboard(preRef.current?.innerText ?? "");
      setState("copied");
    } catch {
      setState("failed");
    }
    timer.current = window.setTimeout(() => setState("idle"), 1_600);
  }

  return (
    <div className="code-block">
      <div className="code-block-head">
        <span>{language}</span>
        <button type="button" onClick={() => void copy()} title="复制代码" aria-label="复制代码">
          {state === "copied" ? <Check size={12} /> : <Copy size={12} />}
          {state === "copied" ? "已复制" : state === "failed" ? "复制失败" : "复制"}
        </button>
      </div>
      <pre ref={preRef} {...props}>{children}</pre>
    </div>
  );
}

function codeLanguage(children: ReactNode): string {
  const child = Array.isArray(children) ? children[0] : children;
  if (!isValidElement<{ className?: string }>(child)) return "TEXT";
  const match = /language-([\w-]+)/.exec(child.props.className ?? "");
  return (match?.[1] ?? "TEXT").toUpperCase();
}
