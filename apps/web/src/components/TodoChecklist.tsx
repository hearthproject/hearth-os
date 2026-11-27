import { useEffect, useRef, useState } from "react";
import {
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  List,
  Loader2,
  MinusCircle,
  Pencil,
  Plus,
  Trash2
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

/** 运行期最多 30 条，与 agent-runtime 的 MAX_TODOS 保持一致。 */
export const MAX_TODO_ITEMS = 30;

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

let localSeq = 0;
function newTodoId(): string {
  localSeq += 1;
  return `user-${Date.now().toString(36)}-${localSeq}`;
}

/** 校验用户编辑后的清单，错误信息直接展示在卡片里。 */
export function validateTodoEdits(todos: TodoChecklistItem[]): string | null {
  if (todos.length === 0) return "清单不能为空";
  if (todos.length > MAX_TODO_ITEMS) return `最多 ${MAX_TODO_ITEMS} 条`;
  if (todos.some((todo) => !todo.content.trim())) return "步骤内容不能为空";
  const ids = new Set(todos.map((todo) => todo.id));
  if (ids.size !== todos.length) return "步骤 id 重复";
  if (todos.filter((todo) => todo.status === "in_progress").length > 1) return "只能有一个进行中的步骤";
  return null;
}

export function TodoChecklist({
  todos,
  editable = false,
  saving = false,
  onEdit
}: {
  todos: TodoChecklistItem[];
  editable?: boolean;
  saving?: boolean;
  onEdit?: (todos: TodoChecklistItem[]) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<TodoChecklistItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const lastFocus = useRef<string | null>(null);
  const canEdit = editable && Boolean(onEdit);

  useEffect(() => {
    if (!editing || !lastFocus.current) return;
    const input = document.querySelector<HTMLInputElement>(`[data-todo-id="${lastFocus.current}"]`);
    if (input) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
    lastFocus.current = null;
  }, [draft, editing]);

  if (todos.length === 0 && !editing) return null;
  const done = todos.filter((todo) => todo.status === "completed").length;
  const shown = editing ? draft : todos;

  const startEditing = () => {
    setDraft(todos.map((todo) => ({ ...todo })));
    setError(null);
    setEditing(true);
  };

  const cancelEditing = () => {
    setEditing(false);
    setError(null);
  };

  const submit = () => {
    const clean = draft.map((todo) => ({ ...todo, content: todo.content.trim() }));
    const problem = validateTodoEdits(clean);
    if (problem) {
      setError(problem);
      return;
    }
    onEdit?.(clean);
    setEditing(false);
    setError(null);
  };

  const updateDraft = (id: string, content: string) => {
    setDraft((current) => current.map((todo) => todo.id === id ? { ...todo, content } : todo));
  };

  const removeDraft = (id: string) => {
    setDraft((current) => current.filter((todo) => todo.id !== id));
  };

  const insertAfter = (id: string) => {
    const created = { id: newTodoId(), content: "", status: "pending" };
    lastFocus.current = created.id;
    setDraft((current) => {
      const index = current.findIndex((todo) => todo.id === id);
      const next = [...current];
      next.splice(index < 0 ? current.length : index + 1, 0, created);
      return next;
    });
  };

  const appendDraft = () => {
    const created = { id: newTodoId(), content: "", status: "pending" };
    lastFocus.current = created.id;
    setDraft((current) => [...current, created]);
  };

  if (editing) {
    return (
      <div className="inline-todos editing">
        <div className="inline-todos-edit-head">
          <span><Pencil size={13} /> 编辑执行清单</span>
          <small>改动会在下一轮同步给 Agent</small>
        </div>
        <ol className="inline-todos-list editing">
          {shown.map((todo, index) => (
            <li key={todo.id} className={`inline-todos-item ${todo.status} editing`}>
              <TodoIcon status={todo.status} />
              <span className="inline-todos-index">{index + 1}.</span>
              <input
                data-todo-id={todo.id}
                className="inline-todos-input"
                value={todo.content}
                onChange={(event) => updateDraft(todo.id, event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter") insertAfter(todo.id); }}
                placeholder="输入步骤内容，回车添加下一步"
                aria-label={`第 ${index + 1} 步`}
              />
              <button
                type="button"
                className="inline-todos-icon-btn"
                onClick={() => insertAfter(todo.id)}
                title="在下方添加步骤"
                aria-label="在下方添加步骤"
              ><Plus size={13} /></button>
              <button
                type="button"
                className="inline-todos-icon-btn danger"
                onClick={() => removeDraft(todo.id)}
                title="删除这一步"
                aria-label="删除这一步"
              ><Trash2 size={13} /></button>
            </li>
          ))}
        </ol>
        {error && <p className="inline-todos-error">{error}</p>}
        <div className="inline-todos-edit-actions">
          <button type="button" className="inline-todos-add" onClick={appendDraft} disabled={shown.length >= MAX_TODO_ITEMS}>
            <Plus size={13} /> 添加步骤
          </button>
          <span className="inline-todos-spacer" />
          <button type="button" className="inline-todos-cancel" onClick={cancelEditing}>取消</button>
          <button type="button" className="inline-todos-save" onClick={submit} disabled={saving}>
            {saving ? <Loader2 size={13} className="spin" /> : <Check size={13} />}
            保存清单
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="inline-todos">
      <div className="inline-todos-head">
        <button
          type="button"
          className="inline-todos-collapse"
          onClick={() => setCollapsed((value) => !value)}
          aria-expanded={!collapsed}
        >
          <List size={14} />
          <span>{todoHeaderText(done, todos.length)}</span>
          {todos.length >= MAX_TODO_ITEMS && <span className="inline-todos-limit">最多 {MAX_TODO_ITEMS} 条</span>}
          {collapsed
            ? <ChevronRight size={13} className="inline-todos-chevron" />
            : <ChevronDown size={13} className="inline-todos-chevron" />}
        </button>
        {canEdit && !collapsed && (
          <button type="button" className="inline-todos-edit-toggle" onClick={startEditing} title="编辑清单">
            <Pencil size={12} /> 编辑
          </button>
        )}
      </div>
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
              {todo.status === "cancelled" && <span className="inline-todos-cancelled-tag">已移除</span>}
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
