import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HandoffPacket, RunRecord, TaskRecord } from "@hearth/core";
import { ChannelIngressService } from "../channel-adapter.ts";
import { ContextService } from "../context.ts";
import { DelegationService } from "../delegation.ts";
import { HandoffService } from "../handoff.ts";
import { SandboxService } from "../sandbox.ts";
import type { HearthService } from "../service.ts";
import { result, withHarness } from "./common.ts";
import { errorCode } from "./support.ts";
import type { ScenarioHandler } from "./types.ts";

export const p0BoundaryScenarios: Record<string, ScenarioHandler> = {
  "delegation-permission-cancel": async (context) => withHarness(async (service, store) => {
    const parent = createBoundaryParent(service, context.root);
    const delegations = new DelegationService({
      service,
      workspaceRoot: join(context.root, "delegations"),
      sandbox: new SandboxService({ now: context.clock.now }),
      now: context.clock.now
    });
    let escalationCode: string | null = null;
    try {
      delegations.create({
        ...delegationInput(parent.id, "scenario-escalation"),
        requestedPermissions: { tools: ["shell"] }
      });
    } catch (error) {
      escalationCode = errorCode(error);
    }
    const job = delegations.create(delegationInput(parent.id, "scenario-cancel"));
    delegations.lease(job.id, "scenario-worker");
    delegations.start(job.id, "scenario-worker");
    const childId = job.childTaskId ?? "";
    const cancelled = delegations.cancel(job.id, "假用户取消委派");
    let effectCode: string | null = null;
    try {
      delegations.assertEffectAllowed(childId);
    } catch (error) {
      effectCode = errorCode(error);
    }
    context.check("permission-escalation-denied", escalationCode === "DELEGATION_PERMISSION_ESCALATION", `错误码=${escalationCode ?? "none"}`);
    context.check("child-cancelled", cancelled.status === "cancelled" && service.requireTask(childId).status === "cancelled", `job=${cancelled.status}, child=${service.requireTask(childId).status}`);
    context.check("effect-blocked", effectCode === "DELEGATION_CLOSED", `错误码=${effectCode ?? "none"}`);
    context.check("no-effect", store.listEffects(childId).length === 0, `effect 数量=${store.listEffects(childId).length}`);
    context.record("job", cancelled);
    context.record("child", service.requireTask(childId));
    context.record("escalationCode", escalationCode);
    context.record("effectCode", effectCode);
    return result(context);
  }),

  "delegation-idempotency": async (context) => withHarness(async (service, store) => {
    const parent = createBoundaryParent(service, context.root);
    const delegations = new DelegationService({
      service,
      workspaceRoot: join(context.root, "delegations"),
      sandbox: new SandboxService({ now: context.clock.now }),
      now: context.clock.now
    });
    const first = delegations.create(delegationInput(parent.id, "scenario-idempotent"));
    const duplicate = delegations.create(delegationInput(parent.id, "scenario-idempotent"));
    let conflictCode: string | null = null;
    try {
      delegations.create({ ...delegationInput(parent.id, "scenario-idempotent"), goalSlice: "另一项工作" });
    } catch (error) {
      conflictCode = errorCode(error);
    }
    const jobs = store.listDelegationJobs(parent.id);
    const children = service.listTasks().filter((task) => task.id !== parent.id);
    context.check("same-job", first.id === duplicate.id && first.childTaskId === duplicate.childTaskId, `${first.id}/${duplicate.id}`);
    context.check("single-job", jobs.length === 1, `job 数量=${jobs.length}`);
    context.check("single-child", children.length === 1, `子任务数量=${children.length}`);
    context.check("conflict-rejected", conflictCode === "DELEGATION_IDEMPOTENCY_CONFLICT", `错误码=${conflictCode ?? "none"}`);
    context.record("job", first);
    context.record("duplicate", duplicate);
    context.record("conflictCode", conflictCode);
    return result(context);
  }),

  "handoff-generation-trace": async (context) => withHarness(async (service, store) => {
    const task = createBoundaryParent(service, context.root);
    const contextService = new ContextService(service, join(context.root, "blobs"));
    const handoffs = new HandoffService(service, contextService);
    const artifactPath = join(context.root, "evidence", "report.md");
    const artifactBody = "# Evidence\n\nConstraint: no external effect\n";
    mkdirSync(join(context.root, "evidence"), { recursive: true });
    writeFileSync(artifactPath, artifactBody, "utf8");
    const first = handoffs.prepare({
      taskId: task.id,
      fromRunId: "pending-run-1",
      fromExecutor: "native",
      toExecutor: "codex",
      status: "prepared",
      reasonCode: "capability_gap",
      diagnosis: null,
      packet: handoffPacket(task, artifactBody),
      initiatedBy: "auto",
      contextWatermarkSeq: 0
    });
    const run = createHandoffRun(service, task.id, first.handoff.id, context.clock.now());
    const verification = handoffs.verify(first.packet, { baseDir: context.root });
    const verified = handoffs.markVerification(first.handoff.id, verification);
    const second = handoffs.prepare({
      taskId: task.id,
      fromRunId: run.id,
      fromExecutor: "codex",
      toExecutor: "native",
      status: "prepared",
      reasonCode: "capability_gap",
      diagnosis: null,
      packet: handoffPacket(task, artifactBody),
      initiatedBy: "auto",
      contextWatermarkSeq: 1
    });
    let staleCode: string | null = null;
    try {
      contextService.record({
        taskId: task.id,
        runId: run.id,
        executorId: "codex",
        kind: "tool_result",
        role: "tool",
        content: "旧代次继续写入",
        executorEventId: "scenario-stale-write"
      });
    } catch (error) {
      staleCode = errorCode(error);
    }
    const stored = store.getHandoff(first.handoff.id);
    context.check("trace-retained", first.packet.goal === task.goal
      && first.packet.acceptance.length > 0
      && first.packet.permissions.tools.length > 0
      && first.packet.artifacts[0]?.path === "evidence/report.md"
      && first.packet.nextAction.length > 0, "目标、约束、证据和下一步必须保留");
    context.check("verification-passed", verification.status === "passed" && verified?.verification?.status === "passed", `验证=${verification.status}`);
    context.check("generation-increments", first.handoff.generation === 1 && second.handoff.generation === 2, `${first.handoff.generation}->${second.handoff.generation}`);
    context.check("stale-write-rejected", staleCode === "HANDOFF_GENERATION_STALE", `错误码=${staleCode ?? "none"}`);
    context.check("handoff-persisted", stored?.packet?.handoffId === first.handoff.id, stored?.packet?.handoffId ?? "missing");
    context.record("handoff", stored);
    context.record("verification", verification);
    context.record("staleCode", staleCode);
    return result(context);
  }),

  "sandbox-boundary-classification": async (context) => withHarness(async () => {
    const sandbox = new SandboxService({ now: context.clock.now });
    const policy = {
      workspaceRoot: context.root,
      permissions: {
        readRoots: [context.root],
        writeRoots: [join(context.root, "out")],
        networkHosts: ["api.example.com"],
        tools: ["read_file", "finish_task"]
      },
      allowedProcesses: ["read_file"]
    };
    const escapeClass = captureSandboxFailure(() => sandbox.evaluate(policy, { readPaths: [join(context.root, "..", "secret.txt")] }));
    const networkClass = captureSandboxFailure(() => sandbox.evaluate(policy, { networkHosts: ["evil.example.net"] }));
    const credentialClass = captureSandboxFailure(() => sandbox.evaluate(policy, {
      credentialExpiresAt: "2026-11-10T01:59:59.000Z"
    }));
    const allowed = sandbox.evaluate(policy, {
      cwd: context.root,
      readPaths: [join(context.root, "input.md")],
      writePaths: [join(context.root, "out", "result.md")],
      networkHosts: ["api.example.com"],
      tools: ["read_file"]
    });
    context.check("escape-classified", escapeClass === "sandbox_escape", `分类=${escapeClass ?? "none"}`);
    context.check("network-classified", networkClass === "network_violation", `分类=${networkClass ?? "none"}`);
    context.check("credential-classified", credentialClass === "credential_expired", `分类=${credentialClass ?? "none"}`);
    context.check("allowed-stays-allowed", allowed.allowed && allowed.checks.every((check) => check.ok), `allowed=${allowed.allowed}`);
    context.record("failureClasses", { escapeClass, networkClass, credentialClass });
    context.record("allowed", allowed);
    return result(context);
  }),

  "channel-inbound-idempotency": async (context) => withHarness(async (_service, store) => {
    const channels = new ChannelIngressService(store, context.clock.now);
    const first = channels.receive(channelMessage("scenario-message-1", 10, 2));
    const processed = channels.ack(first.record.id, { outcome: "processed-once" });
    const duplicate = channels.receive(channelMessage("scenario-message-1", 1, 2));
    const ackAgain = channels.ack(first.record.id, { outcome: "should-not-replace" });
    const staleGeneration = captureChannelFailure(() => channels.receive(channelMessage("scenario-message-2", 99, 1)));
    const staleCursor = captureChannelFailure(() => channels.receive(channelMessage("scenario-message-3", 9, 2)));
    const cursor = store.getChannelCursor("feishu", "scenario-chat");
    context.check("duplicate-returns-original", duplicate.duplicate && duplicate.record.id === first.record.id, `${first.record.id}/${duplicate.record.id}`);
    context.check("processed-once", store.listChannelDeliveries("feishu", "scenario-chat").length === 1 && processed.status === "processed", `deliveries=${store.listChannelDeliveries("feishu", "scenario-chat").length}`);
    context.check("ack-idempotent", ackAgain.receipt?.outcome === "processed-once", JSON.stringify(ackAgain.receipt));
    context.check("stale-generation-rejected", staleGeneration === "CHANNEL_GENERATION_STALE", `错误码=${staleGeneration ?? "none"}`);
    context.check("stale-cursor-rejected", staleCursor === "CHANNEL_CURSOR_STALE", `错误码=${staleCursor ?? "none"}`);
    context.check("newer-cursor-retained", cursor?.generation === 2 && cursor.cursor === 10, `cursor=${cursor?.generation}/${cursor?.cursor}`);
    context.record("delivery", processed);
    context.record("duplicate", duplicate);
    context.record("cursor", cursor);
    return result(context);
  })
};

function createBoundaryParent(service: HearthService, root: string) {
  return service.createTask({
    title: "边界验收父任务",
    goal: "验证权限、交接、沙箱与渠道边界",
    permissions: {
      readRoots: [root],
      writeRoots: [root],
      networkHosts: ["api.example.com"],
      tools: ["read_file", "list_files", "finish_task"]
    }
  });
}

function delegationInput(parentTaskId: string, idempotencyKey: string) {
  return {
    parentTaskId,
    goalSlice: "只读检索并返回证据",
    targetExecutor: "native" as const,
    contextPackRef: "context:scenario",
    contextPack: { objective: "只读检索" },
    workspacePolicy: "read-only" as const,
    idempotencyKey
  };
}

function handoffPacket(task: TaskRecord, artifactBody: string): HandoffPacket {
  return {
    handoffId: "pending",
    taskId: task.id,
    fromRunId: "pending-run-1",
    fromExecutor: "native",
    toExecutor: "codex",
    generation: 0,
    sourceCursor: 0,
    createdAt: "2026-11-10T02:00:00.000Z",
    goal: task.goal,
    acceptance: ["证据可读取", "权限不扩大", "下一步明确"],
    permissions: {
      readRoots: [...(task.permissions?.readRoots ?? [])],
      writeRoots: [...(task.permissions?.writeRoots ?? [])],
      networkHosts: [...(task.permissions?.networkHosts ?? [])],
      tools: [...(task.permissions?.tools ?? [])]
    },
    remainingBudget: { maxTurns: 4, maxToolCalls: 8, maxTokens: 4_000, maxDurationMs: 60_000 },
    summary: "只读检索已完成，等待下一执行器继续",
    completed: [{ text: "读取证据", contextItemId: null }],
    failed: [],
    artifacts: [{
      path: "evidence/report.md",
      sha256: createHash("sha256").update(artifactBody).digest("hex"),
      bytes: Buffer.byteLength(artifactBody),
      mimeType: "text/markdown; charset=utf-8"
    }],
    doNotRepeat: ["不要重复外部写入"],
    openQuestions: [],
    nextAction: "读取证据并完成验收",
    omittedHistory: [],
    redaction: { policy: "host-redaction-v1", redactedFields: [] },
    verification: {
      action: "读取证据并核对目标、权限和下一步",
      expected: ["目标一致", "权限未扩大", "证据可读取"],
      status: "pending",
      checkedAt: null,
      evidenceRefs: []
    }
  };
}

function createHandoffRun(service: HearthService, taskId: string, handoffId: string, now: Date): RunRecord {
  const timestamp = now.toISOString();
  const run: RunRecord = {
    id: randomUUID(),
    taskId,
    attempt: 1,
    status: "running",
    threadId: null,
    workspace: "scenario",
    startedAt: timestamp,
    endedAt: null,
    failure: null,
    usage: null,
    leaseEpoch: null,
    createdAt: timestamp,
    executorId: "native",
    handoffId
  };
  service.createRun(run);
  return run;
}

function captureSandboxFailure(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    return error && typeof error === "object" && "failureClass" in error
      ? String((error as { failureClass: unknown }).failureClass)
      : errorCode(error);
  }
}

function captureChannelFailure(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    return errorCode(error);
  }
}

function channelMessage(externalId: string, cursor: number, generation: number) {
  return {
    channel: "feishu",
    externalId,
    threadKey: "scenario-chat",
    sender: "fake-user-001",
    text: "边界验收消息",
    generation,
    cursor,
    auth: { ok: true, principal: "fake-user-001" }
  };
}
