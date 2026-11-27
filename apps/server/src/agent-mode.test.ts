import { describe, expect, it } from "vitest";
import type { ExecutorTeamCapability } from "@hearth/core";
import { agentModePrompt, resolveAgentMode, TEAM_AGENT_TYPES, TEAM_RECEIPT_SCHEMA } from "./agent-mode.ts";

const hearthCapability: ExecutorTeamCapability = {
  owner: "hearth",
  single: "enforced",
  team: "managed",
  state: "available",
  visibility: "members",
  limits: { maxConcurrent: 4, maxTotal: 8, maxDepth: 2 }
};

const codexCapability: ExecutorTeamCapability = {
  owner: "codex",
  single: "enforced",
  team: "native",
  state: "available",
  visibility: "none",
  limits: { maxConcurrent: 4, maxTotal: 4, maxDepth: 1 }
};

const dshCapability: ExecutorTeamCapability = {
  owner: "deepseek-harness",
  single: "enforced",
  team: "native",
  state: "available",
  visibility: "session-tree",
  limits: { maxConcurrent: 8, maxTotal: 8 }
};

describe("agent mode", () => {
  it("keeps native single/team modes", () => {
    const single = resolveAgentMode(undefined, "native", { capability: hearthCapability });
    expect(single).toMatchObject({ requested: "single", effective: "single", executorId: "native", owner: "hearth", degraded: false });

    const team = resolveAgentMode("team", "native", { capability: hearthCapability, taskMode: "build" });
    expect(team).toMatchObject({ requested: "team", effective: "team", executorId: "native", owner: "hearth", guarantee: "managed" });
  });

  it("keeps external executors as native teams with their own visibility", () => {
    const codex = resolveAgentMode("team", "codex", { capability: codexCapability });
    expect(codex).toMatchObject({ effective: "team", owner: "codex", guarantee: "native", visibility: "none" });

    const dsh = resolveAgentMode("team", "deepseek-harness", { capability: dshCapability });
    expect(dsh).toMatchObject({ effective: "team", owner: "deepseek-harness", visibility: "session-tree" });
  });

  it("keeps the Team switch active while planning", () => {
    const plan = resolveAgentMode("team", "native", { capability: hearthCapability, taskMode: "plan" });
    expect(plan).toMatchObject({ requested: "team", effective: "team", degraded: false, owner: "hearth" });
    expect(Object.hasOwn(plan, "forcedBy")).toBe(false);
  });

  it("degrades instead of pretending when the executor cannot run a team", () => {
    const unavailable: ExecutorTeamCapability = {
      ...codexCapability,
      state: "unavailable",
      reason: "Codex 0.100.0 不支持原生多 Agent"
    };
    const resolution = resolveAgentMode("team", "codex", { capability: unavailable });
    expect(resolution).toMatchObject({
      requested: "team",
      effective: "single",
      degraded: true,
      capability: "unavailable"
    });
    expect(resolution.reason).toContain("不支持原生多 Agent");
    expect(agentModePrompt(resolution)).toContain("团队请求未生效");
  });

  it("only exposes read-only member types in Team v1", () => {
    expect(TEAM_AGENT_TYPES).toEqual(["explore", "plan", "review"]);
    expect(TEAM_AGENT_TYPES).not.toContain("general-purpose");
  });

  it("describes delegation rules for native team mode and a single-agent boundary otherwise", () => {
    const team = agentModePrompt(resolveAgentMode("team", "native", { capability: hearthCapability }));
    expect(team).toContain("explore / plan / review");
    expect(team).toContain("同时最多 4 个");
    expect(team).toContain("累计最多 8 个");
    expect(team).toContain("唯一可以写入");

    const single = agentModePrompt(resolveAgentMode(undefined, "native", { capability: hearthCapability }));
    expect(single).toContain("单智能体模式");
    expect(single).toContain("不要尝试委派");

    const codexTeam = agentModePrompt(resolveAgentMode("team", "codex", { capability: codexCapability }));
    expect(codexTeam).toContain("Codex 原生多 Agent 已开启");
    expect(codexTeam).toContain("收不到 Codex 的成员事件");
    expect(codexTeam).not.toContain("你是 Lead");

    const codexSingle = agentModePrompt(resolveAgentMode("single", "codex", { capability: codexCapability }));
    expect(codexSingle).toContain("features.multi_agent=false");
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
