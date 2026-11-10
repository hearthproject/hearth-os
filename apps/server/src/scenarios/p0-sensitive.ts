import { join } from "node:path";
import { ContextService } from "../context.ts";
import { MemoryService } from "../memory.ts";
import { createTaskWithRun } from "./support.ts";
import { result, withHarness } from "./common.ts";
import type { ScenarioHandler } from "./types.ts";

export const p0SensitiveScenarios: Record<string, ScenarioHandler> = {
  "sensitive-info-containment": async (context) => withHarness(async (service, store) => {
    const contextService = new ContextService(service, join(context.root, "blobs"));
    const task = service.createTask({ title: "处理假用户秘密", goal: "验证敏感信息边界" });
    const run = createTaskWithRun(service, { title: "敏感信息运行", workspace: context.root });
    const secret = context.fakeSecret;
    const item = contextService.record({
      taskId: task.id,
      kind: "tool_result",
      role: "tool",
      content: `调用假 provider 时拿到 api_key=${secret}，Authorization: Bearer ${secret}`,
      provenance: { source: "mock-provider" }
    });
    const memory = new MemoryService(service, context.clock.now);
    const secretMemory = memory.create({
      kind: "project",
      content: `假用户秘密 password=${secret}`,
      subjectKey: "user.secret",
      sensitivity: "secret",
      source: { type: "user", id: context.fakeUser.id, label: "假用户", excerpt: null }
    });
    memory.confirm(secretMemory.id);
    const recall = memory.recall({ taskId: task.id, text: secret });
    const contextEvents = store.listEvents(0, task.id).filter((event) => event.type.startsWith("context."));
    const blob = item.contentRef ? contextService.readBlob(item.contentRef) ?? "" : "";
    const persistedText = JSON.stringify(contextEvents) + JSON.stringify(store.listContextItems(task.id)) + blob;
    context.check("context-redacted", !item.content.includes(secret) && item.content.includes("[REDACTED"), item.content);
    context.check("context-event-redacted", !JSON.stringify(contextEvents).includes(secret), "context 事件日志不得包含秘密");
    context.check("persisted-context-redacted", !persistedText.includes(secret), "持久化上下文和 blob 不得包含秘密");
    context.check("recall-excludes-secret", !recall.contextPack.includes(secret) && !recall.memories.some((memoryItem) => memoryItem.id === secretMemory.id), "秘密记忆不得进入召回包");
    context.check("secret-memory-blocked", memory.snapshot().memories.find((memoryItem) => memoryItem.id === secretMemory.id)?.sensitivity === "secret", "秘密标记必须保留");
    context.record("contextItem", item);
    context.record("contextEvents", contextEvents.map((event) => event.type));
    context.record("recallContext", recall.contextPack);
    context.record("secretMemory", memory.snapshot().memories.find((memoryItem) => memoryItem.id === secretMemory.id) ?? null);
    context.record("run", run.run.id);
    return result(context);
  })
};
