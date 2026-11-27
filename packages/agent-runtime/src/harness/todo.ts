import type { AgentTodo, AgentTool, AgentToolContext, AgentToolResult } from "../types.ts";
import { syncPlanFromTodos } from "./plan-state.ts";

export const MAX_TODOS = 30;

export const todoWriteTool: AgentTool = {
  definition: {
    name: "todo_write",
    description: `Create or replace the task's todo list. Use it to track multi-step work (coding, data, documents or research) and keep statuses current. At most ${MAX_TODOS} items; split larger work into subtasks or higher-level steps.`,
    executionMode: "sequential",
    parameters: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          maxItems: MAX_TODOS,
          description: `The full todo list, in order. Replaces the previous list. Maximum ${MAX_TODOS} items.`,
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Stable short id, e.g. t1" },
              content: { type: "string", description: "One concrete step. Wrap file names, commands and other code identifiers in backticks so the UI renders them as inline code." },
              status: { type: "string", enum: ["pending", "in_progress", "completed", "cancelled"] }
            },
            required: ["id", "content", "status"],
            additionalProperties: false
          }
        }
      },
      required: ["todos"],
      additionalProperties: false
    }
  },
  async execute(input: unknown, context: AgentToolContext): Promise<AgentToolResult> {
    const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
    const raw = Array.isArray(record.todos) ? record.todos : [];
    if (raw.length > MAX_TODOS) {
      return {
        content: `todo 数量超过 ${MAX_TODOS} 条（当前 ${raw.length} 条）。请拆成更高层级的步骤，或拆分子任务后再写入。`,
        isError: true
      };
    }
    const todos: AgentTodo[] = [];
    for (const item of raw.slice(0, MAX_TODOS)) {
      if (!item || typeof item !== "object") continue;
      const value = item as Record<string, unknown>;
      const id = typeof value.id === "string" ? value.id.trim() : "";
      const content = typeof value.content === "string" ? value.content.trim() : "";
      const status = value.status === "in_progress" || value.status === "completed" || value.status === "cancelled" ? value.status : "pending";
      if (!id || !content) continue;
      if (todos.some((todo) => todo.id === id)) continue;
      todos.push({ id, content, status });
    }
    const active = todos.filter((todo) => todo.status === "in_progress").length;
    if (active > 1) return { content: "一次只能有一个 in_progress 的 todo；请把其它项改为 pending 或 completed。", isError: true };
    if (context.state) {
      context.state.todos = todos;
      syncPlanFromTodos(context.state);
    }
    return {
      content: renderTodos(todos),
      ...(todos.length ? {} : { isError: true })
    };
  }
};

export const todoReadTool: AgentTool = {
  definition: {
    name: "todo_read",
    description: "Read the current todo list and its completion state.",
    executionMode: "parallel",
    parameters: { type: "object", properties: {}, additionalProperties: false }
  },
  async execute(_input: unknown, context: AgentToolContext): Promise<AgentToolResult> {
    const todos = context.state?.todos ?? [];
    return { content: todos.length ? renderTodos(todos) : "当前没有 todo。多步骤任务请先用 todo_write 建立计划。" };
  }
};

export function renderTodos(todos: AgentTodo[]): string {
  if (todos.length === 0) return "Todo list is empty.";
  const marker = (status: AgentTodo["status"]): string => status === "completed" ? "[x]" : status === "in_progress" ? "[>]" : status === "cancelled" ? "[-]" : "[ ]";
  return ["Todo list:", ...todos.map((todo) => `${marker(todo.status)} ${todo.id}: ${todo.content}`), "", "Keep exactly one item in_progress while working."].join("\n");
}

export function incompleteTodos(todos: AgentTodo[] | undefined): AgentTodo[] {
  return (todos ?? []).filter((todo) => todo.status !== "completed");
}

export function todoReminder(todos: AgentTodo[] | undefined): string | null {
  const open = incompleteTodos(todos);
  if (open.length === 0) return null;
  const current = open.find((todo) => todo.status === "in_progress");
  return `Todo progress reminder: ${open.length} item(s) still open${current ? `; current: ${current.content}` : ""}. Update todo_write as you finish steps.`;
}

/**
 * Finish guard for multi-step work: once the agent has touched files or run
 * commands, finishing without ever creating a todo list means the UI has
 * nothing to render. Ask the model to build the list first so the checklist
 * actually reflects the work. Single-step answers are left alone.
 */
export function todoFinishIssue(state: { todos: AgentTodo[]; plan?: { steps: unknown[] }; progress: { filesRead: string[]; filesModified: string[]; commands: unknown[] } } | undefined): string | null {
  if (!state) return null;
  if (state.todos.length > 0 || (state.plan?.steps.length ?? 0) > 0) return null;
  const commands = state.progress.commands.length;
  const writes = state.progress.filesModified.length;
  if (commands + writes < 2) return null;
  return "本任务已经执行了多个步骤，但还没有建立待办清单。请先用 todo_write 建立清单（把已完成的步骤标为 completed、当前步骤标为 in_progress、其余为 pending），然后再调用 finish_task。";
}
