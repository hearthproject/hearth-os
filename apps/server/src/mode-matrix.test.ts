import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HearthStore } from "@hearth/eventlog";
import type {
  ExecutorId,
  ExecutorTeamCapability,
  GoalContract,
  RunRecord,
  TaskPauseResult,
  TaskRecord,
  TaskResumeReference
} from "@hearth/core";
import type { CodexRunOptions } from "@hearth/codex-executor";
import type { DeepSeekHarnessRunOptions } from "@hearth/deepseek-executor";
import { resolveAgentMode } from "./agent-mode.ts";
import { CodexExecutorAdapter, DeepSeekHarnessExecutorAdapter, type ExecutorInvocation } from "./executor-adapter.ts";
import { defaultExecutorSettings } from "./executor-settings.ts";
import { GoalService, type GoalSchedulerPort } from "./goals.ts";
import { PlanService, type PlanSchedulerPort } from "./plans.ts";
import { HearthService } from "./service.ts";
import type { PreparedWorkspace } from "./workspace.ts";

const EXECUTORS = ["native", "codex", "deepseek-harness"] as const satisfies readonly ExecutorId[];
const PAIRS = EXECUTORS.flatMap((planning) => EXECUTORS.map((execution) => [planning, execution] as const));
const roots: string[] = [];

const VALID_PLAN = `## 调查结论

- 已读取 apps/server/src/plans.ts 和 scheduler.ts，确认规划任务由 Hearth 创建，执行器只负责当前轮的只读调查与方案输出。
- 现有计划状态集中在 Hearth，迟到结果需要通过 run fence 拒绝。

## 执行步骤

1. 修改 apps/server/src/plans.ts，使用计划冻结的执行器创建规划和构建任务。
2. 在 scheduler.ts 中把规范计划路径和 SHA-256 写入批准的构建提示。

## 验证方法

- 运行 npm run typecheck，预期无 TypeScript 错误。
- 运行 PlanService 测试，确认规划正文、规范文件和哈希一致。

## 风险与非目标

- 风险是旧执行器的迟到结果覆盖新方案，需由 runId 和 planningAttempt 拦截。
- 本次不接入 Codex 或 DSH 的原生 Goal 状态机，也不允许执行器自行批准计划。`;

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "hearth-mode-matrix-"));
  roots.push(root);
  return root;
}

function capability(executorId: ExecutorId): ExecutorTeamCapability {
  if (executorId === "native") {
    return {
      owner: "hearth", single: "enforced", team: "managed", state: "available",
      visibility: "members", limits: { maxConcurrent: 4, maxTotal: 8, maxDepth: 2 }
    };
  }
  if (executorId === "codex") {
    return {
      owner: "codex", single: "enforced", team: "native", state: "available",
      visibility: "none", limits: { maxConcurrent: 4, maxTotal: 4, maxDepth: 1 }
    };
  }
  return {
    owner: "deepseek-harness", single: "enforced", team: "native", state: "available",
    visibility: "session-tree", limits: { maxConcurrent: 8, maxTotal: 8 }
  };
}

function invocation(root: string): ExecutorInvocation {
  return {
    task: {
      id: "task-matrix",
      title: "混合模式矩阵",
      goal: "只读调查并给出计划",
      inputs: [],
      permissions: { tools: [] }
    } as unknown as TaskRecord,
    run: {} as unknown as ExecutorInvocation["run"],
    prepared: { root } as PreparedWorkspace,
    budget: { maxTurns: 7, maxDurationMs: 60_000 },
    signal: new AbortController().signal,
    fullPermission: true,
    contextSettings: {} as ExecutorInvocation["contextSettings"],
    nativeSettings: null,
    dshSettings: null,
    executorSettings: defaultExecutorSettings(),
    prompt: "只读调查",
    expectedOutputs: [],
    activeThreadId: "previous-thread",
    onProgress: () => undefined,
    onNativeContextEvent: () => undefined,
    onNativeCheckpoint: () => undefined,
    onDshContextItem: () => undefined,
    onCodexContextItem: () => undefined,
    onCodexThreadStarted: () => undefined
  };
}

function fakeScheduler(service: HearthService): GoalSchedulerPort {
  return {
    async pause(taskId: string): Promise<TaskPauseResult> {
      return { task: { ...service.requireTask(taskId), status: "paused" }, resume: null };
    },
    resumePaused(taskId: string, _reference: TaskResumeReference): TaskRecord {
      return service.updateTask(taskId, { status: "queued" });
    },
    cancel(taskId: string): TaskRecord {
      return service.updateTask(taskId, { status: "cancelled" });
    },
    async replanGoalTask(taskId: string): Promise<TaskRecord> {
      return service.updateTask(taskId, { status: "queued" });
    },
    requeueGoalTask(taskId: string): TaskRecord {
      return service.requireTask(taskId);
    },
    kick: () => undefined
  };
}

function createRun(service: HearthService, task: TaskRecord, root: string, executorId: ExecutorId): RunRecord {
  return service.createRun({
    id: `run-${Math.random().toString(36).slice(2)}`,
    taskId: task.id,
    attempt: 1,
    status: "running",
    threadId: null,
    workspace: root,
    startedAt: new Date("2026-11-27T00:00:00.000Z").toISOString(),
    createdAt: new Date("2026-11-27T00:00:00.000Z").toISOString(),
    endedAt: null,
    failure: null,
    usage: null,
    leaseEpoch: 1,
    executorId,
    outDir: join(root, "out")
  } as Parameters<HearthService["createRun"]>[0]);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

describe("mixed mode and executor matrix", () => {
  it("resolves all 18 executor × single/team × build/plan/goal combinations", () => {
    for (const executorId of EXECUTORS) {
      for (const requested of ["single", "team"] as const) {
        for (const workflow of ["build", "goal", "plan"] as const) {
          const resolution = resolveAgentMode(requested, executorId, {
            capability: capability(executorId),
            taskMode: workflow === "plan" ? "plan" : "build"
          });
          expect(resolution, `${executorId}/${requested}/${workflow}`).toMatchObject({
            requested,
            executorId,
            effective: requested,
            degraded: false
          });
        }
      }
    }
  });

  it("keeps Codex planning read-only while enabling its native team", async () => {
    const root = tempRoot();
    const captured: { value: CodexRunOptions | null } = { value: null };
    const adapter = new CodexExecutorAdapter(async (options) => {
      captured.value = options;
      return { threadId: "plan-team", finalResponse: "## 调查结论\n\n- ok", usage: null, profileLabel: "codex" };
    });
    await adapter.execute({
      ...invocation(root),
      mode: "plan",
      team: resolveAgentMode("team", "codex", { capability: capability("codex"), taskMode: "plan" })
    });
    expect(captured.value).toMatchObject({
      sandboxMode: "read-only",
      networkAccessEnabled: false,
      multiAgent: { enabled: true, maxThreads: 4, maxDepth: 1 }
    });
  });

  it("keeps DSH planning read-only while enabling its native team", async () => {
    const root = tempRoot();
    const captured: { value: DeepSeekHarnessRunOptions | null } = { value: null };
    const adapter = new DeepSeekHarnessExecutorAdapter(async (options) => {
      captured.value = options;
      return {
        finalResponse: "",
        planMarkdown: "## 调查结论\n\n- ok",
        sessionId: "dsh-plan-team",
        usage: null,
        finishReason: "completed"
      };
    }, root);
    await adapter.execute({
      ...invocation(root),
      mode: "plan",
      team: resolveAgentMode("team", "deepseek-harness", { capability: capability("deepseek-harness"), taskMode: "plan" }),
      dshSettings: {
        protocol: "openai-chat",
        baseUrl: "http://127.0.0.1:1",
        model: "test-model",
        apiKey: "test-key"
      } as ExecutorInvocation["dshSettings"]
    });
    expect(captured.value).toMatchObject({
      planMode: true,
      permissionMode: "read-only",
      agentTeam: { enabled: true, maxMembers: 8, maxTasks: 256 }
    });
  });

  it.each(PAIRS)("plans on %s and executes on %s", async (planningExecutor, executionExecutor) => {
    const root = tempRoot();
    const store = new HearthStore(":memory:");
    const service = new HearthService(store);
    const conversation = store.createConversation("plan executor switch");
    const plans = new PlanService({ service, planRoot: join(root, "plans") });
    plans.attachScheduler({
      requeuePlanTask: (taskId: string) => service.requireTask(taskId),
      cancel: (taskId: string) => service.updateTask(taskId, { status: "cancelled" }),
      addFollowUp: () => undefined,
      kick: () => undefined
    } as unknown as PlanSchedulerPort);
    try {
      const plan = plans.create({
        conversationId: conversation.id,
        objective: "run on two executors",
        planningExecutorId: planningExecutor,
        execution: {
          executorId: planningExecutor,
          taskKind: "general",
          networkHosts: [],
          expectedOutputs: []
        }
      });
      expect(plan.planningExecutorId).toBe(planningExecutor);
      const planningTask = service.requireTask(plan.planningTaskId!);
      expect(planningTask.executorId).toBe(planningExecutor);
      expect(planningTask.mode).toBe("plan");

      plans.onPlanningRunStarted(planningTask.id, "run-plan");
      plans.onPlanningTaskReady(planningTask.id, VALID_PLAN, null, { runId: "run-plan" });
      const approved = await plans.action(plan.id, "approve", { executorId: executionExecutor });
      expect(approved.planningExecutorId).toBe(planningExecutor);
      expect(approved.execution?.executorId).toBe(executionExecutor);
      const buildTask = service.requireTask(approved.executionTaskId!);
      expect(buildTask.executorId).toBe(executionExecutor);
      expect(buildTask.mode).toBe("build");
    } finally {
      store.close();
    }
  });

  it.each(PAIRS)("goals start on %s and switch to %s", async (initialExecutor, nextExecutor) => {
    const root = tempRoot();
    const store = new HearthStore(":memory:");
    const service = new HearthService(store);
    const now = new Date("2026-11-27T00:00:00.000Z");
    const goals = new GoalService({
      service,
      executorHealth: () => ({
        executorId: initialExecutor,
        available: true,
        canRun: true,
        issues: [],
        checkedAt: now.toISOString(),
        version: "test",
        path: "test"
      } as never),
      now: () => now,
      tickMs: 0,
      review: null
    });
    goals.attachScheduler(fakeScheduler(service));
    try {
      const goal: GoalContract = goals.create({
        objective: "switch executors between rounds",
        execution: {
          executorId: initialExecutor,
          taskKind: "general",
          expectedOutputs: [],
          networkHosts: []
        }
      });
      const task = service.createTask({
        title: goal.title,
        goal: goal.objective,
        goalId: goal.goalId,
        executorId: initialExecutor,
        taskKind: "general"
      });
      goals.attachTask(goal.goalId, task.id);
      await goals.action(goal.goalId, "start");

      const run = createRun(service, task, root, initialExecutor);
      const outDir = join(root, "out", run.id);
      mkdirSync(outDir, { recursive: true });
      goals.onRunStarted({ task, run, outDir, workspaceRoot: root });
      writeFileSync(join(outDir, "goal-intent.json"), JSON.stringify({ status: "progress", note: "one round", evidence: [] }), "utf8");
      service.updateTask(task.id, { status: "running", currentRunId: run.id }, run.id);
      service.updateTask(task.id, { status: "completed" }, run.id);
      await goals.onRunCompleted({
        task,
        run: { ...run, status: "completed", endedAt: now.toISOString() },
        outDir,
        workspaceRoot: root,
        finalResponse: "one round"
      });

      const switched = await goals.action(goal.goalId, "switch_executor", {
        expectedRevision: goals.get(goal.goalId).revision ?? 0,
        note: "next round",
        execution: {
          executorId: nextExecutor,
          taskKind: "workspace",
          expectedOutputs: [],
          workspacePath: root,
          networkHosts: []
        }
      });
      expect(switched.goal.execution?.executorId).toBe(nextExecutor);
      const switchedTask = service.requireTask(task.id);
      expect(switchedTask.executorId).toBe(nextExecutor);
      expect(switchedTask.mode).toBe("build");
      expect(switchedTask.currentRunId).toBeNull();
    } finally {
      store.close();
    }
  });
});
