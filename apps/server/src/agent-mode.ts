import type { AgentMode, ExecutorId } from "@hearth/core";
import type { SubagentType } from "@hearth/agent-runtime";

/**
 * Team v1 deliberately exposes read-only member types only. Worktree writers
 * stay available to internal callers/tests but are not offered to the Lead until
 * an explicit integration/merge path exists.
 */
export const TEAM_AGENT_TYPES: SubagentType[] = ["explore", "plan", "review"];

/**
 * Canonical receipt expected from every Team member. The Lead can override it
 * per delegation, but the default keeps summaries evidence-shaped instead of
 * free-form prose.
 */
export const TEAM_RECEIPT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: true,
  required: ["status", "summary", "evidence"],
  properties: {
    status: { type: "string", enum: ["completed", "blocked", "failed"] },
    summary: { type: "string", description: "结论摘要，必须能脱离父上下文独立阅读" },
    evidence: {
      type: "array",
      description: "支撑结论的证据；每条都要能定位到文件、命令或 URL",
      items: {
        type: "object",
        additionalProperties: true,
        required: ["claim", "source"],
        properties: {
          claim: { type: "string" },
          source: { type: "string", description: "文件路径、行号、命令或 URL" },
          detail: { type: "string" }
        }
      }
    },
    artifacts: {
      type: "array",
      items: { type: "string" },
      description: "产出的文件或链接路径"
    },
    unresolved: {
      type: "array",
      items: { type: "string" },
      description: "没有解决、需要 Lead 继续处理的问题"
    }
  }
};

export interface AgentModeResolution {
  requested: AgentMode;
  effective: AgentMode | "executor-managed";
  executorId: ExecutorId;
}

export function resolveAgentMode(requested: AgentMode | undefined, executorId: ExecutorId): AgentModeResolution {
  const mode = requested === "team" ? "team" : "single";
  return {
    requested: mode,
    effective: executorId === "native" ? mode : "executor-managed",
    executorId
  };
}

export function agentModePrompt(requested: AgentMode | undefined, executorId: ExecutorId): string {
  const resolution = resolveAgentMode(requested, executorId);
  if (resolution.effective === "executor-managed") {
    return [
      "## Agent 模式",
      `用户选择了 ${resolution.requested} 模式，但当前执行器（${executorId}）自行管理多 agent。Hearth 不会注入 agent/agent_wait 等委派工具，也无法审计执行器内部的成员、任务或用量。`,
      "不要声称 Hearth 已经创建团队或成员；最终结果里如实说明执行器是否使用了内部子代理。",
      resolution.requested === "single"
        ? "本次目标是单智能体：不要主动使用执行器内部的子代理能力；如果该能力无法关闭，请在结果中明确说明。"
        : "本次允许执行器自行决定是否使用内部子代理；Hearth 只负责最终结果与运行账本。"
    ].join("\n");
  }
  if (resolution.requested === "single") {
    return [
      "## Agent 模式：single",
      "本次运行是单智能体模式。Hearth 没有注入 agent/agent_wait 等委派工具；不要尝试委派子代理，也不要假设存在队友。直接完成任务。"
    ].join("\n");
  }
  return [
    "## Agent 模式：team",
    "你是 Lead，也是唯一对用户负责、唯一可以写入工作区的角色。团队成员只读，只能做调查、方案和审查。",
    "",
    "委派规则：",
    "- 只有任务确实能拆成 2 个以上独立子问题时才委派；拆不动就直接完成，并在最终答复里说明原因。",
    "- 成员类型只用 explore / plan / review；不要请求写入型成员。",
    "- 同时最多 4 个成员运行，整个任务累计最多 8 个；建议 2–4 个，不要为了凑人数而拆。",
    "- 每个成员必须收到自包含的目标、边界和输出契约；不要让成员依赖你脑中的上下文。",
    "- 能用 run_in_background 的独立调查优先并行发出，再用 agent_wait / agent_status 收口。",
    "- 成员返回的是 JSON 回执（status/summary/evidence/artifacts/unresolved）。必须核对 evidence 与文件路径后再采用；不能把成员结论直接当事实。",
    "- 写入、最终验证和答复由你完成；成员没有写权限。",
    "- 如果计划里有对应步骤，委派时传 stepId，成功会自动把该步骤标为完成。",
    "- 成员失败时，重试、换人或者自己补做，不要把失败回执直接交给用户。"
  ].join("\n");
}
