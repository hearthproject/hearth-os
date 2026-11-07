import { describe, expect, it } from "vitest";
import { decideRoute, heuristicRoute } from "./chat.ts";
import type { ModelSettings } from "./model-settings.ts";

const NO_MODEL: ModelSettings = {
  providerId: "custom",
  providerName: "Custom",
  protocol: "openai-chat",
  baseUrl: "",
  model: "",
  apiKey: "",
  updatedAt: null
};

describe("chat routing heuristics", () => {
  it.each([
    "怎么测试这个函数",
    "如何修复这个 bug",
    "为什么接口会超时",
    "什么是幂等性",
    "介绍一下这个项目"
  ])("keeps method and explanation questions in chat: %s", (message) => {
    expect(heuristicRoute(message).action).toBe("chat");
  });

  it.each([
    "帮我测试这个函数",
    "帮我修复这个 bug",
    "帮我写一份周报",
    "帮我总结这个附件"
  ])("routes imperative work to a task: %s", (message) => {
    expect(heuristicRoute(message).action).toBe("task");
  });

  it("forces attachment messages to a task because chat cannot read attachment content", async () => {
    const route = await decideRoute("", true, null, NO_MODEL);
    expect(route.action).toBe("task");
    expect(route.reason).toContain("附件");
  });

  it("keeps URL-only context on the normal heuristic path", async () => {
    const route = await decideRoute("介绍一下这个网页 https://example.com/article", false, "https://example.com/article", NO_MODEL);
    expect(route.action).toBe("chat");
  });
});