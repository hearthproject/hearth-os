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
    const conversation = store.createConversation("周报对话");
    const proposal = service.createTaskProposal({
      conversationId: conversation.id,
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
    expect(task.conversationId).toBe(conversation.id);
    expect(task.inputs).toEqual([{ kind: "text", label: "用户请求", value: "根据输入生成周报" }]);
    const messages = store.listChatMessages(conversation.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ kind: "task_status", taskStatus: "queued", taskId: task.id });
    expect(messages[0]?.content).toContain("已确认并排队");
    store.close();
  });

  it("appends one status message per transition and skips duplicate states", () => {
    const store = new HearthStore(":memory:");
    const service = new HearthService(store);
    const conversation = store.createConversation("状态对话");
    const task = service.createTask({ title: "状态任务", goal: "验证状态回复", conversationId: conversation.id });
    expect(store.listChatMessages(conversation.id)).toHaveLength(0);

    service.updateTask(task.id, { status: "running", nextAction: "读取输入" });
    service.updateTask(task.id, { status: "running", nextAction: "处理输入" });
    let messages = store.listChatMessages(conversation.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ kind: "task_status", taskStatus: "running", taskId: task.id });
    expect(messages[0]?.content).toContain("开始执行");

    service.updateTask(task.id, { status: "completed", resultSummary: "已经生成完整结果。" });
    messages = store.listChatMessages(conversation.id);
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({ kind: "task_status", taskStatus: "completed" });
    expect(messages[1]?.content).toContain("已经生成完整结果");
    store.close();
  });

  it("does not append status messages for tasks without a conversation", () => {
    const store = new HearthStore(":memory:");
    const service = new HearthService(store);
    const task = service.createTask({ title: "无对话任务", goal: "不产生聊天消息" });
    service.updateTask(task.id, { status: "running" });
    expect(store.listChatMessages("missing")).toHaveLength(0);
    expect(store.listEvents().some((event) => event.type === "chat.message.created")).toBe(false);
    store.close();
  });

  it("reroutes proposal confirmation when its executor was disabled", () => {
    const store = new HearthStore(":memory:");
    const service = new HearthService(store);
    const conversation = store.createConversation("改派对话", {
      executorEnabled: { native: false, codex: true, hermes: true },
      approvalMode: "necessary"
    });
    const proposal = service.createTaskProposal({
      conversationId: conversation.id,
      title: "工程任务",
      goal: "修复 TypeScript 错误",
      executorId: "native",
      taskKind: "workspace",
      expectedOutputs: ["result.md"],
      permissions: { readRoots: ["workspace"], writeRoots: ["workspace"], networkHosts: [], tools: [] },
      reason: "需要改代码"
    });
    const { task } = service.confirmTaskProposal(proposal.id);
    expect(task.executorId).toBe("codex");
    expect(store.listChatMessages(conversation.id).at(-1)?.content).toContain("已自动改由 Codex 执行器 接管");
    store.close();
  });

  it("refuses proposal confirmation when both executors are disabled", () => {
    const store = new HearthStore(":memory:");
    const service = new HearthService(store);
    const conversation = store.createConversation("全关对话", {
      executorEnabled: { native: false, codex: false, hermes: false },
      approvalMode: "necessary"
    });
    const proposal = service.createTaskProposal({
      conversationId: conversation.id,
      title: "不能确认",
      goal: "验证执行器全关",
      executorId: "native",
      taskKind: "general",
      expectedOutputs: ["result.md"],
      permissions: { readRoots: [], writeRoots: [], networkHosts: [], tools: [] },
      reason: "测试"
    });
    expect(() => service.confirmTaskProposal(proposal.id)).toThrow("所有执行器都已关闭");
    store.close();
  });

  it("marks full-permission approvals as auto-approved in status messages", () => {
    const store = new HearthStore(":memory:");
    const service = new HearthService(store);
    const conversation = store.createConversation("完全权限对话", {
      executorEnabled: { native: true, codex: true, hermes: true },
      approvalMode: "full"
    });
    const task = service.createTask({ title: "外部动作", goal: "发布动作", conversationId: conversation.id });
    service.updateTask(task.id, { status: "running" });
    service.updateTask(task.id, { status: "waiting_approval", nextAction: "发布 PR" });
    const last = store.listChatMessages(conversation.id).at(-1);
    expect(last).toMatchObject({ kind: "task_status", taskStatus: "waiting_approval" });
    expect(last?.content).toContain("完全权限已开启");
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
