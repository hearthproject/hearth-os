import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HearthStore } from "@hearth/eventlog";
import { HearthService } from "./service.ts";
import { MethodService } from "./methods.ts";
import { ScheduleService } from "./schedules.ts";
import { SkillPackageService } from "./skills.ts";
import { SkillCuratorService } from "./skill-curator.ts";

describe("SkillCuratorService", () => {
  let store: HearthStore;
  let service: HearthService;
  let methods: MethodService;
  let skills: SkillPackageService;
  let curator: SkillCuratorService;
  let root: string;
  let now: Date;

  beforeEach(() => {
    store = new HearthStore(":memory:");
    service = new HearthService(store);
    now = new Date();
    methods = new MethodService(service, () => now);
    root = mkdtempSync(join(tmpdir(), "hearth-skill-curator-"));
    skills = new SkillPackageService(service, methods, { rootDir: root, clock: () => now });
    curator = new SkillCuratorService({ service, skills, clock: () => now });
  });

  afterEach(() => {
    curator.stop();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  function exportedSkill(title = "整理周报") {
    const task = service.createTask({ templateId: "T01", title });
    service.updateTask(task.id, { status: "running", nextAction: "执行中" });
    service.updateTask(task.id, { status: "completed", nextAction: "完成" });
    const method = methods.autoLearnFromTask(task.id);
    if (!method) throw new Error("method missing");
    return skills.exportMethod(method.id);
  }

  it("seeds first, then marks stale and archives with a rollback backup", () => {
    const exported = exportedSkill();
    now = new Date(now.getTime() + 15 * 86_400_000);
    const seeded = curator.run();
    expect(seeded.status).toBe("applied");
    expect(seeded.actions).toEqual([]);
    expect(skills.getSkill(exported.id)?.status).toBe("adopted");

    now = new Date(now.getTime() + 7 * 86_400_000);
    const stale = curator.run();
    expect(stale.actions).toEqual([expect.objectContaining({ skillId: exported.id, to: "stale" })]);
    expect(skills.getSkill(exported.id)?.status).toBe("stale");
    expect(stale.backupPath).not.toBeNull();

    now = new Date(now.getTime() + 8 * 86_400_000);
    const archived = curator.run();
    expect(archived.actions).toEqual([expect.objectContaining({ skillId: exported.id, to: "archived" })]);
    expect(skills.getSkill(exported.id)?.status).toBe("archived");

    const rolledBack = curator.rollback(archived.id);
    expect(rolledBack.status).toBe("rolled_back");
    expect(skills.getSkill(exported.id)?.status).toBe("stale");
  });

  it("never touches pinned, referenced, non-agent, or recently used skills", () => {
    const exported = exportedSkill();
    const schedules = new ScheduleService({ service });
    schedules.create({ name: "引用技能", prompt: "请使用 skill:" + exported.id, cron: "0 9 * * *" });
    now = new Date(now.getTime() + 30 * 86_400_000);
    curator.run();
    expect(skills.getSkill(exported.id)?.status).toBe("adopted");

    const second = exportedSkill("整理月报");
    skills.pin(second.id, true);
    now = new Date(now.getTime() + 7 * 86_400_000);
    curator.run();
    expect(skills.getSkill(second.id)?.status).toBe("adopted");
  });

  it("records usage telemetry and respects the seven-day cadence", () => {
    const exported = exportedSkill();
    const usage = skills.recordUsage({ skillId: exported.id, taskId: null, status: "completed", source: "api", note: "完成" });
    expect(usage).toMatchObject({ skillId: exported.id, status: "completed", source: "api" });
    expect(store.listSkillUsage(exported.id)).toHaveLength(1);

    curator.run();
    now = new Date(now.getTime() + 3 * 86_400_000);
    const early = curator.run();
    expect(early.report).toContain("不足 7 天");
    expect(early.actions).toEqual([]);
  });
});
