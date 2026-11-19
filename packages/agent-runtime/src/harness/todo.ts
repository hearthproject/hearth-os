import type { AgentTodo, AgentTool, AgentToolContext, AgentToolResult } from "../types.ts";

export const todoWriteTool: AgentTool = {
  definition: {
    name: "todo_write",
    description: "Create or replace the task's todo list. Use it to track multi-step coding work and keep statuses current.",
    executionMode: "sequential",
    parameters: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          description: "The full todo list, in order. Replaces the previous list.",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Stable short id, e.g. t1" },
              content: { type: "string", description: "One concrete step" },
              status: { type: "string", enum: ["pending", "in_progress", "completed"] }
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
    const todos: AgentTodo[] = [];
    for (const item of raw.slice(0, 30)) {
      if (!item || typeof item !== "object") continue;
      const value = item as Record<string, unknown>;
      const id = typeof value.id === "string" ? value.id.trim() : "";
      const content = typeof value.content === "string" ? value.content.trim() : "";
      const status = value.status === "in_progress" || value.status === "completed" ? value.status : "pending";
      if (!id || !content) continue;
      if (todos.some((todo) => todo.id === id)) continue;
      todos.push({ id, content, status });
    }
    const active = todos.filter((todo) => todo.status === "in_progress").length;
    if (active > 1) return { content: "一次只能有一个 in_progress 的 todo；请把其它项改为 pending 或 completed。", isError: true };
    if (context.state) context.state.todos = todos;
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
  const marker = (status: AgentTodo["status"]): string => status === "completed" ? "[x]" : status === "in_progress" ? "[>]" : "[ ]";
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
