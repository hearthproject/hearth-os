import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ArtifactRecord, RunRecord } from "@hearth/core";
import { HearthStore } from "@hearth/eventlog";
import { ContextService, estimateTokens, redactSecrets } from "./context.ts";
import { HearthService } from "./service.ts";

describe("ContextService", () => {
  let root: string | null = null;
  let store: HearthStore | null = null;

  afterEach(() => {
    store?.close();
    store = null;
    if (root) rmSync(root, { recursive: true, force: true });
    root = null;
  });

  function setup() {
    root = mkdtempSync(join(tmpdir(), "hearth-context-"));
    store = new HearthStore(":memory:");
    const service = new HearthService(store);
    const context = new ContextService(service, join(root, "blobs"));
    return { service, context };
  }

  it("redacts credentials before storing context", () => {
    const { service, context } = setup();
    const task = service.createTask({ title: "secret task", goal: "check" });
    const item = context.record({
      taskId: task.id,
      kind: "tool_result",
      role: "tool",
      content: "api_key=super-secret-value\nAuthorization: Bearer abcdefghijklmnop\nsk-1234567890abcdef"
    });
    expect(item.content).not.toContain("super-secret-value");
    expect(item.content).not.toContain("abcdefghijklmnop");
    expect(item.content).not.toContain("1234567890abcdef");
    expect(item.content).toContain("[REDACTED]");
    expect(redactSecrets("Cookie: session=abcdef123456")).toContain("[REDACTED]");
  });

  it("spills oversized content to a blob and keeps the reference", () => {
    const { service, context } = setup();
    const task = service.createTask({ title: "large task", goal: "check" });
    const content = "上下文".repeat(2_000);
    const item = context.record({ taskId: task.id, kind: "tool_result", role: "tool", content });
    expect(item.contentRef).not.toBeNull();
    expect(item.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(context.readBlob(item.contentRef ?? "")).toBe(content);
    expect(item.tokens).toBe(estimateTokens(content));
  });

  it("is idempotent for repeated executor events", () => {
    const { service, context } = setup();
    const task = service.createTask({ title: "idempotent task", goal: "check" });
    const run = createRun(service, task.id, "run-1");
    const first = context.record({
      taskId: task.id, runId: run.id, executorId: "native", kind: "tool_result", role: "tool",
      content: "same output", executorEventId: "tool:1"
    });
    const second = context.record({
      taskId: task.id, runId: run.id, executorId: "native", kind: "tool_result", role: "tool",
      content: "same output", executorEventId: "tool:1"
    });
    expect(second.id).toBe(first.id);
    expect(second.seq).toBe(first.seq);
    expect(context.listItems(task.id).total).toBe(1);
  });

  it("builds a deterministic task summary with artifacts", () => {
    const { service, context } = setup();
    const task = service.createTask({ title: "summary task", goal: "写会议纪要" });
    const run = createRun(service, task.id, "run-1", "completed");
    const artifact: ArtifactRecord = {
      id: "artifact-1", taskId: task.id, runId: run.id, relativePath: "meeting-notes.md",
      absolutePath: join(root ?? "", "meeting-notes.md"), mimeType: "text/markdown",
      sha256: "a".repeat(64), bytes: 42, createdAt: "2026-11-07T00:00:00.000Z"
    };
    service.publishArtifact(artifact);
    const state = context.refreshSummary(task.id);
    expect(state.summary).toContain("写会议纪要");
    expect(state.summary).toContain("meeting-notes.md");
    expect(state.completed[0]?.text).toContain("第 1 次运行");
    expect(state.artifacts[0]?.sha256).toBe("a".repeat(64));
    expect(state.summarySeq).toBe(context.listItems(task.id).items[0]?.seq ?? 0);
  });

  it("deletes items, summaries, handoffs and blobs with a receipt", () => {
    const { service, context } = setup();
    const task = service.createTask({ title: "delete task", goal: "check" });
    const run = createRun(service, task.id, "run-1");
    const item = context.record({
      taskId: task.id, runId: run.id, executorId: "native", kind: "tool_result", role: "tool",
      content: "x".repeat(20_000), executorEventId: "tool:big"
    });
    context.createHandoff({
      taskId: task.id, fromRunId: run.id, fromExecutor: "native", toExecutor: "codex",
      status: "pending_user", reasonCode: "capability_gap", diagnosis: null, packet: null,
      contextWatermarkSeq: 0, initiatedBy: "auto"
    });
    context.refreshSummary(task.id);
    const blobPath = join(root ?? "", "blobs", item.contentRef ?? "");
    expect(existsSync(blobPath)).toBe(true);
    const receipt = context.deleteTaskContext(task.id);
    expect(receipt.deletedItems).toBeGreaterThanOrEqual(2);
    expect(receipt.deletedHandoffs).toBe(1);
    expect(receipt.deletedBlobs).toBe(1);
    expect(existsSync(blobPath)).toBe(false);
    expect(context.listItems(task.id).total).toBe(0);
    expect(context.getState(task.id)).toBeNull();
  });

  it("feeds an optional context index and clears it with the task", () => {
    const { service, context } = setup();
    const indexed: string[] = [];
    let removed: string | null = null;
    context.setIndex({
      index: (item) => { indexed.push(item.id); },
      removeTask: (taskId) => { removed = taskId; },
      search: () => []
    });
    const task = service.createTask({ title: "indexed", goal: "check" });
    const item = context.record({ taskId: task.id, kind: "assistant_message", role: "assistant", content: "indexed item" });
    expect(indexed).toEqual([item.id]);
    context.deleteTaskContext(task.id);
    expect(removed).toBe(task.id);
  });

  it("keeps a deduplicated blob until every task referencing it is deleted", () => {
    const { service, context } = setup();
    const firstTask = service.createTask({ title: "first", goal: "check" });
    const secondTask = service.createTask({ title: "second", goal: "check" });
    const content = "z".repeat(20_000);
    const first = context.record({ taskId: firstTask.id, kind: "tool_result", role: "tool", content });
    const second = context.record({ taskId: secondTask.id, kind: "tool_result", role: "tool", content });
    expect(first.contentRef).not.toBeNull();
    expect(second.contentRef).toBe(first.contentRef);
    const blobPath = join(root ?? "", "blobs", first.contentRef ?? "");
    expect(context.readBlob("../outside.txt")).toBeNull();

    context.deleteTaskContext(firstTask.id);
    expect(existsSync(blobPath)).toBe(true);
    context.deleteTaskContext(secondTask.id);
    expect(existsSync(blobPath)).toBe(false);
  });

  it("prunes expired terminal task context and leaves active tasks alone", () => {
    const { service, context } = setup();
    const expired = service.createTask({ title: "expired", goal: "old context" });
    service.updateTask(expired.id, { status: "running" });
    service.updateTask(expired.id, { status: "completed" });
    context.record({
      taskId: expired.id, kind: "assistant_message", role: "assistant",
      content: "old context", createdAt: "2020-01-01T00:00:00.000Z"
    });
    context.refreshSummary(expired.id);

    const active = service.createTask({ title: "active", goal: "keep context" });
    service.updateTask(active.id, { status: "running" });
    context.record({
      taskId: active.id, kind: "assistant_message", role: "assistant",
      content: "active context", createdAt: "2020-01-01T00:00:00.000Z"
    });

    const receipt = context.pruneExpired({ now: new Date("2026-11-07T00:00:00.000Z") });
    expect(receipt.tasksPruned).toBe(1);
    expect(receipt.deletedItems).toBeGreaterThanOrEqual(1);
    expect(context.listItems(expired.id).total).toBe(0);
    expect(context.getState(expired.id)).toBeNull();
    expect(context.listItems(active.id).total).toBe(1);
  });
});

function createRun(service: HearthService, taskId: string, id: string, status: RunRecord["status"] = "running"): RunRecord {
  const now = new Date().toISOString();
  const run: RunRecord = {
    id, taskId, attempt: 1, status, threadId: null, workspace: "workspace", startedAt: now,
    endedAt: status === "completed" ? now : null, failure: null, usage: null, leaseEpoch: null,
    createdAt: now, executorId: "native"
  };
  service.createRun(run);
  return run;
}
