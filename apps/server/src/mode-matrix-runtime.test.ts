import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HearthStore } from "@hearth/eventlog";
import { defaultConversationSettings, type ExecutorHealth, type ExecutorId, type TaskRecord } from "@hearth/core";
import type { CodexRunOptions } from "@hearth/codex-executor";
import type { DeepSeekHarnessRunOptions, DeepSeekHarnessRunResult } from "@hearth/deepseek-executor";
import { DSH_TEAM_VERSION, DSH_TEAM_PACKAGES, executorRuntimeDir } from "./executor-installer.ts";
import { defaultExecutorSettings } from "./executor-settings.ts";
import { GoalService } from "./goals.ts";
import { PlanService } from "./plans.ts";
import { HearthScheduler, type CodexRunner, type ExecutorHealthProvider, type NativeRunner } from "./scheduler.ts";
import { HearthService } from "./service.ts";

const EXECUTORS = ["native", "codex", "deepseek-harness"] as const satisfies readonly ExecutorId[];
const AGENT_MODES = ["single", "team"] as const;
const WORKFLOWS = ["build", "plan", "goal"] as const;
const PAIRS = EXECUTORS.flatMap((planning) => EXECUTORS.map((execution) => [planning, execution] as const));
type Workflow = typeof WORKFLOWS[number];

const VALID_PLAN = `## 调查结论

- 已确认规划阶段由 Hearth 创建只读任务，执行器只输出方案。
- 计划正文通过 SHA-256 固定，构建任务绑定同一计划。

## 执行步骤

1. 读取执行器配置与调度器入口。
2. 输出实施方案，不修改工作区。

## 验证方法

- 运行类型检查和矩阵测试。

## 风险与非目标

- 风险是规划阶段误写文件，由只读权限拦截。
- 不接入执行器自己的 Goal 状态机。`;

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "hearth-mode-runtime-"));
  roots.push(root);
  return root;
}

function modelSettings() {
  return {
    providerId: "custom",
    providerName: "测试模型",
    protocol: "openai-chat" as const,
    baseUrl: "https://example.invalid/v1",
    model: "test-model",
    contextWindowTokens: 128_000,
    maxOutputTokens: 8_000,
    apiKey: "sk-test",
    updatedAt: null
  };
}

function goalHealth(executorId: ExecutorId): ExecutorHealth {
  return {
    id: executorId,
    canRun: true,
    command: "test",
    version: "test",
    issues: [],
    state: "ready",
    verifiedAt: new Date("2026-11-28T00:00:00.000Z").toISOString()
  };
}

function writeDelivery(outDir: string, goalId: string | null): void {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "result.md"), "矩阵执行完成\n", "utf8");
  if (goalId) {
    writeFileSync(join(outDir, "goal-intent.json"), JSON.stringify({
      status: "needs_input",
      note: "矩阵验证：本轮完成，等待下一轮指令",
      evidence: ["result.md"],
      createdAt: new Date().toISOString()
    }), "utf8");
  }
}

function fakeDshRuntime(settingsPath: string): void {
  const home = executorRuntimeDir(settingsPath, "deepseek-harness");
  const writePackage = (name: string, version: string) => {
    const dir = join(home, "node_modules", "@deepseek-ai", name.replace("@deepseek-ai/", ""));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version }), "utf8");
  };
  writePackage("@deepseek-ai/dsh-sdk-client", DSH_TEAM_VERSION);
  for (const name of DSH_TEAM_PACKAGES) writePackage(name, DSH_TEAM_VERSION);
}

function waitForStatus(service: HearthService, taskId: string, expected: string): Promise<TaskRecord> {
  return waitFor(() => service.store.getTask(taskId), (task) => task?.status === expected, `task ${expected}`)
    .then((task) => task as TaskRecord);
}

async function waitFor<T>(
  read: () => T,
  predicate: (value: T) => boolean,
  label: string,
  timeoutMs = 10_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const value = read();
  if (predicate(value)) return value;
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(value)}`);
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

describe("executor × agent mode × workflow runtime matrix", () => {
  it.each(
    EXECUTORS.flatMap((executorId) =>
      AGENT_MODES.flatMap((agentMode) =>
        WORKFLOWS.map((workflow) => [executorId, agentMode, workflow] as const)
      )
    )
  )("runs %s + %s + %s through the real scheduler", async (executorId, agentMode, workflow) => {
    const root = tempRoot();
    const settingsPath = join(root, "executor-settings.json");
    fakeDshRuntime(settingsPath);
    const store = new HearthStore(":memory:");
    const service = new HearthService(store);
    const conversation = store.createConversation(
      "matrix",
      defaultConversationSettings("full", { native: true, codex: true, "deepseek-harness": true })
    );
    store.updateConversationSettings(conversation.id, { agentMode });

    const captured: {
      native: import("./native-executor.ts").NativeRunOptions | null;
      codex: CodexRunOptions | null;
      dsh: DeepSeekHarnessRunOptions | null;
    } = { native: null, codex: null, dsh: null };
    let activeGoalId: string | null = null;
    const nativeRunner: NativeRunner = async (options) => {
      captured.native = options;
      const plan = options.mode === "plan";
      if (!plan) writeDelivery(options.prepared.outDir, options.task.goalId ?? activeGoalId);
      return {
        status: "completed",
        finalResponse: plan ? VALID_PLAN : "矩阵执行完成",
        usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, cacheWriteInputTokens: 0, reasoningOutputTokens: 0 },
        turns: 1,
        toolCalls: 0,
        question: null,
        outputs: [],
        ...(plan ? { planSubmitted: true } as const : {})
      };
    };
    const codexRunner: CodexRunner = async (options) => {
      captured.codex = options;
      const plan = options.sandboxMode === "read-only";
      if (!plan) writeDelivery(options.outDir ?? join(root, "codex-out"), activeGoalId);
      return {
        threadId: `codex-${executorId}-${workflow}`,
        finalResponse: plan ? VALID_PLAN : "矩阵执行完成",
        usage: null,
        profileLabel: "codex / test"
      };
    };
    const dshRunner = async (options: DeepSeekHarnessRunOptions): Promise<DeepSeekHarnessRunResult> => {
      captured.dsh = options;
      if (!options.planMode) writeDelivery(options.outDir, activeGoalId);
      return {
        finalResponse: options.planMode ? "" : "矩阵执行完成",
        planMarkdown: options.planMode ? VALID_PLAN : null,
        sessionId: `dsh-${executorId}-${workflow}`,
        usage: null,
        finishReason: "completed"
      };
    };

    const goals = new GoalService({ service, executorHealth: goalHealth, tickMs: 0, review: null });
    const plans = new PlanService({ service, planRoot: join(root, "plans") });
    const scheduler = new HearthScheduler({
      service,
      nativeRunner,
      codexRunner,
      deepseekRunner: dshRunner,
      executorHealth: (() => ({ canRun: true, issues: [] })) as ExecutorHealthProvider,
      modelSettingsPath: join(root, "model-settings.json"),
      modelSettingsForExecutor: () => modelSettings(),
      workspaceRoot: join(root, "workspaces"),
      githubCacheRoot: join(root, "git-cache"),
      artifactBase: root,
      contextBlobRoot: join(root, "context", "blobs"),
      executorSettingsPath: settingsPath,
      executorSettings: {
        ...defaultExecutorSettings(),
        executors: { codex: { executablePath: process.execPath } }
      },
      runtimePreparer: async (options) => ({
        ok: true,
        workspaceRoot: options.workspaceRoot,
        recordPath: join(options.workspaceRoot, ".runtime", "runtime.json"),
        logPath: join(options.workspaceRoot, ".runtime", "prepare.log"),
        python: null,
        node: null,
        errors: [],
        log: ""
      }),
      goals,
      plans
    });
    goals.attachScheduler(scheduler);
    plans.attachScheduler(scheduler);
    scheduler.start();

    try {
      let task: TaskRecord;
      let planId: string | null = null;
      let goalId: string | null = null;

      if (workflow === "build") {
        task = service.createTask({
          title: `${executorId} ${agentMode} build`,
          goal: "验证混合矩阵构建路径",
          conversationId: conversation.id,
          executorId
        });
      } else if (workflow === "plan") {
        const plan = plans.create({
          conversationId: conversation.id,
          objective: "验证规划路径",
          planningExecutorId: executorId,
          execution: { executorId, taskKind: "general", networkHosts: [], expectedOutputs: [] }
        });
        planId = plan.id;
        task = service.requireTask(plan.planningTaskId!);
      } else {
        const goal = goals.create({
          objective: "验证目标路径",
          conversationId: conversation.id,
          execution: { executorId, taskKind: "general", networkHosts: [], expectedOutputs: [] }
        });
        goalId = goal.goalId;
        activeGoalId = goalId;
        task = service.createTask({
          title: goal.title,
          goal: goal.objective,
          conversationId: conversation.id,
          goalId,
          executorId
        });
        goals.attachTask(goalId, task.id);
        await goals.action(goalId, "start");
      }

      const terminal = await waitForStatus(service, task.id, "completed");
      expect(terminal.status).toBe("completed");
      expect(service.store.listRuns(task.id)).toHaveLength(1);

      const modeEvent = store.listEvents(0, task.id).find((event) => event.type === "agent.mode");
      expect(modeEvent?.payload).toMatchObject({ requested: agentMode, effective: agentMode });

      if (workflow === "plan") {
        const plan = await waitFor(
          () => plans.get(planId!),
          (value) => value?.stage === "awaiting_approval",
          "plan awaiting approval"
        );
        if (!plan) throw new Error("plan missing after planning");
        expect(plan.planningExecutorId).toBe(executorId);
        expect(task.mode).toBe("plan");
      }

      if (workflow === "goal") {
        const goal = await waitFor(
          () => goals.get(goalId!),
          (value) => value.currentState === "awaiting_user" || value.currentState === "blocked",
          "goal gate"
        );
        expect(goal.execution?.executorId).toBe(executorId);
        expect(task.mode).toBe("build");
        expect(task.goalId).toBe(goalId);
      }

      if (executorId === "native") {
        const options = captured.native;
        if (!options) throw new Error("native runner was not invoked");
        const toolNames = (options.extraTools ?? []).map((tool) => tool.definition.name);
        if (workflow === "plan") {
          expect(options.mode).toBe("plan");
        } else {
          expect(options.mode ?? "build").toBe("build");
        }
        if (agentMode === "team") {
          expect(toolNames).toContain("agent");
          if (workflow === "goal") expect(toolNames).toEqual(expect.arrayContaining(["get_goal", "update_goal"]));
        } else {
          expect(toolNames).not.toContain("agent");
        }
      }
      if (executorId === "codex") {
        const options = captured.codex;
        expect(options).toBeTruthy();
        expect(options!.multiAgent?.enabled).toBe(agentMode === "team");
        if (workflow === "plan") {
          expect(options!.sandboxMode).toBe("read-only");
          expect(options!.networkAccessEnabled).toBe(false);
        }
      }
      if (executorId === "deepseek-harness") {
        const options = captured.dsh;
        expect(options).toBeTruthy();
        expect(options!.agentTeam?.enabled).toBe(agentMode === "team");
        if (workflow === "plan") {
          expect(options!.planMode).toBe(true);
          expect(options!.permissionMode).toBe("read-only");
        }
      }
    } finally {
      await scheduler.stop();
      store.close();
    }
  }, 30_000);
});

describe("planning and execution executor pairs at runtime", () => {
  it.each(PAIRS)("plans on %s and executes on %s", async (planningExecutor, executionExecutor) => {
    const harness = createPairHarness(tempRoot());
    harness.scheduler.start();
    try {
      const plan = harness.plans.create({
        conversationId: harness.conversationId,
        objective: "验证规划与执行分离",
        planningExecutorId: planningExecutor,
        execution: { executorId: planningExecutor, taskKind: "general", networkHosts: [], expectedOutputs: [] }
      });
      const planningTask = harness.service.requireTask(plan.planningTaskId!);
      await waitForStatus(harness.service, planningTask.id, "completed");
      await waitFor(() => harness.plans.get(plan.id), (value) => value?.stage === "awaiting_approval", "awaiting approval");

      const approved = await harness.plans.action(plan.id, "approve", { executorId: executionExecutor });
      const buildTask = harness.service.requireTask(approved.executionTaskId!);
      await waitForStatus(harness.service, buildTask.id, "completed");
      await waitFor(() => harness.plans.get(plan.id), (value) => value?.stage === "completed", "plan completed");

      const completedPlan = harness.plans.get(plan.id)!;
      expect(completedPlan.planningExecutorId).toBe(planningExecutor);
      expect(completedPlan.execution?.executorId).toBe(executionExecutor);
      expect(planningTask.mode).toBe("plan");
      expect(planningTask.executorId).toBe(planningExecutor);
      expect(harness.service.store.listRuns(planningTask.id)).toHaveLength(1);
      expect(harness.service.store.listRuns(planningTask.id)[0]?.executorId).toBe(planningExecutor);

      expect(buildTask.mode).toBe("build");
      expect(buildTask.executorId).toBe(executionExecutor);
      expect(harness.service.store.listRuns(buildTask.id)).toHaveLength(1);
      expect(harness.service.store.listRuns(buildTask.id)[0]?.executorId).toBe(executionExecutor);
    } finally {
      await harness.scheduler.stop();
      harness.store.close();
    }
  }, 30_000);
});

describe("planning and execution executor pairs with Team at runtime", () => {
  it.each(PAIRS)("plans on %s with team and executes on %s with team", async (planningExecutor, executionExecutor) => {
    const harness = createPairHarness(tempRoot(), "team");
    harness.scheduler.start();
    try {
      const plan = harness.plans.create({
        conversationId: harness.conversationId,
        objective: "验证 Team 下规划与执行分离",
        planningExecutorId: planningExecutor,
        execution: { executorId: planningExecutor, taskKind: "general", networkHosts: [], expectedOutputs: [] }
      });
      await waitForStatus(harness.service, plan.planningTaskId!, "completed");
      await waitFor(() => harness.plans.get(plan.id), (value) => value?.stage === "awaiting_approval", "awaiting approval");
      const approved = await harness.plans.action(plan.id, "approve", { executorId: executionExecutor });
      await waitForStatus(harness.service, approved.executionTaskId!, "completed");
      await waitFor(() => harness.plans.get(plan.id), (value) => value?.stage === "completed", "plan completed");

      if (planningExecutor === "native") {
        const planningCall = harness.calls.native[0];
        expect(planningCall?.extraTools?.map((tool) => tool.definition.name)).toContain("agent");
      }
      if (planningExecutor === "codex") expect(harness.calls.codex[0]?.multiAgent?.enabled).toBe(true);
      if (planningExecutor === "deepseek-harness") expect(harness.calls.dsh[0]?.agentTeam?.enabled).toBe(true);

      if (executionExecutor === "native") {
        const executionCall = harness.calls.native.at(-1);
        expect(executionCall?.extraTools?.map((tool) => tool.definition.name)).toContain("agent");
      }
      if (executionExecutor === "codex") expect(harness.calls.codex.at(-1)?.multiAgent?.enabled).toBe(true);
      if (executionExecutor === "deepseek-harness") expect(harness.calls.dsh.at(-1)?.agentTeam?.enabled).toBe(true);

      const buildTask = harness.service.requireTask(approved.executionTaskId!);
      expect(harness.service.store.listRuns(buildTask.id)).toHaveLength(1);
      expect(buildTask.executorId).toBe(executionExecutor);
    } finally {
      await harness.scheduler.stop();
      harness.store.close();
    }
  }, 30_000);
});

describe("plan retry across executors at runtime", () => {
  it("retries a failed build on a different executor without changing the approved plan", async () => {
    const harness = createPairHarness(tempRoot());
    harness.scheduler.start();
    try {
      const plan = harness.plans.create({
        conversationId: harness.conversationId,
        objective: "验证失败后换执行器重试",
        planningExecutorId: "native",
        execution: { executorId: "native", taskKind: "general", networkHosts: [], expectedOutputs: [] }
      });
      await waitForStatus(harness.service, plan.planningTaskId!, "completed");
      await waitFor(() => harness.plans.get(plan.id), (value) => value?.stage === "awaiting_approval", "awaiting approval");
      const originalSha = harness.plans.get(plan.id)?.planSha256;

      harness.failNativeBuilds = true;
      const approved = await harness.plans.action(plan.id, "approve");
      const failedTask = approved.executionTaskId!;
      await waitFor(() => harness.plans.get(plan.id), (value) => value?.stage === "failed", "first build failure");

      harness.failNativeBuilds = false;
      const retried = await harness.plans.action(plan.id, "retry", { executorId: "codex" });
      expect(retried.stage).toBe("executing");
      expect(retried.execution?.executorId).toBe("codex");
      expect(retried.planSha256).toBe(originalSha);
      expect(retried.executionTaskId).not.toBe(failedTask);
      await waitForStatus(harness.service, retried.executionTaskId!, "completed");
      await waitFor(() => harness.plans.get(plan.id), (value) => value?.stage === "completed", "retried plan completed");

      const runs = harness.service.store.listRuns(retried.executionTaskId!);
      expect(runs).toHaveLength(1);
      expect(runs[0]?.executorId).toBe("codex");
      expect(harness.service.requireTask(retried.executionTaskId!).executorId).toBe("codex");
    } finally {
      await harness.scheduler.stop();
      harness.store.close();
    }
  }, 30_000);
});

describe("goal executor switch with Team at runtime", () => {
  it("carries Team into the next round on a different executor", async () => {
    const harness = createPairHarness(tempRoot(), "team");
    harness.scheduler.start();
    try {
      const goal = harness.goals.create({
        objective: "验证目标跨执行器切换保留 Team",
        conversationId: harness.conversationId,
        execution: { executorId: "native", taskKind: "general", networkHosts: [], expectedOutputs: [] }
      });
      harness.goalId = goal.goalId;
      const task = harness.service.createTask({
        title: goal.title,
        goal: goal.objective,
        conversationId: harness.conversationId,
        goalId: goal.goalId,
        executorId: "native"
      });
      harness.goals.attachTask(goal.goalId, task.id);
      await harness.goals.action(goal.goalId, "start");
      await waitForStatus(harness.service, task.id, "completed");
      await waitFor(() => harness.goals.get(goal.goalId), (value) => value.currentState === "awaiting_user", "first round gate");
      expect(harness.calls.native[0]?.extraTools?.map((tool) => tool.definition.name)).toContain("agent");

      const switched = await harness.goals.action(goal.goalId, "switch_executor", {
        expectedRevision: harness.goals.get(goal.goalId).revision ?? 0,
        note: "下一轮改用 Codex Team",
        execution: { executorId: "codex", taskKind: "general", networkHosts: [], expectedOutputs: [] }
      });
      expect(switched.goal.execution?.executorId).toBe("codex");
      await harness.goals.action(goal.goalId, "resume", { note: "继续" });
      await waitFor(() => harness.service.store.listRuns(task.id), (runs) => runs.length === 2, "second round run");
      await waitForStatus(harness.service, task.id, "completed");

      expect(harness.calls.codex.at(-1)?.multiAgent?.enabled).toBe(true);
      expect(harness.service.requireTask(task.id).executorId).toBe("codex");
    } finally {
      await harness.scheduler.stop();
      harness.store.close();
    }
  }, 30_000);
});

describe("goal executor switches between rounds at runtime", () => {
  it.each(PAIRS)("starts on %s and switches to %s", async (initialExecutor, nextExecutor) => {
    const harness = createPairHarness(tempRoot());
    harness.scheduler.start();
    try {
      const goal = harness.goals.create({
        objective: "验证跨轮执行器切换",
        conversationId: harness.conversationId,
        execution: { executorId: initialExecutor, taskKind: "general", networkHosts: [], expectedOutputs: [] }
      });
      harness.goalId = goal.goalId;
      const task = harness.service.createTask({
        title: goal.title,
        goal: goal.objective,
        conversationId: harness.conversationId,
        goalId: goal.goalId,
        executorId: initialExecutor
      });
      harness.goals.attachTask(goal.goalId, task.id);
      await harness.goals.action(goal.goalId, "start");

      await waitForStatus(harness.service, task.id, "completed");
      await waitFor(() => harness.goals.get(goal.goalId), (value) => value.currentState === "awaiting_user", "first round gate");
      expect(harness.service.store.listRuns(task.id)).toHaveLength(1);
      expect(harness.service.store.listRuns(task.id)[0]?.executorId).toBe(initialExecutor);

      const switched = await harness.goals.action(goal.goalId, "switch_executor", {
        expectedRevision: harness.goals.get(goal.goalId).revision ?? 0,
        note: "下一轮换执行器",
        execution: { executorId: nextExecutor, taskKind: "general", networkHosts: [], expectedOutputs: [] }
      });
      expect(switched.goal.execution?.executorId).toBe(nextExecutor);
      expect(harness.service.requireTask(task.id).currentRunId).toBeNull();

      await harness.goals.action(goal.goalId, "resume", { note: "继续下一轮" });
      await waitFor(() => harness.service.store.listRuns(task.id), (runs) => runs.length === 2, "second round run");
      await waitForStatus(harness.service, task.id, "completed");
      await waitFor(() => harness.goals.get(goal.goalId), (value) => value.currentState === "awaiting_user", "second round gate");

      const runs = harness.service.store.listRuns(task.id);
      expect(runs).toHaveLength(2);
      expect(runs[1]?.executorId).toBe(nextExecutor);
      expect(harness.service.requireTask(task.id).mode).toBe("build");
      expect(harness.service.requireTask(task.id).executorId).toBe(nextExecutor);

      if (nextExecutor === "native") {
        expect(harness.calls.native.at(-1)?.resume).toBeUndefined();
      }
      if (nextExecutor === "codex") {
        const second = harness.calls.codex.at(-1);
        expect(second?.threadId).toBeUndefined();
      }
      if (nextExecutor === "deepseek-harness") {
        const second = harness.calls.dsh.at(-1);
        expect(second?.resumeSessionId).toBeUndefined();
      }
    } finally {
      await harness.scheduler.stop();
      harness.store.close();
    }
  }, 30_000);
});

function createPairHarness(root: string, agentMode: "single" | "team" = "single") {
  const settingsPath = join(root, "executor-settings.json");
  fakeDshRuntime(settingsPath);
  const store = new HearthStore(":memory:");
  const service = new HearthService(store);
  const conversation = store.createConversation(
    "pairs",
    defaultConversationSettings("full", { native: true, codex: true, "deepseek-harness": true })
  );
  if (agentMode === "team") store.updateConversationSettings(conversation.id, { agentMode });
  const calls = {
    native: [] as import("./native-executor.ts").NativeRunOptions[],
    codex: [] as CodexRunOptions[],
    dsh: [] as DeepSeekHarnessRunOptions[]
  };
  const harness: {
    store: HearthStore;
    service: HearthService;
    conversationId: string;
    goals: GoalService;
    plans: PlanService;
    scheduler: HearthScheduler;
    calls: typeof calls;
    goalId: string | null;
    failNativeBuilds: boolean;
  } = {
    store,
    service,
    conversationId: conversation.id,
    goals: null as unknown as GoalService,
    plans: null as unknown as PlanService,
    scheduler: null as unknown as HearthScheduler,
    calls,
    goalId: null,
    failNativeBuilds: false
  };

  const nativeRunner: NativeRunner = async (options) => {
    calls.native.push(options);
    const plan = options.mode === "plan";
    if (!plan && harness.failNativeBuilds) throw new Error("native build failed on purpose");
    if (!plan) writeDelivery(options.prepared.outDir, options.task.goalId ?? harness.goalId);
    return {
      status: "completed",
      finalResponse: plan ? VALID_PLAN : "矩阵执行完成",
      usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, cacheWriteInputTokens: 0, reasoningOutputTokens: 0 },
      turns: 1,
      toolCalls: 0,
      question: null,
      outputs: [],
      ...(plan ? { planSubmitted: true } as const : {})
    };
  };
  const codexRunner: CodexRunner = async (options) => {
    calls.codex.push(options);
    const plan = options.sandboxMode === "read-only";
    if (!plan) writeDelivery(options.outDir ?? join(root, "codex-out"), harness.goalId);
    return {
      threadId: `codex-${calls.codex.length}`,
      finalResponse: plan ? VALID_PLAN : "矩阵执行完成",
      usage: null,
      profileLabel: "codex / test"
    };
  };
  const dshRunner = async (options: DeepSeekHarnessRunOptions): Promise<DeepSeekHarnessRunResult> => {
    calls.dsh.push(options);
    if (!options.planMode) writeDelivery(options.outDir, harness.goalId);
    return {
      finalResponse: options.planMode ? "" : "矩阵执行完成",
      planMarkdown: options.planMode ? VALID_PLAN : null,
      sessionId: `dsh-${calls.dsh.length}`,
      usage: null,
      finishReason: "completed"
    };
  };

  const goals = new GoalService({ service, executorHealth: goalHealth, tickMs: 0, review: null });
  const plans = new PlanService({ service, planRoot: join(root, "plans") });
  const scheduler = new HearthScheduler({
    service,
    nativeRunner,
    codexRunner,
    deepseekRunner: dshRunner,
    executorHealth: (() => ({ canRun: true, issues: [] })) as ExecutorHealthProvider,
    modelSettingsPath: join(root, "model-settings.json"),
    modelSettingsForExecutor: () => modelSettings(),
    workspaceRoot: join(root, "workspaces"),
    githubCacheRoot: join(root, "git-cache"),
    artifactBase: root,
    contextBlobRoot: join(root, "context", "blobs"),
    executorSettingsPath: settingsPath,
    executorSettings: {
      ...defaultExecutorSettings(),
      executors: { codex: { executablePath: process.execPath } }
    },
    runtimePreparer: async (options) => ({
      ok: true,
      workspaceRoot: options.workspaceRoot,
      recordPath: join(options.workspaceRoot, ".runtime", "runtime.json"),
      logPath: join(options.workspaceRoot, ".runtime", "prepare.log"),
      python: null,
      node: null,
      errors: [],
      log: ""
    }),
    goals,
    plans
  });
  goals.attachScheduler(scheduler);
  plans.attachScheduler(scheduler);
  harness.goals = goals;
  harness.plans = plans;
  harness.scheduler = scheduler;
  return harness;
}
