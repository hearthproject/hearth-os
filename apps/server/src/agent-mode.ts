import type {
  AgentMode,
  CollaborationMode,
  ExecutorId,
  ExecutorTeamCapability,
  ExecutorTeamLimits,
  TeamCapabilityState,
  TeamGuarantee,
  TeamOwner,
  TeamVisibility
} from "@hearth/core";
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
  effective: AgentMode;
  executorId: ExecutorId;
  owner: TeamOwner;
  guarantee: TeamGuarantee;
  capability: TeamCapabilityState;
  visibility: TeamVisibility;
  limits: ExecutorTeamLimits | null;
  degraded: boolean;
  reason?: string;
  /** Set when plan mode overrode the requested Team switch. */
  forcedBy?: "plan";
}

export interface AgentModeResolutionInput {
  taskMode?: CollaborationMode;
  capability: ExecutorTeamCapability;
}

export function resolveAgentMode(
  requested: AgentMode | undefined,
  executorId: ExecutorId,
  options: AgentModeResolutionInput
): AgentModeResolution {
  const mode = requested === "team" ? "team" : "single";
  const capability = options.capability;
  const base = {
    requested: mode,
    executorId,
    owner: capability.owner,
    guarantee: capability.team,
    capability: capability.state,
    visibility: capability.visibility,
    limits: capability.limits
  } as const;

  if (mode === "single") {
    return { ...base, effective: "single", degraded: false };
  }

  if (options.taskMode === "plan") {
    return {
      ...base,
      effective: "single",
      degraded: false,
      forcedBy: "plan",
      reason: "计划模式固定单 Agent，团队开关不生效"
    };
  }

  if (capability.state === "unavailable" || capability.state === "probe_failed") {
    return {
      ...base,
      effective: "single",
      degraded: true,
      reason: capability.reason ?? "当前执行器的原生团队能力不可用"
    };
  }

  return { ...base, effective: "team", degraded: false };
}

export function agentModePrompt(resolution: AgentModeResolution): string {
  if (resolution.reason && resolution.effective === "single" && resolution.requested === "team") {
    return [
      "## Agent 模式：single（团队请求未生效）",
      `原因：${resolution.reason}。本次按单智能体执行，不要注入或调用任何委派工具，直接完成任务，并在最终答复里如实说明团队能力不可用的原因（不要归因于 Hearth 创建失败）。`
    ].join("\n");
  }

  if (resolution.effective === "single") {
    switch (resolution.owner) {
      case "codex":
        return [
          "## Agent 模式：single",
          "已为本次运行关闭 Codex 原生多 Agent（features.multi_agent=false）。不要假设存在子代理或队友；直接完成任务。",
          "不要在最终答复里声称使用了团队或成员。"
        ].join("\n");
      case "deepseek-harness":
        return [
          "## Agent 模式：single",
          "已为本次运行禁用 DeepSeek Harness 的子代理与团队工具。不要尝试委派队友；直接完成任务。"
        ].join("\n");
      default:
        return [
          "## Agent 模式：single",
          "本次运行是单智能体模式。Hearth 没有注入 agent/agent_wait 等委派工具；不要尝试委派子代理，也不要假设存在队友。直接完成任务。"
        ].join("\n");
    }
  }

  switch (resolution.owner) {
    case "codex":
      return [
        "## Agent 模式：team（Codex 原生）",
        "Codex 原生多 Agent 已开启（features.multi_agent=true），由 Codex 自己决定是否派内部成员。Hearth 不会注入 agent 工具，也收不到 Codex 的成员事件，因此不要向用户展示成员名单或成员用量。",
        "",
        "- 简单任务直接完成，不要为了凑团队而拆分。",
        "- 如果确实使用了内部协作，在最终答复里说明：“由 Codex 内部子代理完成，具体成员与用量不可见”。",
        "- 不要声称 Hearth 创建、管理或审计了团队成员。",
        "- Codex 内部成员继承当前 Codex 权限；不要把它们描述成只读成员。"
      ].join("\n");
    case "deepseek-harness":
      return [
        "## Agent 模式：team（DeepSeek Harness 原生）",
        "DeepSeek Harness 的 Team 服务与工具已挂载，由 Harness 自己决定是否创建队友。Hearth 只观察会话树与成员事件，不代替 Harness 组队。",
        "",
        "- 简单任务直接完成，不要为了凑人数而拆分。",
        "- 成员共享同一个工作目录；写作用域是建议性的，不是锁。需要写入时明确说明你在改哪些文件，避免与其他成员冲突。",
        "- 使用队友时优先并行独立调查；收到成员结果后要核对证据再采用。",
        "- 如果实际没有创建成员，在最终答复里直接说明，不要暗示已经组队。"
      ].join("\n");
    default:
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
}
