import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HearthStore } from "@hearth/eventlog";
import { DelegationService } from "./delegation.ts";
import { HearthService } from "./service.ts";

describe("DelegationService", () => {
  let root: string;
  let store: HearthStore;
  let service: HearthService;
  let delegations: DelegationService;
  let now: Date;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hearth-delegation-"));
    store = new HearthStore(":memory:");
    service = new HearthService(store);
    now = new Date("2026-11-10T03:00:00.000Z");
    delegations = new DelegationService({
      service,
      workspaceRoot: join(root, "delegations"),
      now: () => now
    });
  });

  afterEach(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("returns the same job for the same idempotency key", () => {
    const parent = createParent(service, root);
    const first = delegations.create(input(parent.id, "idempotent-1"));
    const second = delegations.create(input(parent.id, "idempotent-1"));

    expect(second.id).toBe(first.id);
    expect(second.childTaskId).toBe(first.childTaskId);
    expect(store.listDelegationJobs(parent.id)).toHaveLength(1);
    expect(service.listTasks().filter((task) => task.id !== parent.id)).toHaveLength(1);
  });

  it("fails closed when a child asks for tools the parent did not declare", () => {
    const parent = createParent(service, root, {
      readRoots: [root],
      writeRoots: [root],
      networkHosts: [],
      tools: ["read_file", "finish_task"]
    });
    expect(() => delegations.create({
      ...input(parent.id, "permission-1"),
      workspacePolicy: "isolated-write",
      requestedPermissions: { tools: ["shell"] }
    })).toThrowError(expect.objectContaining({ code: "DELEGATION_PERMISSION_ESCALATION" }));

    const undeclared = service.createTask({ title: "undeclared", goal: "no permissions" });
    expect(() => delegations.create({
      ...input(undeclared.id, "permission-2"),
      requestedPermissions: { tools: ["read_file"] }
    })).toThrowError(expect.objectContaining({ code: "DELEGATION_PERMISSION_ESCALATION" }));
  });

  it("allows parallel leases up to the executor limit and rejects beyond it", () => {
    const parent = createParent(service, root);
    const jobs = [1, 2, 3, 4].map((index) => delegations.create(input(parent.id, `serial-${index}`)));
    const other = delegations.create({ ...input(parent.id, "serial-other"), targetExecutor: "codex" });

    for (const job of jobs.slice(0, 3)) {
      expect(delegations.lease(job.id, `worker-${job.id}`, 30_000).status).toBe("leased");
    }
    expect(() => delegations.lease(jobs[3]!.id, "worker-4", 30_000)).toThrowError(
      expect.objectContaining({ code: "DELEGATION_EXECUTOR_BUSY" })
    );
    expect(delegations.lease(other.id, "worker-c", 30_000).status).toBe("leased");
  });

  it("allows bounded recursive delegation and rejects beyond the depth limit", () => {
    const parent = createParent(service, root);
    const first = delegations.create(input(parent.id, "recursive-1"));
    expect(first.depth).toBe(1);
    const second = delegations.create(input(first.childTaskId ?? "", "recursive-2"));
    expect(second.depth).toBe(2);
    const third = delegations.create(input(second.childTaskId ?? "", "recursive-3"));
    expect(third.depth).toBe(3);
    expect(() => delegations.create(input(third.childTaskId ?? "", "recursive-4"))).toThrowError(
      expect.objectContaining({ code: "TASK_GRAPH_MAX_DEPTH" })
    );
    expect(store.listTaskEdges({ parentTaskId: parent.id })).toHaveLength(1);
    expect(store.listTaskEdges({ parentTaskId: first.childTaskId ?? "" })).toHaveLength(1);
  });

  it("cancels the child and blocks any later effect", () => {
    const parent = createParent(service, root);
    const job = delegations.create(input(parent.id, "cancel-1"));
    delegations.lease(job.id, "worker-a");
    delegations.start(job.id, "worker-a");
    const cancelled = delegations.cancel(job.id, "用户取消");

    expect(cancelled.status).toBe("cancelled");
    expect(service.requireTask(job.childTaskId ?? "").status).toBe("cancelled");
    expect(() => delegations.assertEffectAllowed(job.childTaskId ?? "")).toThrowError(
      expect.objectContaining({ code: "DELEGATION_CLOSED" })
    );
  });

  it("recovers jobs with expired leases, expired deadlines, or a closed parent", () => {
    const parent = createParent(service, root);
    const deadline = delegations.create({
      ...input(parent.id, "orphan-deadline"),
      deadline: "2026-11-10T02:59:59.000Z"
    });
    const leased = delegations.create(input(parent.id, "orphan-lease"));
    delegations.lease(leased.id, "worker-a", 1_000);
    now = new Date("2026-11-10T03:00:02.000Z");
    const parentClosed = delegations.create(input(parent.id, "orphan-parent"));
    service.updateTask(parent.id, { status: "running" });
    service.updateTask(parent.id, { status: "completed" });

    const recovered = delegations.recoverOrphans();
    expect(recovered.map((job) => job.id)).toEqual(
      expect.arrayContaining([deadline.id, leased.id, parentClosed.id])
    );
    expect(service.store.getDelegationJob(deadline.id)?.status).toBe("orphaned");
    expect(service.store.getDelegationJob(leased.id)?.status).toBe("orphaned");
    expect(service.store.getDelegationJob(parentClosed.id)?.status).toBe("orphaned");
  });

  it("requires parent verification and allows one bounded retry after rejection", () => {
    const parent = createParent(service, root);
    const job = delegations.create(input(parent.id, "verify-1"));
    delegations.lease(job.id, "worker-a");
    delegations.start(job.id, "worker-a");
    const submitted = delegations.complete(job.id, {
      summary: "只读检索完成",
      evidenceRefs: ["artifact:report.md"],
      artifacts: ["report.md"],
      unresolved: [],
      status: "completed",
      producedAt: now.toISOString()
    });
    expect(submitted.status).toBe("awaiting_verification");

    const rejected = delegations.verify(job.id, {
      parentTaskId: parent.id,
      verdict: "rejected",
      summary: "证据没有覆盖验收项",
      evidenceRefs: ["artifact:report.md"],
      checkedAt: now.toISOString()
    });
    expect(rejected.status).toBe("failed");

    const retried = delegations.retry(job.id);
    expect(retried).toMatchObject({ status: "queued", attempt: 2, result: null, verification: null });
    delegations.lease(job.id, "worker-b");
    delegations.start(job.id, "worker-b");
    delegations.complete(job.id, {
      summary: "补齐证据后完成",
      evidenceRefs: ["artifact:report.md", "test:unit"],
      artifacts: ["report.md"],
      unresolved: [],
      status: "completed",
      producedAt: now.toISOString()
    });
    const accepted = delegations.verify(job.id, {
      parentTaskId: parent.id,
      verdict: "accepted",
      summary: "父任务已核对证据",
      evidenceRefs: ["artifact:report.md", "test:unit"],
      checkedAt: now.toISOString()
    });
    expect(accepted.status).toBe("succeeded");
  });

  it("rejects incomplete results and cross-parent verification", () => {
    const parent = createParent(service, root);
    const job = delegations.create(input(parent.id, "incomplete-1"));
    delegations.lease(job.id, "worker-a");
    expect(() => delegations.complete(job.id, {
      summary: "",
      evidenceRefs: [],
      artifacts: [],
      unresolved: [],
      status: "completed",
      producedAt: now.toISOString()
    })).toThrowError(expect.objectContaining({ code: "DELEGATION_RESULT_INCOMPLETE" }));
    expect(() => delegations.verify(job.id, {
      parentTaskId: "another-parent",
      verdict: "accepted",
      summary: "not allowed",
      evidenceRefs: ["artifact:x"],
      checkedAt: now.toISOString()
    })).toThrowError(expect.objectContaining({ code: "DELEGATION_NOT_VERIFIABLE" }));
  });

  it("marks a running child as failed and rejects an invalid deadline", () => {
    const parent = createParent(service, root);
    expect(() => delegations.create({
      ...input(parent.id, "deadline-invalid"),
      deadline: "not-a-date"
    })).toThrowError(expect.objectContaining({ code: "DELEGATION_DEADLINE_INVALID" }));

    const job = delegations.create(input(parent.id, "failure-1"));
    delegations.lease(job.id, "worker-a");
    delegations.start(job.id, "worker-a");
    const failed = delegations.fail(job.id, "子任务执行器退出", true);

    expect(failed).toMatchObject({
      status: "failed",
      lease: null,
      failure: {
        code: "DELEGATION_CHILD_FAILED",
        message: "子任务执行器退出",
        retryable: true
      }
    });
    expect(delegations.fail(job.id, "重复失败", false)).toEqual(failed);
  });

  it("heartbeats a lease and requeues a paused child", () => {
    const parent = createParent(service, root);
    const job = delegations.create(input(parent.id, "heartbeat-1"));
    delegations.lease(job.id, "worker-a", 10_000);
    now = new Date("2026-11-10T03:00:05.000Z");
    const heartbeated = delegations.heartbeat(job.id, "worker-a", 20_000);

    expect(heartbeated.lease?.expiresAt).toBe("2026-11-10T03:00:25.000Z");
    const requeued = delegations.requeue(job.id, "worker-a");
    expect(requeued).toMatchObject({ status: "queued", lease: null });
    expect(() => delegations.assertEffectAllowed(job.childTaskId ?? "")).not.toThrow();
  });
});

function createParent(service: HearthService, root: string, permissions = {
  readRoots: [root],
  writeRoots: [root],
  networkHosts: ["api.example.com"],
  tools: ["read_file", "list_files", "finish_task"]
}) {
  return service.createTask({
    title: "父任务",
    goal: "验证委派边界",
    permissions
  });
}

function input(parentTaskId: string, idempotencyKey: string) {
  return {
    parentTaskId,
    goalSlice: "只读检索并给出证据",
    targetExecutor: "native" as const,
    contextPackRef: "context:task",
    contextPack: { objective: "只读检索" },
    workspacePolicy: "read-only" as const,
    idempotencyKey
  };
}
