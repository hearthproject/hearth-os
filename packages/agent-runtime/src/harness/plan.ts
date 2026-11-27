import type { AgentTool, AgentToolContext, AgentToolResult } from "../types.ts";
import { buildPlan, renderPlanContext, setPlan } from "./plan-state.ts";

const READ_ONLY_TOOLS = new Set([
  "read_file",
  "read_desktop_file",
  "read_document",
  "read_tool_output",
  "list_files",
  "search_text",
  "glob",
  "grep",
  "shell",
  "todo_read",
  "todo_write",
  "shell_output",
  "fetch_url",
  "memory_read",
  "memory_search",
  "ask_user",
  "submit_plan"
]);

const READ_ONLY_COMMANDS = [
  /^git\s+(status|diff|log|show|branch|rev-parse|ls-files|blame|grep)\b/i,
  /^(ls|pwd|cat|head|tail|wc|find|rg|grep|sed\s+-n|awk)\b/i,
  /^(node\s+--version|npm\s+--version|python\s+--version|go\s+version|cargo\s+--version)\b/i
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

export const MAX_PLAN_STEPS = 20;

export const submitPlanTool: AgentTool = {
  definition: {
    name: "submit_plan",
    description: "Submit the implementation plan to Hearth. Pass steps (at most 20, in execution order) so progress can be tracked; in build mode the run continues into execution right away. Split larger work into subtasks instead of exceeding 20 steps.",
    executionMode: "sequential",
    parameters: {
      type: "object",
      properties: {
        plan: { type: "string", description: "Optional free-text plan. When omitted, steps are used to build it." },
        title: { type: "string", description: "Short plan title." },
        steps: {
          type: "array",
          maxItems: MAX_PLAN_STEPS,
          description: "Ordered plan steps; each becomes a tracked todo.",
          items: {
            type: "object",
            properties: {
              title: { type: "string", description: "Short step title" },
              detail: { type: "string", description: "Optional details, files or commands" },
              owner: { type: "string", description: "Optional agent id to own this step (reserved for multi-agent work)" }
            },
            required: ["title"],
            additionalProperties: false
          }
        }
      },
      additionalProperties: false
    }
  },
  async execute(input: unknown, context: AgentToolContext): Promise<AgentToolResult> {
    const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
    let plan = typeof record.plan === "string" ? record.plan.trim() : "";
    const title = typeof record.title === "string" && record.title.trim() ? record.title.trim() : "implementation-plan";
    const rawSteps = Array.isArray(record.steps) ? record.steps : [];
    if (!plan && rawSteps.length > 0) {
      plan = rawSteps
        .map((item, index) => {
          if (!item || typeof item !== "object") return "";
          const entry = item as Record<string, unknown>;
          const stepTitle = typeof entry.title === "string" ? entry.title.trim() : "";
          const detail = typeof entry.detail === "string" ? entry.detail.trim() : "";
          return stepTitle ? `${index + 1}. ${stepTitle}${detail ? `：${detail}` : ""}` : "";
        })
        .filter(Boolean)
        .join("\n");
    }
    if (!plan) return { content: "plan 或 steps 至少需要提供一个。", isError: true };
    if (rawSteps.length > MAX_PLAN_STEPS) {
      return {
        content: `计划超过 ${MAX_PLAN_STEPS} 步（当前 ${rawSteps.length} 步）。请把它拆成子任务，分别调用 submit_plan 提交。`,
        isError: true
      };
    }
    const steps = planStepsFrom(rawSteps);
    let planContext: string | null = null;
    if (steps.length > 0) {
      setPlan(context.state, buildPlan(title, plan, steps));
      planContext = renderPlanContext(context.state?.plan);
    }
    if (steps.length > 0 && context.mode !== "plan") {
      // 直发 build 任务：先停在这里等用户确认计划，确认后由恢复流程继续。
      if (context.requirePlanApproval) {
        const confirmation = `计划已生成，共 ${steps.length} 步。请确认后继续；需要调整就直接告诉我。\n\n${planContext ?? plan}`;
        return {
          content: confirmation,
          action: "plan",
          summary: confirmation,
          question: confirmation,
          outputs: [],
          metadata: { title }
        };
      }
      return {
        content: `计划已记录，共 ${steps.length} 步，开始按顺序执行。\n\n${planContext ?? plan}`,
        metadata: { title }
      };
    }
    if (context.state) {
      context.state.mode = "plan";
    }
    return {
      content: `计划已提交给 Hearth，可以开始执行。\n\n${plan}`,
      action: "plan",
      summary: plan,
      question: plan,
      outputs: [],
      metadata: { title }
    };
  }
};

function planStepsFrom(raw: unknown[]): Array<{ title: string; detail?: string; owner?: string }> {
  const steps: Array<{ title: string; detail?: string; owner?: string }> = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const title = typeof record.title === "string" ? record.title.trim() : "";
    if (!title) continue;
    const detail = typeof record.detail === "string" ? record.detail.trim() : "";
    const owner = typeof record.owner === "string" ? record.owner.trim() : "";
    steps.push({ title, ...(detail ? { detail } : {}), ...(owner ? { owner } : {}) });
  }
  return steps;
}
