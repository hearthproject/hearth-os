import { describe, expect, it } from "vitest";
import { agentModePrompt, resolveAgentMode, TEAM_AGENT_TYPES, TEAM_RECEIPT_SCHEMA } from "./agent-mode.ts";

describe("agent mode", () => {
  it("keeps native single/team modes and marks other executors as executor-managed", () => {
    expect(resolveAgentMode(undefined, "native")).toEqual({
      requested: "single", effective: "single", executorId: "native"
    });
    expect(resolveAgentMode("team", "native")).toEqual({
      requested: "team", effective: "team", executorId: "native"
    });
    expect(resolveAgentMode("team", "codex")).toEqual({
      requested: "team", effective: "executor-managed", executorId: "codex"
    });
    expect(resolveAgentMode("single", "deepseek-harness")).toEqual({
      requested: "single", effective: "executor-managed", executorId: "deepseek-harness"
    });
  });

  it("only exposes read-only member types in Team v1", () => {
    expect(TEAM_AGENT_TYPES).toEqual(["explore", "plan", "review"]);
    expect(TEAM_AGENT_TYPES).not.toContain("general-purpose");
  });

  it("describes delegation rules for native team mode and a single-agent boundary otherwise", () => {
    const team = agentModePrompt("team", "native");
    expect(team).toContain("explore / plan / review");
    expect(team).toContain("同时最多 4 个");
    expect(team).toContain("累计最多 8 个");
    expect(team).toContain("唯一可以写入");

    const single = agentModePrompt(undefined, "native");
    expect(single).toContain("单智能体模式");
    expect(single).toContain("不要尝试委派");

    const managed = agentModePrompt("team", "codex");
    expect(managed).toContain("自行管理多 agent");
    expect(managed).toContain("不会注入");
    expect(managed).not.toContain("你是 Lead");
  });

  it("keeps the canonical receipt schema evidence-shaped", () => {
    expect(TEAM_RECEIPT_SCHEMA).toMatchObject({
      type: "object",
      required: ["status", "summary", "evidence"]
    });
    const properties = TEAM_RECEIPT_SCHEMA.properties as Record<string, unknown>;
    expect(properties.artifacts).toBeTruthy();
    expect(properties.unresolved).toBeTruthy();
  });
});
