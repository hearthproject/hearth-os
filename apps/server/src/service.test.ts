import { describe, expect, it } from "vitest";
import { HearthStore } from "@hearth/eventlog";
import { HearthService } from "./service.ts";

describe("Hearth service agent metadata", () => {
  it("defaults chat-created tasks to the native executor", () => {
    const store = new HearthStore(":memory:");
    const service = new HearthService(store);
    const task = service.createTask({ title: "整理资料", goal: "整理输入资料" });
    expect(task.executorId).toBe("native");
    expect(task.taskKind).toBe("general");
    expect(task.expectedOutputs).toEqual(["result.md"]);
    store.close();
  });

  it("keeps template tasks on the codex executor", () => {
    const store = new HearthStore(":memory:");
    const service = new HearthService(store);
    const task = service.createTask({ templateId: "T01" });
    expect(task.executorId).toBe("codex");
    expect(task.expectedOutputs).toContain("meeting-notes.md");
    store.close();
  });

  it("confirms a pending proposal into a real task", () => {
    const store = new HearthStore(":memory:");
    const service = new HearthService(store);
    const proposal = service.createTaskProposal({
      conversationId: "conv-1",
      title: "生成周报",
      goal: "根据输入生成周报",
      executorId: "native",
      taskKind: "general",
      expectedOutputs: ["result.md"],
      permissions: { readRoots: ["workspace"], writeRoots: ["out"], networkHosts: [], tools: ["finish_task"] },
      inputs: [{ kind: "text", label: "用户请求", value: "根据输入生成周报" }],
      reason: "需要生成交付物"
    });
    expect(proposal.status).toBe("pending");

    const { proposal: confirmed, task } = service.confirmTaskProposal(proposal.id);
    expect(confirmed.status).toBe("confirmed");
    expect(task.executorId).toBe("native");
    expect(task.conversationId).toBe("conv-1");
    expect(task.inputs).toEqual([{ kind: "text", label: "用户请求", value: "根据输入生成周报" }]);
    store.close();
  });

  it("rejects a pending proposal without creating a task", () => {
    const store = new HearthStore(":memory:");
    const service = new HearthService(store);
    const proposal = service.createTaskProposal({
      conversationId: "conv-2",
      title: "删除资料",
      goal: "删除全部资料",
      executorId: "native",
      taskKind: "general",
      expectedOutputs: ["result.md"],
      permissions: { readRoots: [], writeRoots: [], networkHosts: [], tools: [] },
      reason: "高风险操作"
    });
    expect(service.rejectTaskProposal(proposal.id).status).toBe("rejected");
    expect(service.listTasks()).toHaveLength(0);
    store.close();
  });

  it("projects run checkpoints into the task view", () => {
    const store = new HearthStore(":memory:");
    const service = new HearthService(store);
    const task = service.createTask({ title: "任务", goal: "目标" });
    const now = new Date().toISOString();
    service.createRun({
      id: "run-1", taskId: task.id, attempt: 1, status: "running", threadId: null,
      workspace: "workspace", startedAt: now, endedAt: null, failure: null, usage: null,
      leaseEpoch: 1, createdAt: now, executorId: "native"
    });
    service.createRunCheckpoint({
      id: "cp-1", runId: "run-1", taskId: task.id, seq: 1, kind: "tool",
      path: "workspace/.hearth/checkpoints/1.json", sha256: "a".repeat(64), usage: null, createdAt: now
    });
    expect(service.latestRunCheckpoint("run-1")?.seq).toBe(1);
    expect(service.view(task.id)?.checkpoints).toHaveLength(1);
    store.close();
  });
});
