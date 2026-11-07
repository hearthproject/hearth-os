import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ArtifactRecord, RunRecord } from "@hearth/core";
import { HearthStore } from "@hearth/eventlog";
import { ContextService, estimateTokens } from "./context.ts";
import { ContextProjector } from "./context-projector.ts";
import { HearthService } from "./service.ts";

describe("ContextProjector", () => {
  let root: string | null = null;
  let store: HearthStore | null = null;

  afterEach(() => {
    store?.close();
    store = null;
    if (root) rmSync(root, { recursive: true, force: true });
    root = null;
  });

  it("keeps summary, artifacts, failure evidence and memory while trimming low-value context", () => {
    root = mkdtempSync(join(tmpdir(), "hearth-projector-"));
    store = new HearthStore(":memory:");
    const service = new HearthService(store);
    const context = new ContextService(service, join(root, "blobs"));
    const projector = new ContextProjector(service, context);
    const task = service.createTask({ title: "project", goal: "生成报告", expectedOutputs: ["report.md"] });
    const run = createRun(service, task.id);
    const artifact: ArtifactRecord = {
      id: "artifact-1", taskId: task.id, runId: run.id, relativePath: "report.md",
      absolutePath: join(root, "report.md"), mimeType: "text/markdown",
      sha256: "d".repeat(64), bytes: 100, createdAt: new Date().toISOString()
    };
    service.publishArtifact(artifact);
    for (let index = 0; index < 12; index += 1) {
      context.record({
        taskId: task.id, runId: run.id, executorId: "native", kind: "tool_result", role: "tool",
        content: `TOOL_${index}_BEGIN ${"x".repeat(2000)} TOOL_${index}_END`,
        executorEventId: `tool:${index}`
      });
    }
    context.record({
      taskId: task.id, runId: run.id, executorId: "native", kind: "failure", role: "system",
      content: "关键失败证据：缺少 report.md", executorEventId: "failure:1"
    });
    context.refreshSummary(task.id);

    const projected = projector.project({
      taskId: task.id,
      fromRunId: run.id,
      fromExecutor: "native",
      toExecutor: "codex",
      remainingBudget: { maxTurns: 5, maxToolCalls: 10, maxTokens: 50_000, maxDurationMs: 60_000 },
      purpose: "handoff",
      maxTokens: 1500,
      memoryContext: "长期记忆标记：用户偏好简洁报告"
    });

    expect(projected.prompt).toContain("## 长期记忆（不可信参考）");
    expect(projected.prompt).toContain("用户偏好简洁报告");
    expect(projected.prompt).toContain("report.md");
    expect(projected.prompt).toContain("d".repeat(16));
    expect(projected.prompt).toContain("关键失败证据");
    expect(projected.prompt).not.toContain("TOOL_0_BEGIN");
    expect(estimateTokens(projected.prompt)).toBeLessThanOrEqual(1500);
    expect(projected.messages).toHaveLength(2);
  });

  it("lists previously written files and created branches in doNotRepeat", () => {
    root = mkdtempSync(join(tmpdir(), "hearth-projector-"));
    store = new HearthStore(":memory:");
    const service = new HearthService(store);
    const context = new ContextService(service, join(root, "blobs"));
    const projector = new ContextProjector(service, context);
    const task = service.createTask({ title: "branch task", goal: "edit files" });
    const run = createRun(service, task.id);
    context.record({
      taskId: task.id, runId: run.id, executorId: "codex", kind: "tool_call", role: "assistant",
      content: "git checkout -b feat/handoff", provenance: { source: "codex" }, executorEventId: "codex:1"
    });
    context.record({
      taskId: task.id, runId: run.id, executorId: "codex", kind: "tool_result", role: "tool",
      content: "M src/a.ts", provenance: {
        source: "codex", itemType: "file_change", paths: [{ kind: "update", path: "src/a.ts" }]
      }, executorEventId: "codex:2"
    });
    context.record({
      taskId: task.id, runId: run.id, executorId: "codex", kind: "artifact", role: "system",
      content: "report.md", provenance: { path: "report.md" }, executorEventId: "artifact:1"
    });

    const packet = projector.buildPacket({
      taskId: task.id,
      fromRunId: run.id,
      fromExecutor: "native",
      toExecutor: "codex",
      remainingBudget: { maxTurns: 5, maxToolCalls: 10, maxTokens: 50_000, maxDurationMs: 60_000 }
    });
    expect(packet.doNotRepeat.join("\n")).toContain("feat/handoff");
    expect(packet.doNotRepeat.join("\n")).toContain("src/a.ts");
    expect(packet.doNotRepeat.join("\n")).toContain("report.md");
  });
});

function createRun(service: HearthService, taskId: string): RunRecord {
  const now = new Date().toISOString();
  const run: RunRecord = {
    id: "run-1", taskId, attempt: 1, status: "completed", threadId: null, workspace: "workspace",
    startedAt: now, endedAt: now, failure: null, usage: null, leaseEpoch: null, createdAt: now,
    executorId: "native"
  };
  service.createRun(run);
  return run;
}
