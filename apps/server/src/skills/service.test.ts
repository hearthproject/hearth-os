import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HearthStore } from "@hearth/eventlog";
import { SkillError, SkillService, parseSkillSource } from "./service.ts";

describe("SkillService", () => {
  let temp: string;
  let source: string;
  let store: HearthStore;

  beforeEach(() => {
    temp = mkdtempSync(join(tmpdir(), "hearth-skills-"));
    source = join(temp, "source", "writing-helper");
    mkdirSync(join(source, "references"), { recursive: true });
    writeFileSync(join(source, "SKILL.md"), [
      "---",
      "name: Writing Helper",
      "description: 帮用户整理中文写作结构。",
      "version: 1.2.0",
      "category: 写作",
      "platforms: [windows, macos, linux]",
      "allowed-tools: read_file, write_file",
      "---",
      "# Writing Helper",
      "",
      "先整理提纲，再给正文。"
    ].join("\n"), "utf8");
    writeFileSync(join(source, "references", "guide.md"), "写作指南", "utf8");
    writeFileSync(join(source, ".env"), "SECRET=should-not-copy", "utf8");
    store = new HearthStore(":memory:");
  });

  afterEach(() => {
    store.close();
    rmSync(temp, { recursive: true, force: true });
  });

  it("installs a local skill into the managed directory and records metadata", async () => {
    const skills = new SkillService({ store, root: join(temp, "managed") });
    const result = await skills.install({ source });

    expect(result.skill.name).toBe("Writing Helper");
    expect(result.skill.version).toBe("1.2.0");
    expect(result.skill.manifest.metadata.hearth.category).toBe("写作");
    expect(result.skill.manifest.tools).toEqual(["read_file", "write_file"]);
    expect(result.skill.path.startsWith(join(temp, "managed"))).toBe(true);
    expect(store.getSkill(result.skill.id)?.sourceUrl).toMatch(/^file:/);
    expect(store.getSkill(result.skill.id)?.actions).toEqual([]);
    expect(skills.list()).toHaveLength(1);
    expect(skills.use(result.skill.id).prompt).toContain("先整理提纲");
  });

  it("updates only when asked and keeps the previous version", async () => {
    const skills = new SkillService({ store, root: join(temp, "managed") });
    const installed = await skills.install({ source });
    const first = store.getSkill(installed.skill.id)!;

    writeFileSync(join(source, "SKILL.md"), [
      "---",
      "name: Writing Helper",
      "description: 新版写作流程。",
      "version: 1.3.0",
      "category: 写作",
      "---",
      "# Writing Helper",
      "",
      "先写摘要，再写正文。"
    ].join("\n"), "utf8");

    expect(store.getSkill(installed.skill.id)?.contentHash).toBe(first.contentHash);
    const updated = await skills.update(installed.skill.id);
    expect(updated.changed).toBe(true);
    expect(updated.skill.version).toBe("1.3.0");
    expect(updated.skill.contentHash).not.toBe(first.contentHash);
    expect(store.listSkillVersions(installed.skill.id)).toHaveLength(1);
    expect(skills.use(installed.skill.id).prompt).toContain("先写摘要");
  });

  it("does not follow or copy sensitive files", async () => {
    const skills = new SkillService({ store, root: join(temp, "managed") });
    const installed = await skills.install({ source });
    const files = readdirSync(installed.skill.path);
    expect(files).not.toContain(".env");
    expect(files).toContain("references");
  });

  it("removes the managed copy and database record", async () => {
    const skills = new SkillService({ store, root: join(temp, "managed") });
    const installed = await skills.install({ source });
    skills.remove(installed.skill.id);
    expect(store.getSkill(installed.skill.id)).toBeNull();
    expect(skills.list()).toHaveLength(0);
  });

  it("rejects a source without SKILL.md", async () => {
    const skills = new SkillService({ store, root: join(temp, "managed") });
    const empty = join(temp, "empty");
    mkdirSync(empty);
    await expect(skills.install({ source: empty })).rejects.toMatchObject({ code: "SKILL_DOCUMENT_REQUIRED" } satisfies Partial<SkillError>);
  });

  it("parses GitHub repository and tree links", () => {
    expect(parseSkillSource("https://github.com/acme/skills")).toMatchObject({ kind: "github", ref: null, path: null });
    expect(parseSkillSource("https://github.com/acme/skills/tree/main/writing")).toMatchObject({
      kind: "github",
      ref: "main",
      path: "writing"
    });
  });
});
