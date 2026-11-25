import { describe, expect, it } from "vitest";
import type { TaskRecord } from "@hearth/core";
import {
  PromptRegistry,
  composeTaskPrompt,
  composeTaskPromptSections,
  executionContractPrompt,
  skillRoutingPrompt
} from "./prompts.ts";

const task = {
  id: "task-1",
  title: "Install a skill",
  goal: "Find and install grill-me",
  status: "queued",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  inputs: [],
  networkHosts: [],
  outputDir: ".hearth/artifacts/task-1",
  currentRunId: null,
  nextAction: null,
  error: null
} as unknown as TaskRecord;

describe("prompt registry", () => {
  it("renders sections in priority order and supports replacement", () => {
    const registry = new PromptRegistry([
      { id: "late", priority: 20, build: () => "late" },
      { id: "early", priority: 10, build: () => ["early-a", "early-b"] },
      { id: "empty", priority: 30, build: () => null }
    ]);
    expect(registry.ids()).toEqual(["early", "late", "empty"]);
    expect(registry.render({
      task,
      expectedOutputs: [],
      availableTools: [],
      mode: "build"
    })).toBe("early-a\n\nearly-b\n\nlate");

    registry.register({ id: "late", priority: 5, build: () => "replaced" });
    expect(registry.render({
      task,
      expectedOutputs: [],
      availableTools: [],
      mode: "build"
    })).toContain("replaced");
    expect(registry.remove("early")).toBe(true);
    expect(registry.remove("missing")).toBe(false);
  });

  it("states the autonomous execution contract without product limits", () => {
    expect(executionContractPrompt).toContain("直接完成");
    expect(executionContractPrompt).toContain("预算、轮次、时长和产物数量都没有产品级限制");
    expect(executionContractPrompt).toContain("只在最后返回结果");
    expect(executionContractPrompt).toContain("不要为了满足形式生成 result.md");
  });

  it("routes skill installation through discovery instead of asking the user", () => {
    expect(skillRoutingPrompt(["search_skills", "install_skill"])).toContain("先 search_skills");
    expect(skillRoutingPrompt(["search_skills", "install_skill"])).toContain("不要要求用户提供仓库地址");
    expect(skillRoutingPrompt(["read_file"])).toBeNull();
  });

  it("composes task context with optional goal and extension blocks", () => {
    const prompt = composeTaskPrompt({
      task,
      expectedOutputs: [],
      availableTools: ["finish_task", "search_skills", "install_skill"],
      mode: "build",
      goalBlock: "GOAL BLOCK",
      extraBlocks: ["EXTRA BLOCK"]
    });
    expect(prompt).toContain("当前任务：Install a skill");
    expect(prompt).toContain("没有强制文件产物");
    expect(prompt).toContain("finish_task");
    expect(prompt).toContain("不要要求用户提供仓库地址");
    expect(prompt).toContain("GOAL BLOCK");
    expect(prompt).toContain("EXTRA BLOCK");
  });

  it("exposes the same prompt as labelled sections", () => {
    const context = {
      task,
      expectedOutputs: [],
      availableTools: ["finish_task", "search_skills", "install_skill"],
      mode: "build" as const,
      goalBlock: "GOAL BLOCK",
      extraBlocks: ["EXTRA BLOCK"]
    };
    const sections = composeTaskPromptSections(context);
    expect(sections.map((section) => section.content).join("\n\n")).toBe(composeTaskPrompt(context));
    expect(sections.find((section) => section.id === "identity")?.label).toBe("身份与角色");
    expect(sections.find((section) => section.id === "task")?.label).toBe("任务信息");
    expect(sections.every((section) => section.content.length > 0)).toBe(true);
  });
});
