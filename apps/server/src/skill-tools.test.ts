import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HearthStore } from "@hearth/eventlog";
import type { TaskPermissions } from "@hearth/core";
import { createAgentState } from "@hearth/agent-runtime";
import { createSkillTools } from "./skill-tools.ts";
import { SkillService } from "./skills/service.ts";

describe("native skill tools", () => {
  let root: string;
  let store: HearthStore;
  let skills: SkillService;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "hearth-skill-tools-"));
    const source = join(root, "source", "writing-helper");
    mkdirSync(join(source, "references"), { recursive: true });
    writeFileSync(join(source, "SKILL.md"), [
      "---",
      "name: Writing Helper",
      "description: organize Chinese writing",
      "version: 1.0.0",
      "category: writing",
      "platforms: [windows, macos, linux]",
      "allowed-tools: read_file",
      "---",
      "# Writing Helper",
      "",
      "Build an outline before drafting."
    ].join("\n"), "utf8");
    writeFileSync(join(source, "references", "guide.md"), "写作指南", "utf8");
    store = new HearthStore(":memory:");
    skills = new SkillService({ store, root: join(root, "managed") });
    await skills.install({ source });
  });

  afterEach(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("loads a skill prompt and reads only resources of active skills", async () => {
    const tools = createSkillTools({ skills, taskId: "task-1", runId: "run-1" });
    const load = tools.find((tool) => tool.definition.name === "load_skill")!;
    const read = tools.find((tool) => tool.definition.name === "read_skill_resource")!;
    const state = createAgentState(root);
    const context = {
      workspaceRoot: root,
      outDir: join(root, "out"),
      permissions: permissions(root),
      signal: new AbortController().signal,
      state
    };

    const skillId = skills.list()[0]!.id;
    await expect(read.execute({ skill: skillId, path: "references/guide.md" }, context)).rejects.toThrow("尚未加载");
    const loaded = await load.execute({ skill: "Writing Helper" }, context);
    expect(loaded.content).toContain("Build an outline before drafting");
    expect(state.activeSkills).toContain(skillId);

    const resource = await read.execute({ skill: skillId, path: "references/guide.md" }, context);
    expect(resource.content).toBe("写作指南");
    await expect(read.execute({ skill: skillId, path: "../outside.md" }, context)).rejects.toThrow("超出 Skill 目录");
  });
});

function permissions(root: string): TaskPermissions {
  return { tools: ["load_skill", "read_skill_resource"], readRoots: [root], writeRoots: [root], networkHosts: [] };
}
