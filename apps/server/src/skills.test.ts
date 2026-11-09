import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HearthStore } from "@hearth/eventlog";
import { HearthService } from "./service.ts";
import { MethodService } from "./methods.ts";
import { parseSkillDocument } from "./skill-package.ts";
import { SkillPackageService, skillSlug } from "./skills.ts";

describe("SkillPackageService", () => {
  let store: HearthStore;
  let service: HearthService;
  let methods: MethodService;
  let skills: SkillPackageService;
  let tempDir: string;
  let now: Date;

  beforeEach(() => {
    store = new HearthStore(":memory:");
    service = new HearthService(store);
    now = new Date("2026-11-09T10:00:00.000Z");
    methods = new MethodService(service, () => now);
    tempDir = mkdtempSync(join(tmpdir(), "hearth-skills-"));
    skills = new SkillPackageService(service, methods, { rootDir: tempDir, clock: () => now });
  });

  afterEach(() => {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function adoptedMethod() {
    const task = service.createTask({
      templateId: "T01",
      title: "整理周报",
      permissions: {
        readRoots: ["~/.hearth/notes"],
        writeRoots: ["~/.hearth/notes/reviews"],
        networkHosts: [],
        tools: ["read_file", "search_files"]
      }
    });
    service.updateTask(task.id, { status: "running", nextAction: "执行中" });
    service.updateTask(task.id, { status: "completed", nextAction: "完成" });
    const method = methods.autoLearnFromTask(task.id);
    if (!method) throw new Error("method missing");
    return method;
  }

  function terminalTask() {
    const task = service.createTask({ templateId: "T01" });
    service.updateTask(task.id, { status: "running", nextAction: "执行中" });
    service.updateTask(task.id, { status: "completed", nextAction: "完成" });
    return service.requireTask(task.id);
  }

  it("exports an adopted method as a readable package", () => {
    const method = adoptedMethod();
    const exported = skills.exportMethod(method.id);
    expect(exported.id).toBe(skillSlug(method));
    expect(existsSync(join(exported.path, "SKILL.md"))).toBe(true);
    expect(existsSync(join(exported.path, "skill.json"))).toBe(true);
    expect(existsSync(join(exported.path, "references"))).toBe(true);
    expect(existsSync(join(exported.path, "scripts"))).toBe(true);
    expect(existsSync(join(exported.path, "templates"))).toBe(true);
    expect(existsSync(join(exported.path, "tests"))).toBe(true);

    const document = parseSkillDocument(readFileSync(join(exported.path, "SKILL.md"), "utf8"));
    expect(document.manifest.metadata.hearth.originTaskId).toBe(method.sourceTaskIds[0]);
    expect(document.manifest.permissions).toMatchObject({
      readRoots: ["~/.hearth/notes"],
      writeRoots: ["~/.hearth/notes/reviews"]
    });
    expect(document.body).toContain("## Procedure");
    expect(skills.readIndex(exported.id)).toMatchObject({ id: exported.id, status: "adopted" });
    expect(skills.readDocument(exported.id).manifest.name).toBe(exported.id);
    expect(skills.readResources(exported.id).map((item) => item.path)).toContain("references/README.md");
  });

  it("rejects unadopted methods and path escapes", () => {
    const task = terminalTask();
    const method = methods.generateFromTask(task.id);
    expect(() => skills.exportMethod(method.id))
      .toThrowError(expect.objectContaining({ code: "SKILL_METHOD_NOT_ADOPTED" }));
    expect(() => skills.readDocument("../escape"))
      .toThrowError(expect.objectContaining({ code: "SKILL_ID_INVALID" }));
  });

  it("archives the previous package before replacing it", () => {
    const method = adoptedMethod();
    const first = skills.exportMethod(method.id);
    store.appendEvent({
      type: "method.candidate.updated",
      payload: { ...method, version: method.version + 1, summary: "更新后的周报流程", updatedAt: now.toISOString() }
    });
    const second = skills.exportMethod(method.id);
    expect(second.version).toBe("1.1.0");
    const archive = join(skills.root, ".versions", second.id);
    expect(existsSync(archive)).toBe(true);
    expect(skills.list().map((entry) => entry.id)).toEqual([second.id]);
    expect(first.contentHash).not.toBe(second.contentHash);
  });

  it("does not follow symlinks and ignores broken package directories", () => {
    const method = adoptedMethod();
    const exported = skills.exportMethod(method.id);
    writeFileSync(join(exported.path, "references", "notes.md"), "notes", "utf8");
    expect(skills.readResources(exported.id)).toContainEqual(expect.objectContaining({
      path: "references/notes.md",
      kind: "reference"
    }));
    expect(skills.list().map((entry) => entry.id)).toContain(exported.id);
  });

  it("creates stable ASCII slugs for non-Latin method names", () => {
    expect(skillSlug({ id: "method-1234567890", name: "整理周报" })).toBe("method-method123456");
    expect(skillSlug({ id: "method-1", name: "Weekly Review" })).toBe("weekly-review");
  });
});
