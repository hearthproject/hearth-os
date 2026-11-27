import { useState } from "react";
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  List,
  Loader2,
  MinusCircle
} from "lucide-react";

export interface TodoChecklistItem {
  id: string;
  content: string;
  status: string;
}

export interface TodoContentPart {
  text: string;
  code: boolean;
}

/** 把 todo 文本里的 `code` 片段拆出来，供代码块样式渲染。 */
export function splitInlineCode(content: string): TodoContentPart[] {
  const parts: TodoContentPart[] = [];
  const pattern = /`([^`]+)`/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    if (match.index > last) parts.push({ text: content.slice(last, match.index), code: false });
    parts.push({ text: match[1]!, code: true });
    last = match.index + match[0].length;
  }
  if (last < content.length) parts.push({ text: content.slice(last), code: false });
  if (parts.length === 0) parts.push({ text: content, code: false });
  return parts;
}

export function todoHeaderText(done: number, total: number): string {
  return `${done} out of ${total} tasks completed`;
}

export function TodoChecklist({ todos }: { todos: TodoChecklistItem[] }) {
  const [collapsed, setCollapsed] = useState(false);
  if (todos.length === 0) return null;
  const done = todos.filter((todo) => todo.status === "completed").length;
  return (
    <div className="inline-todos">
      <button
        type="button"
        className="inline-todos-head"
        onClick={() => setCollapsed((value) => !value)}
        aria-expanded={!collapsed}
      >
        <List size={14} />
        <span>{todoHeaderText(done, todos.length)}</span>
        {todos.length >= 30 && <span className="inline-todos-limit">最多 30 条</span>}
        {collapsed
          ? <ChevronRight size={13} className="inline-todos-chevron" />
          : <ChevronDown size={13} className="inline-todos-chevron" />}
      </button>
      {!collapsed && (
        <ol className="inline-todos-list">
          {todos.map((todo, index) => (
            <li key={todo.id} className={`inline-todos-item ${todo.status}`}>
              <TodoIcon status={todo.status} />
              <span className="inline-todos-index">{index + 1}.</span>
              <span className="inline-todos-text">
                {splitInlineCode(todo.content).map((part, partIndex) => part.code
                  ? <code key={partIndex} className="inline-todos-code">{part.text}</code>
                  : part.text)}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function TodoIcon({ status }: { status: string }) {
  if (status === "completed") return <CheckCircle2 size={14} aria-label="已完成" />;
  if (status === "in_progress") return <Loader2 size={14} className="spin" aria-label="进行中" />;
  if (status === "cancelled") return <MinusCircle size={14} aria-label="已取消" />;
  return <Circle size={14} aria-label="待办" />;
}
