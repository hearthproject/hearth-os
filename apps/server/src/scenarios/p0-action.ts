import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ApprovalManager } from "../approvals.ts";
import { decideActionPolicy, resolveAction, verifyResolvedAction } from "../action-resolver.ts";
import { createTaskWithRun, errorCode } from "./support.ts";
import { externalApproval, result, withHarness } from "./common.ts";
import type { ScenarioHandler } from "./types.ts";

export const p0ActionScenarios: Record<string, ScenarioHandler> = {
  "approval-rejected-stops": async (context) => withHarness(async (service, store) => {
    const { task, manager, approval } = await externalApproval(service, context.root);
    const decided = await manager.decide(approval.id, "reject", approval.parameterHash);
    const effects = store.listEffects(task.id);
    const events = store.listEvents(0, task.id);
    context.check("task-recoverable", decided.task.status === "recoverable", `任务状态=${decided.task.status}`);
    context.check("approval-rejected", decided.approval.status === "rejected", `审批状态=${decided.approval.status}`);
    context.check("no-effect", effects.length === 0, `effect 数量=${effects.length}`);
    context.check("rejection-event", events.some((event) => event.type === "approval.rejected"), "必须记录 approval.rejected 事件");
    context.record("taskStatus", decided.task.status);
    context.record("approvalStatus", decided.approval.status);
    context.record("effectCount", effects.length);
    context.record("events", events.map((event) => event.type));
    return result(context);
  }),

  "action-binding-tamper": async (context) => withHarness(async (service, store) => {
    const executable = join(context.root, "tool.exe");
    writeFileSync(executable, "v1", "utf8");
    const action = resolveAction({
      proposal: { kind: "shell", summary: "运行假工具", command: { executable, cwd: context.root, argv: ["--check"] } },
      permissionMode: "guarded",
      context: "interactive",
      sessionRoot: context.root
    });
    const { task, run } = createTaskWithRun(service, {
      title: "动作绑定校验",
      workspace: context.root,
      status: "waiting_approval"
    });
    let executorCalls = 0;
    const manager = new ApprovalManager(service, async () => {
      executorCalls += 1;
      return {};
    });
    const approval = await manager.request({
      taskId: task.id,
      runId: run.id,
      kind: "tool.shell",
      summary: "运行假工具",
      target: { tool: "shell", executable },
      preview: { arguments: ["--check"] },
      action
    });
    writeFileSync(executable, "tampered", "utf8");
    const verification = verifyResolvedAction(action);
    let code: string | null = null;
    try {
      await manager.decide(approval.id, "approve", approval.parameterHash);
    } catch (error) {
      code = errorCode(error);
    }
    const storedApproval = store.getApproval(approval.id);
    const events = store.listEvents(0, task.id);
    context.check("digest-verification-fails", !verification.ok, verification.reason);
    context.check("approval-revoked", storedApproval?.status === "revoked", `审批状态=${storedApproval?.status}`);
    context.check("action-changed-code", code === "ACTION_CHANGED", `错误码=${code ?? "none"}`);
    context.check("no-executor-call", executorCalls === 0, `executor 调用次数=${executorCalls}`);
    context.check("no-effect", store.listEffects(task.id).length === 0, "篡改后不得产生 effect");
    context.check("revalidation-event", events.some((event) => event.type === "approval.revalidation_failed"), "必须记录重新校验失败事件");
    context.record("expectedDigest", action.actionDigest);
    context.record("verification", verification);
    context.record("errorCode", code);
    context.record("approvalStatus", storedApproval?.status ?? null);
    context.record("events", events.map((event) => event.type));
    return result(context);
  }),

  "non-interactive-high-risk-deny": async (context) => withHarness(async (service, store) => {
    const executable = join(context.root, "scheduled-tool.exe");
    writeFileSync(executable, "v1", "utf8");
    const action = resolveAction({
      proposal: { kind: "shell", summary: "定时任务执行高危命令", command: { executable, cwd: context.root } },
      permissionMode: "guarded",
      context: "scheduled",
      sessionRoot: context.root
    });
    const { task, run } = createTaskWithRun(service, {
      title: "无人值守定时任务",
      workspace: context.root,
      status: "waiting_approval"
    });
    let executorCalls = 0;
    const manager = new ApprovalManager(service, async () => {
      executorCalls += 1;
      return {};
    });
    const policy = decideActionPolicy(action);
    let code: string | null = null;
    try {
      await manager.request({
        taskId: task.id,
        runId: run.id,
        kind: "tool.shell",
        summary: "无人值守执行",
        target: { tool: "shell" },
        preview: { cwd: context.root },
        action
      });
    } catch (error) {
      code = errorCode(error);
    }
    const events = store.listEvents(0, task.id);
    const taskAfter = service.requireTask(task.id);
    context.check("policy-denies", !policy.allowed && !policy.requiresApproval, policy.reason);
    context.check("policy-denied-code", code === "POLICY_DENIED", `错误码=${code ?? "none"}`);
    context.check("no-approval", store.listApprovals(task.id).length === 0, "被策略拒绝时不得创建审批票");
    context.check("no-executor-call", executorCalls === 0, `executor 调用次数=${executorCalls}`);
    context.check("denial-event", events.some((event) => event.type === "approval.policy_denied"), "必须记录 policy_denied 事件");
    context.check("recoverable", taskAfter.status === "recoverable", `任务状态=${taskAfter.status}`);
    context.record("policy", policy);
    context.record("errorCode", code);
    context.record("events", events.map((event) => event.type));
    return result(context);
  })
};
