import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentTool, AgentToolContext, AgentToolResult } from "../types.ts";

const READ_ONLY_TOOLS = new Set([
  "read_file",
  "read_document",
  "list_files",
  "search_text",
  "glob",
  "grep",
  "read_image",
  "todo_read",
  "todo_write",
  "shell_output",
  "ask_user",
  "submit_plan"
]);

const READ_ONLY_COMMANDS = [
  /^git\s+(status|diff|log|show|branch|rev-parse|ls-files|blame|grep)\b/i,
  /^(ls|pwd|cat|head|tail|wc|find|rg|grep|sed\s+-n|awk)\b/i,
  /^(node\s+--version|npm\s+--version|python\s+--version|go\s+version|cargo\s+--version)\b/i,
  /^(npm|pnpm|yarn|bun)\s+(test|run\s+test|lint|typecheck)\b/i
];

export function planModeAllowsTool(name: string): boolean {
  return READ_ONLY_TOOLS.has(name);
}

export function planModeAllowsCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  if (/[>|]\s/.test(trimmed) || /[;&]/.test(trimmed)) return false;
  return READ_ONLY_COMMANDS.some((pattern) => pattern.test(trimmed));
}

export const submitPlanTool: AgentTool = {
  definition: {
    name: "submit_plan",
    description: "In plan mode, write the implementation plan to .hearth/plans and pause for user approval.",
    executionMode: "sequential",
    parameters: {
      type: "object",
      properties: {
        plan: { type: "string", description: "Concrete plan with file paths, steps, commands, risks and open questions." },
        title: { type: "string", description: "Short plan title." }
      },
      required: ["plan"],
      additionalProperties: false
    }
  },
  async execute(input: unknown, context: AgentToolContext): Promise<AgentToolResult> {
    const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
    const plan = typeof record.plan === "string" ? record.plan.trim() : "";
    if (!plan) return { content: "plan 不能为空。", isError: true };
    const directory = join(context.workspaceRoot, ".hearth", "plans");
    mkdirSync(directory, { recursive: true });
    const title = typeof record.title === "string" && record.title.trim() ? record.title.trim() : "implementation-plan";
    const path = join(directory, `${title.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 60)}-${randomUUID().slice(0, 8)}.md`);
    writeFileSync(path, plan, "utf8");
    return {
      content: `计划已写入 ${path}。\n\n${plan}`,
      action: "plan",
      summary: plan,
      question: plan,
      outputs: [path]
    };
  }
};
