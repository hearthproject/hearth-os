import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "@hearth/agent-runtime";
import type { GoalContract, GoalRoundIntentStatus, GoalRoundRecord, TaskRecord } from "@hearth/core";
import { isGoalTerminal, normalizeGoal } from "@hearth/core";
import type { GoalService } from "./goals.ts";

export interface ControlGoalToolOptions {
  goals: GoalService;
  goalId: string;
  task: TaskRecord;
  outDir: string;
}

export function createControlGoalTools(options: ControlGoalToolOptions): AgentTool[] {
  const { goals, goalId, task, outDir } = options;
  const getGoalTool: AgentTool = {
    definition: {
      name: "get_goal",
      description: "查看当前目标契约、轮次进度、成功标准和下一步。目标由用户在 Hearth 中创建，本工具只读。",
      executionMode: "parallel",
      parameters: { type: "object", properties: {}, additionalProperties: false }
    },
    async execute() {
      const goal = goals.get(goalId);
      const rounds = goals.view(goalId).rounds;
      return { content: formatGoalView(goal, rounds) };
    }
  };

  const updateGoalTool: AgentTool = {
    definition: {
      name: "update_goal",
      description: "记录本轮目标意图。status=complete 只是提出完成请求，最终由宿主验收器依据成功标准和证据判定；不能直接关闭目标。",
      executionMode: "sequential",
      parameters: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["progress", "complete", "blocked", "needs_input"],
            description: "本轮意图：progress 继续、complete 请求完成、blocked 阻塞、needs_input 需要用户补充"
          },
          note: { type: "string", description: "本轮结果摘要、证据说明或阻塞原因" },
          evidence: {
            type: "array",
            items: { type: "string" },
            description: "支撑本轮的相对路径、产物 id 或运行证据"
          }
        },
        required: ["status"],
        additionalProperties: false
      }
    },
    async execute(input) {
      const goal = goals.get(goalId);
      if (isGoalTerminal(goal.currentState)) {
        return { content: `目标已经结束（${goal.currentState}），不能再写入本轮意图。`, isError: true };
      }
      const args = input && typeof input === "object" ? input as Record<string, unknown> : {};
      const rawStatus = typeof args.status === "string" ? args.status : "";
      const status = mapIntentStatus(rawStatus);
      if (!status) {
        return { content: "status 必须是 progress、complete、blocked 或 needs_input。", isError: true };
      }
      const note = typeof args.note === "string" ? args.note.trim().slice(0, 5_000) : "";
      if ((status === "blocked" || status === "needs_input") && !note) {
        return { content: "blocked / needs_input 需要 note 说明原因。", isError: true };
      }
      const evidence = Array.isArray(args.evidence)
        ? args.evidence.filter((item): item is string => typeof item === "string").map((item) => item.trim().slice(0, 500)).slice(0, 50)
        : [];
      const intent = {
        status,
        note,
        evidence,
        createdAt: new Date().toISOString()
      };
      mkdirSync(outDir, { recursive: true });
      const target = join(outDir, "goal-intent.json");
      const tmp = `${target}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(intent, null, 2)}\n`, "utf8");
      renameSync(tmp, target);
      const deferred = status === "complete"
        ? "完成请求已记录；本轮结束后由独立验收器依据成功标准和证据判定，不能由模型自评关闭目标。"
        : `本轮意图已记录：${status}。`;
      return {
        content: `${deferred}\n目标 ${goal.goalId} · 第 ${goal.roundCount ?? 0}/${goal.maxRounds ?? 24} 轮\n意图文件：goal-intent.json`
      };
    }
  };

  return [getGoalTool, updateGoalTool];
}

function mapIntentStatus(value: string): GoalRoundIntentStatus | null {
  if (value === "progress" || value === "complete" || value === "blocked" || value === "needs_input") return value;
  if (value === "active") return "progress";
  if (value === "completed") return "complete";
  if (value === "paused") return "needs_input";
  return null;
}

function formatGoalView(goal: GoalContract, rounds: GoalRoundRecord[]): string {
  const normalized = normalizeGoal(goal);
  const criteria = normalized.successCriteria.length > 0
    ? normalized.successCriteria.map((criterion, index) =>
      `${index + 1}. [${criterion.validator}${criterion.required ? "" : "，可选"}] ${criterion.description}`
    ).join("\n")
    : "未设置显式标准，由独立验收器判定。";
  const history = rounds.slice(-3).map((round) =>
    `- 第 ${round.index} 轮 ${round.status}：${round.summary ?? "无摘要"}${
      round.intent ? `（意图 ${round.intent.status}）` : ""
    }${round.verifier ? `（验收 ${round.verifier.verdict}：${round.verifier.summary}）` : ""}`
  ).join("\n");
  return [
    `目标：${normalized.title}`,
    `状态：${normalized.currentState}，自动推进：${normalized.armed ? "开启" : "关闭"}`,
    `轮次：${normalized.roundCount ?? 0}/${normalized.maxRounds ?? 24}`,
    `目标：${normalized.objective}`,
    normalized.constraints.length > 0 ? `约束：${normalized.constraints.join("；")}` : "",
    normalized.forbiddenActions.length > 0 ? `禁止动作：${normalized.forbiddenActions.join("；")}` : "",
    `成功标准：\n${criteria}`,
    normalized.evidenceRequirements.length > 0 ? `证据要求：${normalized.evidenceRequirements.join("；")}` : "",
    normalized.nextHandoff ? `下一步：${normalized.nextHandoff}` : "",
    history ? `最近轮次：\n${history}` : ""
  ].filter(Boolean).join("\n");
}
