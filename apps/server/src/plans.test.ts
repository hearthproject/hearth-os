import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HearthStore } from "@hearth/eventlog";
import type { ExecutorId } from "@hearth/core";
import type { PlanSchedulerPort } from "./plans.ts";
import { PlanService, buildPlanningPrompt } from "./plans.ts";
import { HearthService } from "./service.ts";

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

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "hearth-plan-"));
  roots.push(root);
  const store = new HearthStore(":memory:");
  const service = new HearthService(store);
  const conversation = store.createConversation("plan conversation");
  const plans = new PlanService({ service, planRoot: join(root, "plans") });
  const scheduler = {
    requeuePlanTask: vi.fn((taskId: string) => service.requireTask(taskId)),
    cancel: vi.fn((taskId: string) => service.updateTask(taskId, { status: "cancelled" })),
    addFollowUp: vi.fn(),
    kick: vi.fn()
  } as unknown as PlanSchedulerPort;
  plans.attachScheduler(scheduler);
  return { root, store, service, conversation, plans, scheduler };
}

function readyPlan(
  plans: PlanService,
  taskId: string,
  runId: string,
  markdown = VALID_PLAN
) {
  plans.onPlanningRunStarted(taskId, runId);
  return plans.onPlanningTaskReady(taskId, markdown, null, { runId });
}

describe("PlanService", () => {
  it("creates one read-only planning task and persists a canonical hashed plan", () => {
    const { root, service, conversation, plans } = setup();
    const plan = plans.create({
      conversationId: conversation.id,
      title: "Add cache",
      objective: "Add a cache layer",
      textInput: "Add a cache layer"
    });
    expect(plan.stage).toBe("planning");
    expect(plan.planningTaskId).toBeTruthy();
    const task = service.requireTask(plan.planningTaskId!);
    expect(task.mode).toBe("plan");
    expect(task.planId).toBe(plan.id);
    expect(task.expectedOutputs).toEqual([]);
    expect(service.store.getConversation(conversation.id)?.settings.collaborationMode).toBe("plan");

    const ready = readyPlan(plans, task.id, "run-plan-1");
    const canonicalPath = join(root, "plans", `${plan.id}.md`);
    expect(ready?.stage).toBe("awaiting_approval");
    expect(ready?.planMarkdown).toContain("调查结论");
    expect(ready?.planPath).toBe(canonicalPath);
    expect(existsSync(canonicalPath)).toBe(true);
    expect(readFileSync(canonicalPath, "utf8")).toBe(`${VALID_PLAN}\n`);
    expect(ready?.planSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(() => plans.create({ conversationId: conversation.id, objective: "second" })).toThrow();
  });

  it("keeps the approved artifact stable across task worktrees and rejects tampering before build", async () => {
    const { root, service, conversation, plans } = setup();
    const plan = plans.create({ conversationId: conversation.id, objective: "Stable artifact", textInput: "Stable artifact" });
    readyPlan(plans, plan.planningTaskId!, "run-stable-artifact");
    const approved = await plans.action(plan.id, "approve");
    const buildTask = service.requireTask(approved.executionTaskId!);
    const canonicalPath = join(root, "plans", `${plan.id}.md`);

    expect(approved.planPath).toBe(canonicalPath);
    expect(approved.planPath).not.toContain("workspaces");
    expect(() => plans.assertExecutionPlan(plan.id, buildTask.id)).not.toThrow();

    writeFileSync(canonicalPath, `${VALID_PLAN}\n- tampered`, "utf8");
    expect(() => plans.assertExecutionPlan(plan.id, buildTask.id)).toThrow(/SHA-256/);
  });

  it("repairs a legacy worktree plan path when the user approves an older plan", async () => {
    const { root, store, service, conversation, plans } = setup();
    const plan = plans.create({ conversationId: conversation.id, objective: "Legacy plan", textInput: "Legacy plan" });
    readyPlan(plans, plan.planningTaskId!, "run-legacy-path");
    const ready = plans.get(plan.id)!;
    const legacyPath = join(root, "workspaces", "tasks", plan.planningTaskId!, ".hearth", "plans", `${plan.id}.md`);
    store.appendEvent({
      type: "plan.updated",
      taskId: plan.planningTaskId,
      payload: {
        ...ready,
        planPath: legacyPath,
        planSha256: null,
        revision: ready.revision + 1,
        updatedAt: new Date().toISOString()
      }
    });

    const approved = await plans.action(plan.id, "approve");
    expect(approved.planPath).toBe(join(root, "plans", `${plan.id}.md`));
    expect(existsSync(approved.planPath!)).toBe(true);
    expect(() => plans.assertExecutionPlan(plan.id, service.requireTask(approved.executionTaskId!).id)).not.toThrow();
  });

  it.each(["native", "codex", "deepseek-harness"] as ExecutorId[])(
    "freezes the %s executor across planning, approval, and build",
    async (executorId) => {
      const { root, service, conversation, plans } = setup();
      const plan = plans.create({
        conversationId: conversation.id,
        objective: "Ship feature",
        textInput: "Ship feature",
        execution: {
          executorId,
          taskKind: "workspace",
          networkHosts: ["registry.npmjs.org"],
          expectedOutputs: ["result.md"],
          executionMode: "standard"
        }
      });
      const planning = service.requireTask(plan.planningTaskId!);
      expect(planning.executorId).toBe(executorId);
      expect(planning.taskKind).toBe("workspace");
      expect(planning.expectedOutputs).toEqual([]);

      const ready = readyPlan(plans, planning.id, `run-${executorId}`);
      expect(ready?.planSha256).toMatch(/^[a-f0-9]{64}$/);
      const approved = await plans.action(plan.id, "approve");
      const execution = service.requireTask(approved.executionTaskId!);
      expect(execution.executorId).toBe(executorId);
      expect(execution.mode).toBe("build");
      expect(execution.taskKind).toBe("workspace");
      expect(execution.expectedOutputs).toEqual(["result.md"]);
      expect(execution.networkHosts).toEqual(["registry.npmjs.org"]);
      const prompt = execution.inputs.find((input) => input.kind === "text")?.value ?? "";
      expect(prompt).toContain(`批准计划：${plan.id}`);
      expect(prompt).toContain(`计划文件：${ready?.planPath}`);
      expect(prompt).toContain(`计划 SHA-256：${ready?.planSha256}`);
    }
  );

  it("preserves the selected executor for local project planning and build", async () => {
    const { root, store, service, conversation, plans } = setup();
    const now = new Date().toISOString();
    store.upsertLocalProject({
      id: "project-plan",
      name: "Plan project",
      path: root,
      defaultBranch: "main",
      createdAt: now,
      updatedAt: now
    });
    const plan = plans.create({
      conversationId: conversation.id,
      projectId: "project-plan",
      objective: "Ship the project feature",
      textInput: "Ship the project feature",
      execution: {
        executorId: "codex",
        taskKind: "workspace",
        expectedOutputs: ["result.md"]
      }
    });
    const planning = service.requireTask(plan.planningTaskId!);
    expect(planning).toMatchObject({
      projectId: "project-plan",
      executorId: "codex",
      taskKind: "workspace",
      mode: "plan"
    });

    readyPlan(plans, planning.id, "run-project-plan");
    const approved = await plans.action(plan.id, "approve");
    expect(service.requireTask(approved.executionTaskId!)).toMatchObject({
      projectId: "project-plan",
      executorId: "codex",
      taskKind: "workspace",
      mode: "build"
    });
  });

  it("completes, fails, and retries a build with the same approved plan", async () => {
    const { root, store, service, conversation, plans, scheduler } = setup();
    const plan = plans.create({ conversationId: conversation.id, objective: "Ship feature", textInput: "Ship feature" });
    readyPlan(plans, plan.planningTaskId!, "run-build-1");
    const approved = await plans.action(plan.id, "approve");
    expect(approved.stage).toBe("executing");
    expect(approved.executionTaskId).toBeTruthy();
    expect(service.store.getConversation(conversation.id)?.settings.collaborationMode).toBe("build");
    expect(scheduler.kick).toHaveBeenCalled();

    const firstExecution = approved.executionTaskId!;
    const failed = plans.onTaskFailed(firstExecution, "boom");
    expect(failed?.stage).toBe("failed");
    expect(failed?.error).toBe("boom");

    const retried = await plans.action(plan.id, "retry");
    expect(retried.stage).toBe("executing");
    expect(retried.executionTaskId).not.toBe(firstExecution);
    expect(service.requireTask(retried.executionTaskId!).mode).toBe("build");
    expect(store.getPlan(plan.id)?.planSha256).toBe(approved.planSha256);
  });

  it("keeps an interrupted build waiting for approval after a restart", async () => {
    const { root, service, conversation, plans, scheduler } = setup();
    const plan = plans.create({ conversationId: conversation.id, objective: "Restart", textInput: "Restart" });
    readyPlan(plans, plan.planningTaskId!, "run-restart");
    const approved = await plans.action(plan.id, "approve");
    service.updateTask(approved.executionTaskId!, { status: "running" });

    plans.recoverOnBoot();
    const recovered = plans.get(plan.id);
    expect(recovered?.stage).toBe("awaiting_approval");
    expect(recovered?.executionTaskId).toBe(approved.executionTaskId);
    expect(scheduler.cancel).toHaveBeenCalledWith(approved.executionTaskId);
  });

  it("turns an interrupted planning round into an actionable failure on restart", async () => {
    const { conversation, service, plans, scheduler } = setup();
    const plan = plans.create({ conversationId: conversation.id, objective: "Interrupted", textInput: "Interrupted" });
    service.updateTask(plan.planningTaskId!, { status: "running" });

    plans.recoverOnBoot();
    const recovered = plans.get(plan.id);
    expect(recovered?.stage).toBe("failed");
    expect(recovered?.error).toContain("规划尚未完成");
    expect(recovered?.planMarkdown).toBeNull();
    expect(recovered?.planningRunId).toBeNull();
    expect(scheduler.cancel).toHaveBeenCalledWith(plan.planningTaskId);

    const replanned = await plans.action(plan.id, "replan");
    expect(replanned.stage).toBe("planning");
    expect(replanned.planningAttempt).toBe(2);
    expect(scheduler.requeuePlanTask).toHaveBeenCalledWith(
      plan.planningTaskId,
      "用户要求修改计划。请基于当前工作区和已有调查重新规划，不执行修改。",
      { allowCompleted: true }
    );
  });

  it("rejects short plans and plans without all required sections", () => {
    const { root, conversation, plans } = setup();
    const plan = plans.create({ conversationId: conversation.id, objective: "Quality gate", textInput: "Quality gate" });
    plans.onPlanningRunStarted(plan.planningTaskId!, "run-quality");
    const short = plans.onPlanningTaskReady(
      plan.planningTaskId!,
      "这是计划：\n\n```markdown\n## 调查结论\n\n- 太短\n```",
      null,
      { runId: "run-quality" }
    );
    expect(short?.stage).toBe("failed");
    expect(short?.error).toContain("过短");
    expect(short?.planPath).toBeNull();
    expect(short?.planSha256).toBeNull();
  });

  it("strips a wrapping Markdown code fence before persisting the plan", () => {
    const { root, service, conversation, plans } = setup();
    const plan = plans.create({ conversationId: conversation.id, objective: "No raw md", textInput: "No raw md" });
    plans.onPlanningRunStarted(plan.planningTaskId!, "run-fence");
    const ready = plans.onPlanningTaskReady(
      plan.planningTaskId!,
      `这里是计划：\n\n\`\`\`markdown\n${VALID_PLAN}\n\`\`\``,
      "/tmp/model-authored.md",
      { runId: "run-fence" }
    );
    expect(ready?.planMarkdown).toBe(VALID_PLAN);
    expect(ready?.planPath).not.toBe("/tmp/model-authored.md");
    expect(service.requireTask(plan.planningTaskId!).expectedOutputs).toEqual([]);
  });

  it("continues planning in the same task and rejects a late prior-run result", () => {
    const { root, conversation, plans, scheduler } = setup();
    const plan = plans.create({ conversationId: conversation.id, objective: "Iterate", textInput: "Iterate" });
    readyPlan(plans, plan.planningTaskId!, "run-old");
    const revised = plans.continuePlanning(plan.id, "Use a smaller scope");
    expect(revised.stage).toBe("planning");
    expect(revised.planMarkdown).toBeNull();
    expect(revised.planningTaskId).toBe(plan.planningTaskId);
    expect(scheduler.requeuePlanTask).toHaveBeenCalledWith(plan.planningTaskId, "Use a smaller scope", { allowCompleted: true });

    expect(plans.onPlanningTaskReady(plan.planningTaskId!, `${VALID_PLAN}\n- stale`, null, {
      runId: "run-old"
    })).toBeNull();
    plans.onPlanningRunStarted(plan.planningTaskId!, "run-new");
    const fresh = plans.onPlanningTaskReady(plan.planningTaskId!, VALID_PLAN, null, {
      runId: "run-new"
    });
    expect(fresh?.stage).toBe("awaiting_approval");
    expect(fresh?.planningAttempt).toBe(2);
  });

  it.each([
    ["native", "submit_plan"],
    ["codex", "最终回复"],
    ["deepseek-harness", "exit_plan_mode"]
  ] as Array<[ExecutorId, string]>)("gives %s the executor-specific submission contract", (executorId, expected) => {
    const prompt = buildPlanningPrompt({
      title: "Contract",
      objective: "Inspect only",
      workspaceRoot: "C:\\work",
      outDir: "C:\\work\\out",
      executorId
    });
    expect(prompt).toContain(expected);
    expect(prompt).toContain("## 调查结论");
  });
});
