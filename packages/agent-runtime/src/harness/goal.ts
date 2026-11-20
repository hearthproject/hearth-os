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
  maxTurns: number;
  turnsUsed: number;
  planPath: string | null;
  createdAt: string;
  updatedAt: string;
}

const STATUSES: PersistedGoalStatus[] = ["active", "paused", "blocked", "completed"];
const DEFAULT_GOAL_MAX_TURNS = 100;

export function createGoalTools(): AgentTool[] {
  return [getGoalTool, createGoalTool, updateGoalTool];
}

export function goalFinishIssue(workspaceRoot: string): string | null {
  const goal = readGoalByRoot(workspaceRoot);
  if (!goal || goal.status !== "active") return null;
  return `存在进行中的持久目标「${goal.title}」。继续执行目标，验证成功标准后先调用 update_goal(status=completed)；如果被阻塞或需要暂停，调用 update_goal(status=blocked|paused, note=原因)，然后才能 finish_task。`;
}

export function goalContinuationPrompt(workspaceRoot: string): string | null {
  const goal = readGoalByRoot(workspaceRoot);
  if (!goal || goal.status !== "active") return null;
  const ratio = goal.maxTurns > 0 ? goal.turnsUsed / goal.maxTurns : 0;
  const cadence = ratio >= 0.8 ? "wrap-up" : ratio >= 0.5 ? "sparse" : "full";
  return [
    "## Persisted goal",
    "An active goal survives this run. Continue from the current workspace state instead of restating the whole task.",
    `title: ${goal.title}`,
    `objective: ${goal.objective}`,
    `constraints: ${goal.constraints.join(" | ") || "(none)"}`,
    `successCriteria: ${goal.successCriteria.join(" | ") || "(none)"}`,
    `progress: ${goal.turnsUsed}/${goal.maxTurns} turns (${cadence} cadence)`,
    ...(goal.planPath ? [`plan: ${goal.planPath}`] : []),
    ...(goal.note ? [`note: ${goal.note}`] : []),
    "Before finish_task, verify the success criteria and call update_goal(status=completed). If the goal cannot continue, call update_goal(status=paused|blocked, note=reason)."
  ].join("\n");
}

export function recordGoalTurns(workspaceRoot: string, turns: number): PersistedGoal | null {
  const goal = readGoalByRoot(workspaceRoot);
  if (!goal || goal.status !== "active" || !Number.isFinite(turns) || turns <= 0) return goal;
  const turnsUsed = goal.turnsUsed + Math.max(0, Math.floor(turns));
  const exhausted = goal.maxTurns > 0 && turnsUsed >= goal.maxTurns;
  const next: PersistedGoal = {
    ...goal,
    turnsUsed,
    ...(exhausted ? {
      status: "paused" as const,
      note: `Stopped at maxTurns=${goal.maxTurns}; resume with update_goal(status=active) after reviewing progress.`
    } : {}),
    updatedAt: new Date().toISOString()
  };
  writeGoalFile(workspaceRoot, next);
  return next;
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
        successCriteria: { type: "array", items: { type: "string" }, description: "Verifiable completion checks" },
        maxTurns: { type: "number", description: "Turn budget across resumes; defaults to 100" },
        planPath: { type: "string", description: "Optional plan file path" }
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
      maxTurns: boundedMaxTurns(args.maxTurns),
      turnsUsed: 0,
      planPath: typeof args.planPath === "string" && args.planPath.trim() ? args.planPath.trim().slice(0, 500) : null,
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
  return readGoalByRoot(context.workspaceRoot);
}

export function readGoalByRoot(workspaceRoot: string): PersistedGoal | null {
  const path = goalPath(workspaceRoot);
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
      maxTurns: typeof parsed.maxTurns === "number" ? boundedMaxTurns(parsed.maxTurns) : DEFAULT_GOAL_MAX_TURNS,
      turnsUsed: typeof parsed.turnsUsed === "number" && parsed.turnsUsed >= 0 ? Math.floor(parsed.turnsUsed) : 0,
      planPath: typeof parsed.planPath === "string" ? parsed.planPath : null,
      createdAt: parsed.createdAt ?? new Date().toISOString(),
      updatedAt: parsed.updatedAt ?? new Date().toISOString()
    };
  } catch {
    return null;
  }
}

function writeGoal(context: AgentToolContext, goal: PersistedGoal): void {
  const path = goalPath(context.workspaceRoot);
  assertWritable(path, context);
  mkdirSync(resolve(context.workspaceRoot, ".hearth"), { recursive: true });
  writeGoalFile(context.workspaceRoot, goal);
}

function writeGoalFile(workspaceRoot: string, goal: PersistedGoal): void {
  mkdirSync(resolve(workspaceRoot, ".hearth"), { recursive: true });
  writeFileSync(goalPath(workspaceRoot), `${JSON.stringify(goal, null, 2)}\n`, "utf8");
}

function goalPath(workspaceRoot: string): string {
  return resolve(workspaceRoot, ".hearth", "goal.json");
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()) : [];
}

function boundedMaxTurns(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(500, Math.max(1, Math.floor(value))) : DEFAULT_GOAL_MAX_TURNS;
}

function formatGoal(goal: PersistedGoal): string {
  return [
    `goalId: ${goal.goalId}`,
    `status: ${goal.status}`,
    `title: ${goal.title}`,
    `objective: ${goal.objective}`,
    `constraints: ${goal.constraints.join(" | ") || "(none)"}`,
    `successCriteria: ${goal.successCriteria.join(" | ") || "(none)"}`,
    `progress: ${goal.turnsUsed}/${goal.maxTurns} turns`,
    ...(goal.planPath ? [`planPath: ${goal.planPath}`] : []),
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
