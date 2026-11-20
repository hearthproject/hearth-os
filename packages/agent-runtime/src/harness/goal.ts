import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentTool, AgentToolContext } from "../types.ts";

export type PersistedGoalStatus = "active" | "paused" | "blocked" | "completed";

export interface PersistedGoal {
  goalId: string;
  title: string;
  objective: string;
  constraints: string[];
  successCriteria: string[];
  status: PersistedGoalStatus;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

const STATUSES: PersistedGoalStatus[] = ["active", "paused", "blocked", "completed"];

export function createGoalTools(): AgentTool[] {
  return [getGoalTool, createGoalTool, updateGoalTool];
}

const getGoalTool: AgentTool = {
  definition: {
    name: "get_goal",
    description: "Read the persisted coding goal for this workspace.",
    executionMode: "parallel",
    parameters: { type: "object", properties: {}, additionalProperties: false }
  },
  async execute(_input, context) {
    const goal = readGoal(context);
    return { content: goal ? formatGoal(goal) : "当前工作区没有持久目标。复杂任务可先用 create_goal 固化目标和成功标准。" };
  }
};

const createGoalTool: AgentTool = {
  definition: {
    name: "create_goal",
    description: "Persist a long-running coding goal with constraints and success criteria.",
    executionMode: "sequential",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short goal title" },
        objective: { type: "string", description: "Concrete end state" },
        constraints: { type: "array", items: { type: "string" }, description: "Hard constraints" },
        successCriteria: { type: "array", items: { type: "string" }, description: "Verifiable completion checks" }
      },
      required: ["title", "objective"],
      additionalProperties: false
    }
  },
  async execute(input, context) {
    const args = input && typeof input === "object" ? input as Record<string, unknown> : {};
    const title = typeof args.title === "string" ? args.title.trim() : "";
    const objective = typeof args.objective === "string" ? args.objective.trim() : "";
    if (!title || !objective) throw new Error("create_goal 需要 title 和 objective");
    if (objective.length > 20_000) throw new Error("目标过长");
    const existing = readGoal(context);
    if (existing && existing.status === "active") throw new Error("已有进行中的目标，请先 update_goal 完成或暂停它");
    const now = new Date().toISOString();
    const goal: PersistedGoal = {
      goalId: `goal_${randomUUID().slice(0, 8)}`,
      title: title.slice(0, 200),
      objective,
      constraints: stringList(args.constraints).slice(0, 20),
      successCriteria: stringList(args.successCriteria).slice(0, 20),
      status: "active",
      note: null,
      createdAt: now,
      updatedAt: now
    };
    writeGoal(context, goal);
    return { content: `已创建目标 ${goal.goalId}\n${formatGoal(goal)}` };
  }
};

const updateGoalTool: AgentTool = {
  definition: {
    name: "update_goal",
    description: "Update goal status or add a progress note. Use completed only after success criteria are verified.",
    executionMode: "sequential",
    parameters: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["active", "paused", "blocked", "completed"], description: "New status" },
        note: { type: "string", description: "Current evidence, blocker or next step" }
      },
      additionalProperties: false
    }
  },
  async execute(input, context) {
    const args = input && typeof input === "object" ? input as Record<string, unknown> : {};
    const goal = readGoal(context);
    if (!goal) throw new Error("没有可更新的持久目标");
    const status = typeof args.status === "string" ? args.status as PersistedGoalStatus : null;
    if (status && !STATUSES.includes(status)) throw new Error("status 必须是 active、paused、blocked 或 completed");
    const note = typeof args.note === "string" ? args.note.trim().slice(0, 5_000) : null;
    if (!status && !note) throw new Error("update_goal 至少需要 status 或 note");
    const next: PersistedGoal = {
      ...goal,
      ...(status ? { status } : {}),
      ...(note ? { note } : {}),
      updatedAt: new Date().toISOString()
    };
    writeGoal(context, next);
    return { content: `已更新目标 ${next.goalId}\n${formatGoal(next)}` };
  }
};

function readGoal(context: AgentToolContext): PersistedGoal | null {
  const path = goalPath(context);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<PersistedGoal>;
    if (!parsed.goalId || !parsed.title || !parsed.objective) return null;
    return {
      goalId: parsed.goalId,
      title: parsed.title,
      objective: parsed.objective,
      constraints: stringList(parsed.constraints),
      successCriteria: stringList(parsed.successCriteria),
      status: STATUSES.includes(parsed.status as PersistedGoalStatus) ? parsed.status as PersistedGoalStatus : "active",
      note: typeof parsed.note === "string" ? parsed.note : null,
      createdAt: parsed.createdAt ?? new Date().toISOString(),
      updatedAt: parsed.updatedAt ?? new Date().toISOString()
    };
  } catch {
    return null;
  }
}

function writeGoal(context: AgentToolContext, goal: PersistedGoal): void {
  const path = goalPath(context);
  assertWritable(path, context);
  mkdirSync(resolve(context.workspaceRoot, ".hearth"), { recursive: true });
  writeFileSync(path, `${JSON.stringify(goal, null, 2)}\n`, "utf8");
}

function goalPath(context: AgentToolContext): string {
  return resolve(context.workspaceRoot, ".hearth", "goal.json");
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()) : [];
}

function formatGoal(goal: PersistedGoal): string {
  return [
    `goalId: ${goal.goalId}`,
    `status: ${goal.status}`,
    `title: ${goal.title}`,
    `objective: ${goal.objective}`,
    `constraints: ${goal.constraints.join(" | ") || "(none)"}`,
    `successCriteria: ${goal.successCriteria.join(" | ") || "(none)"}`,
    ...(goal.note ? [`note: ${goal.note}`] : []),
    `updatedAt: ${goal.updatedAt}`
  ].join("\n");
}

function assertWritable(path: string, context: AgentToolContext): void {
  const inside = context.permissions.writeRoots.some((root) => {
    const relativePath = relative(isAbsolute(root) ? root : resolve(context.workspaceRoot, root), path);
    return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
  });
  if (!inside) throw new Error("当前任务没有写入目标文件的权限");
}
