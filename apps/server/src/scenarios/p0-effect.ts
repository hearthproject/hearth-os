import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ArtifactRecord, RunCheckpointRecord } from "@hearth/core";
import { HearthStore } from "@hearth/eventlog";
import { ApprovalManager } from "../approvals.ts";
import { judgeCompletion } from "../completion-judge.ts";
import { ReconcileService } from "../reconcile.ts";
import { HearthService } from "../service.ts";
import { createTaskWithRun, effectRecord } from "./support.ts";
import { result, withHarness } from "./common.ts";
import type { ScenarioHandler } from "./types.ts";

export const p0EffectScenarios: Record<string, ScenarioHandler> = {
  "duplicate-send-protection": async (context) => withHarness(async (service, store) => {
    let executorCalls = 0;
    const { task, run } = createTaskWithRun(service, {
      title: "超时但实际成功的发送",
      workspace: context.root,
      status: "waiting_approval"
    });
    const manager = new ApprovalManager(service, async () => {
      executorCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 15));
      return { messageId: "provider-ack-1" };
    });
    const approval = await manager.request({
      taskId: task.id,
      runId: run.id,
      kind: "email.smtp-send",
      summary: "发送延迟响应邮件",
      target: { to: ["fake-user@example.test"] },
      preview: { body: "只应发送一次" }
    });
    const decisions = await Promise.all([
      manager.decide(approval.id, "approve", approval.parameterHash),
      manager.decide(approval.id, "approve", approval.parameterHash)
    ]);
    const effects = store.listEffects(task.id);
    context.check("single-executor-call", executorCalls === 1, `executor 调用次数=${executorCalls}`);
    context.check("single-effect", effects.length === 1, `effect 数量=${effects.length}`);
    context.check("single-receipt", effects[0]?.receipt?.messageId === "provider-ack-1", `receipt=${JSON.stringify(effects[0]?.receipt ?? null)}`);
    context.check("stable-idempotency-key", effects[0]?.idempotencyKey === `approval:${approval.id}:${approval.parameterHash}`, "幂等键必须由审批票和参数哈希派生");
    context.check("both-decisions-resolve", decisions.every((decision) => decision.effect?.id === effects[0]?.id), "重复确认必须返回同一个 effect");
    context.record("executorCalls", executorCalls);
    context.record("effect", effects[0] ?? null);
    context.record("decisionEffectIds", decisions.map((decision) => decision.effect?.id ?? null));
    return result(context);
  }),

  "unknown-effect-reconcile": async (context) => withHarness(async (service, store) => {
    const { task } = createTaskWithRun(service, { title: "发送后进程崩溃", workspace: context.root });
    const uncertain = effectRecord(service, {
      taskId: task.id,
      status: "uncertain",
      provider: "email",
      target: { to: ["fake-user@example.test"], subject: "回执未知" }
    });
    let providerChecks = 0;
    const reconcile = new ReconcileService(service, {
      now: context.clock.now,
      providers: {
        email: {
          check: () => {
            providerChecks += 1;
            return { status: "committed", providerRef: "smtp-msg-42", receipt: { messageId: "smtp-msg-42" } };
          }
        }
      }
    });
    const item = reconcile.enqueue(uncertain, "服务重启后未知发送结果");
    const resolved = await reconcile.check(item.id);
    const effect = store.getEffect(uncertain.id);
    const effects = store.listEffects(task.id);
    context.check("reconcile-item-created", item.status === "open", `对账项状态=${item.status}`);
    context.check("provider-checked", providerChecks === 1, `provider 检查次数=${providerChecks}`);
    context.check("resolved-committed", resolved.status === "resolved_committed", `对账结果=${resolved.status}`);
    context.check("effect-settled", effect?.status === "reconciled_committed", `effect 状态=${effect?.status}`);
    context.check("receipt-recorded", effect?.receipt?.messageId === "smtp-msg-42" && effect?.providerRef === "smtp-msg-42", "必须保存 provider 回执");
    context.check("no-replay", effects.length === 1, `effect 数量=${effects.length}`);
    context.record("reconcileItem", resolved);
    context.record("effect", effect);
    context.record("providerChecks", providerChecks);
    return result(context);
  }),

  "goal-completion-verification": async (context) => withHarness(async (service) => {
    const goal = service.createGoal({
      title: "假用户研究摘要",
      objective: "产出可核验的研究摘要",
      reviewPolicy: "auto",
      currentState: "active",
      successCriteria: [
        { id: "file", description: "摘要存在", validator: "file", check: "research-summary.json", required: true },
        { id: "schema", description: "字段完整", validator: "schema", check: "research-summary.json#title,summary", required: true }
      ],
      evidenceRequirements: ["research-summary.json"]
    });
    const task = service.createTask({ title: "研究摘要", goalId: goal.goalId, executorId: "native" });
    const content = JSON.stringify({ title: "周报", summary: "完成" });
    const artifactPath = join(context.root, "research-summary.json");
    writeFileSync(artifactPath, content, "utf8");
    const artifact: ArtifactRecord = {
      id: "artifact-research-summary",
      taskId: task.id,
      runId: "run-1",
      relativePath: "research-summary.json",
      absolutePath: artifactPath,
      mimeType: "application/json",
      sha256: createHash("sha256").update(content).digest("hex"),
      bytes: Buffer.byteLength(content),
      createdAt: context.clock.now().toISOString()
    };
    writeFileSync(artifactPath, JSON.stringify({ title: "周报", summary: "被篡改" }), "utf8");
    const report = await judgeCompletion({ goal, task, artifacts: [artifact], effects: [], now: context.clock.now() });
    context.check("rejects-tampered-artifact", report.verdict === "fail", `判定=${report.verdict}`);
    context.check("hash-diagnosis", report.criteria[0]?.detail.includes("修改") === true, report.criteria[0]?.detail ?? "no detail");
    context.check("no-fake-pass", report.criteria.some((criterion) => criterion.status === "failed"), "至少一条验收标准必须失败");
    context.record("completionReport", report);
    context.record("artifactEvidence", report.evidenceRefs);
    return result(context);
  }),

  "crash-recovery-checkpoint": async (context) => {
    const dbPath = join(context.root, "recovery.sqlite");
    const checkpointContent = JSON.stringify({ phase: "tool:write_file", proof: "committed" });
    const checkpointSha = createHash("sha256").update(checkpointContent).digest("hex");
    writeFileSync(join(context.root, "checkpoint-1.json"), checkpointContent, "utf8");
    let taskId = "";
    let runId = "";
    let committedId = "";
    let interruptedId = "";
    const firstStore = new HearthStore(dbPath);
    try {
      const service = new HearthService(firstStore);
      const created = createTaskWithRun(service, { title: "崩溃恢复", workspace: context.root });
      taskId = created.task.id;
      runId = created.run.id;
      const committed = effectRecord(service, { taskId, status: "committed", receipt: { messageId: "already-sent-1" } });
      const interrupted = effectRecord(service, { taskId, status: "executing", target: { to: ["other@example.test"] } });
      committedId = committed.id;
      interruptedId = interrupted.id;
      const checkpoint: RunCheckpointRecord = {
        id: "checkpoint-1",
        runId,
        taskId,
        seq: 1,
        kind: "tool",
        path: "checkpoint-1.json",
        sha256: checkpointSha,
        usage: null,
        createdAt: context.clock.now().toISOString(),
        proof: {
          goalId: null,
          attemptId: runId,
          identity: { executorId: "native", runtimeVersion: "scenario-1" },
          phasePrefix: ["tool:write_file"],
          validation: { status: "passed", evidenceRefs: [committed.id] },
          effectReceipts: [committed.id],
          preparedIntents: [],
          createdAt: context.clock.now().toISOString()
        }
      };
      service.createRunCheckpoint(checkpoint);
    } finally {
      firstStore.close();
    }
    const secondStore = new HearthStore(dbPath);
    try {
      const service = new HearthService(secondStore);
      const checkpoint = service.latestRunCheckpoint(runId);
      const before = secondStore.listEffects(taskId).length;
      const manager = new ApprovalManager(service, async () => ({}));
      manager.recoverInterruptedEffects();
      const effects = secondStore.listEffects(taskId);
      context.check("checkpoint-survives-restart", checkpoint?.proof?.effectReceipts.includes(committedId) === true, "重启后必须保留已证明检查点");
      context.check("committed-effect-preserved", effects.find((effect) => effect.id === committedId)?.status === "committed", "已提交 effect 不得回滚或重放");
      context.check("interrupted-effect-uncertain", effects.find((effect) => effect.id === interruptedId)?.status === "uncertain", "执行中 effect 必须转为 uncertain");
      context.check("no-new-effect", effects.length === before && effects.length === 2, `恢复前后 effect 数量=${before}->${effects.length}`);
      context.check("checkpoint-hash-matches", checkpoint?.sha256 === checkpointSha, "检查点内容哈希必须匹配");
      context.record("checkpoint", checkpoint);
      context.record("effects", effects);
      context.record("effectCountBefore", before);
      context.record("effectCountAfter", effects.length);
      return result(context);
    } finally {
      secondStore.close();
    }
  }
};
