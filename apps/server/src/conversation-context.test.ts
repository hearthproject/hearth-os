import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatMessageRecord, ConversationContextSummary } from "@hearth/core";
import { defaultConversationSettings } from "@hearth/core";
import { HearthStore } from "@hearth/eventlog";
import { ContextService } from "./context.ts";
import { ConversationContextService } from "./conversation-context.ts";
import { HearthService } from "./service.ts";
import type { ModelSettings } from "./model-settings.ts";

describe("ConversationContextService", () => {
  let root: string | null = null;
  let store: HearthStore | null = null;

  afterEach(() => {
    store?.close();
    store = null;
    if (root) rmSync(root, { recursive: true, force: true });
    root = null;
  });

  function setup(summary?: ConversationContextSummary) {
    root = mkdtempSync(join(tmpdir(), "hearth-conversation-context-"));
    store = new HearthStore(":memory:");
    const service = new HearthService(store);
    const context = new ContextService(service, join(root, "blobs"));
    const conversationContext = new ConversationContextService({
      service,
      context,
      modelSettings: () => ({
        providerId: "test",
        providerName: "Test",
        protocol: "openai-chat",
        baseUrl: "https://example.com/v1",
        model: "test",
        contextWindowTokens: 16_000,
        maxOutputTokens: 2_000,
        apiKey: "sk-test",
        updatedAt: null
      } satisfies ModelSettings),
      summaryGenerator: summary
        ? async () => JSON.stringify(summary)
        : async () => JSON.stringify({
          goal: "把上下文共享给所有执行器",
          constraints: ["不升级版本", "直接改 main"],
          facts: [{ key: "branch", value: "main", source: "user", asOf: "2026-11-24" }],
          decisions: [{ decision: "一条对话总线", rationale: "私有 thread 不能合并", source: "user" }],
          completed: [],
          blockers: [],
          nextSteps: ["注入 scheduler"],
          openQuestions: []
        } satisfies ConversationContextSummary)
    });
    return { service, context, conversationContext, store };
  }

  function message(
    conversationId: string,
    role: "user" | "assistant",
    content: string,
    taskId: string | null = null
  ): ChatMessageRecord {
    return {
      id: randomUUID(),
      conversationId,
      role,
      content,
      taskId,
      attachments: [],
      createdAt: new Date().toISOString()
    };
  }

  it("renders the same shared brief for every executor without leaking the current user message", async () => {
    const { service, conversationContext } = setup();
    const conversation = store!.createConversation("共享上下文", defaultConversationSettings());
    const first = service.createTask({
      title: "查 GitHub PR",
      goal: "看看我的 GitHub 项目有几个开着的 PR",
      conversationId: conversation.id,
      executorId: "codex"
    });
    service.updateTask(first.id, { status: "running" });
    service.updateTask(first.id, { status: "completed", resultSummary: "161 个仓库，1 个 open PR：JasonBuildAI/GoldMind#22" });
    const oldUser = message(conversation.id, "user", "看看我的 GitHub 项目有几个开着的 PR");
    const oldAssistant = message(conversation.id, "assistant", "有 1 个开着的 PR", first.id);
    const currentUser = message(conversation.id, "user", "为我直接合并 goldmind 这个 PR");
    service.appendChatMessage(oldUser);
    service.appendChatMessage(oldAssistant);
    service.appendChatMessage(currentUser);
    const second = service.createTask({
      title: "合并 PR",
      goal: "为我直接合并 goldmind 这个 PR",
      conversationId: conversation.id,
      executorId: "native"
    });

    const brief = await conversationContext.renderForTask(conversation.id, second.id, currentUser.id);
    expect(brief.text).toContain("<hearth-conversation-context");
    expect(brief.text).toContain("JasonBuildAI/GoldMind#22");
    expect(brief.text).not.toContain("为我直接合并 goldmind 这个 PR");
    expect(brief.text).not.toContain("有 1 个开着的 PR");
  });

  it("compacts old tail into a structured summary and keeps recent messages", async () => {
    const { service, conversationContext } = setup();
    const conversation = store!.createConversation("压缩", defaultConversationSettings());
    const oldMessages = Array.from({ length: 18 }, (_, index) => message(
      conversation.id,
      index % 2 === 0 ? "user" : "assistant",
      `OLD-${index}-${"x".repeat(4_000)}`
    ));
    for (const item of oldMessages) service.appendChatMessage(item);
    const recentUser = message(conversation.id, "user", "RECENT-USER");
    const recentAssistant = message(conversation.id, "assistant", "RECENT-ASSISTANT");
    service.appendChatMessage(recentUser);
    service.appendChatMessage(recentAssistant);

    const compaction = await conversationContext.compactNow(conversation.id, "manual");
    expect(compaction?.status).toBe("completed");
    expect(compaction?.model).toBe("injected");
    const state = store!.getConversationContextState(conversation.id);
    expect(state?.version).toBe(1);
    expect(state?.summary).toContain("把上下文共享给所有执行器");
    expect(state?.summary).toContain("main");
    expect(state?.firstKeptMessageId).not.toBeNull();
    expect(state?.tokensAfter ?? 0).toBeGreaterThan(0);

    const chat = await conversationContext.renderForChat(conversation.id);
    expect(chat.summaryText).toContain("<hearth-conversation-summary");
    expect(chat.history.some((item) => item.content === "RECENT-USER")).toBe(true);
    expect(chat.history.some((item) => item.content.startsWith("OLD-0-"))).toBe(false);
    expect(chat.history.some((item) => item.id === state?.firstKeptMessageId)).toBe(true);

    const again = await conversationContext.compactNow(conversation.id, "manual");
    expect(again).toBeNull();
    expect(store!.getConversationContextState(conversation.id)?.version).toBe(1);
  });

  it("does not re-compact when the summary plus live tail is under the threshold", async () => {
    const { service, conversationContext } = setup();
    const conversation = store!.createConversation("阈值", defaultConversationSettings());
    for (let index = 0; index < 18; index += 1) {
      service.appendChatMessage(message(conversation.id, index % 2 === 0 ? "user" : "assistant", `THR-${index}-${"z".repeat(4_000)}`));
    }
    const first = await conversationContext.compactNow(conversation.id, "manual");
    expect(first?.status).toBe("completed");
    expect(store!.getConversationContextState(conversation.id)?.version).toBe(1);

    const result = await conversationContext.compactIfNeeded(conversation.id, "auto", {
      budgetTokens: 10_000,
      thresholdTokens: 5_000,
      keepTokens: 2_400,
      summaryMaxTokens: 1_000
    });
    expect(result).toBeNull();
    expect(store!.getConversationContextState(conversation.id)?.version).toBe(1);
  });

  it("summarizes only messages after the boundary when firstKeptMessageId is null", async () => {
    const { service, conversationContext } = setup();
    const conversation = store!.createConversation("边界", defaultConversationSettings());
    const messages = Array.from({ length: 18 }, (_, index) => ({
      ...message(conversation.id, index % 2 === 0 ? "user" : "assistant", `EDGE-${index}-${"w".repeat(4_000)}`),
      createdAt: `2026-11-24T10:00:${String(index).padStart(2, "0")}.000Z`
    }));
    for (const item of messages) service.appendChatMessage(item);
    store!.saveConversationContextState({
      conversationId: conversation.id,
      version: 1,
      summary: "此前摘要",
      summaryData: null,
      firstKeptMessageId: null,
      lastSummarizedAt: messages[9]!.createdAt,
      tokensBefore: 0,
      tokensAfter: 0,
      lastUsage: null,
      updatedAt: "2026-11-24T10:00:00.000Z"
    });

    const compaction = await conversationContext.compactNow(conversation.id, "manual");
    expect(compaction?.status).toBe("completed");
    const covered = new Set(compaction?.coveredMessageIds ?? []);
    for (const item of messages.slice(0, 10)) expect(covered.has(item.id)).toBe(false);
    expect(messages.slice(10).some((item) => covered.has(item.id))).toBe(true);
  });

  it("merges previous facts and completed tasks when the summary model omits them", async () => {
    const { service, conversationContext } = setup();
    const conversation = store!.createConversation("合并", defaultConversationSettings());
    const task = service.createTask({ title: "旧任务", goal: "旧目标", conversationId: conversation.id });
    service.updateTask(task.id, { status: "running" });
    service.updateTask(task.id, { status: "completed", resultSummary: "旧结论" });
    for (let index = 0; index < 18; index += 1) {
      service.appendChatMessage(message(
        conversation.id,
        index % 2 === 0 ? "user" : "assistant",
        `MERGE-${index}-${"y".repeat(4_000)}`
      ));
    }
    await conversationContext.compactNow(conversation.id, "manual");
    const state = store!.getConversationContextState(conversation.id);
    expect(state?.summaryData?.completed.some((item) => item.taskId === task.id)).toBe(true);
  });

  it("persists measured prompt usage and never lets an estimate overwrite it", async () => {
    const { conversationContext, store } = setup();
    const conversation = store!.createConversation("用量", defaultConversationSettings());
    const measured = conversationContext.rememberUsage(conversation.id, {
      inputTokens: 42_000,
      outputTokens: 900,
      contextWindowTokens: 1_000_000,
      model: "deepseek-flash",
      source: "measured",
      scope: "chat",
      breakdown: { system: 4_000, history: 38_000 },
      measuredAt: "2026-11-24T09:00:00.000Z"
    });
    expect(measured.inputTokens).toBe(42_000);
    expect(store!.getConversationContextState(conversation.id)?.lastUsage).toMatchObject({
      inputTokens: 42_000,
      source: "measured",
      contextWindowTokens: 1_000_000
    });

    const rejected = conversationContext.rememberUsage(conversation.id, {
      inputTokens: 177,
      outputTokens: 0,
      contextWindowTokens: 1_000_000,
      model: "deepseek-flash",
      source: "estimated",
      scope: "chat",
      breakdown: { history: 177 },
      measuredAt: "2026-11-24T09:01:00.000Z"
    });
    expect(rejected.inputTokens).toBe(42_000);
    expect(store!.getConversationContextState(conversation.id)?.lastUsage?.inputTokens).toBe(42_000);
  });
});
