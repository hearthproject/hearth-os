import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HearthStore } from "@hearth/eventlog";
import { buildServer } from "./app.ts";
import { HearthService } from "./service.ts";
import { MethodService } from "./methods.ts";

describe("skills API", () => {
  let store: HearthStore;
  let skillRoot: string;

  beforeEach(() => {
    store = new HearthStore(":memory:");
    skillRoot = mkdtempSync(join(tmpdir(), "hearth-skills-api-"));
  });

  afterEach(() => {
    store.close();
    rmSync(skillRoot, { recursive: true, force: true });
  });

  function adoptedMethod() {
    const service = new HearthService(store);
    const task = service.createTask({ templateId: "T01", title: "整理周报" });
    service.updateTask(task.id, { status: "running", nextAction: "执行中" });
    service.updateTask(task.id, { status: "completed", nextAction: "完成" });
    const methods = new MethodService(service);
    const method = methods.autoLearnFromTask(task.id);
    if (!method) throw new Error("method missing");
    return method;
  }

  it("exports, inspects, pins, archives, and restores skills", async () => {
    const method = adoptedMethod();
    const app = await buildServer({ store, serveWeb: false, skillRoot });

    const exported = await app.inject({
      method: "POST",
      url: "/api/skills/export",
      payload: { methodId: method.id }
    });
    expect(exported.statusCode).toBe(201);
    const skillId = exported.json().skill.id as string;
    expect(exported.json().skill).toMatchObject({ status: "adopted", methodId: method.id });

    const used = await app.inject({
      method: "POST",
      url: "/api/skills/" + skillId + "/usage",
      payload: { status: "completed", source: "api" }
    });
    expect(used.statusCode).toBe(200);
    const usage = await app.inject({ method: "GET", url: "/api/skills/usage?skillId=" + skillId });
    expect(usage.statusCode).toBe(200);
    expect(usage.json().usage[0]).toMatchObject({ skillId, status: "completed", source: "api" });
    const curator = await app.inject({ method: "GET", url: "/api/skills/curator" });
    expect(curator.statusCode).toBe(200);
    const curatorRun = await app.inject({ method: "POST", url: "/api/skills/curator/run", payload: { dryRun: true } });
    expect(curatorRun.statusCode).toBe(200);
    expect(curatorRun.json().status).toBe("planned");

    const detail = await app.inject({ method: "GET", url: "/api/skills/" + skillId });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().document.body).toContain("## Verification");
    expect(detail.json().resources.map((item: { path: string }) => item.path)).toContain("tests/README.md");

    const pinned = await app.inject({
      method: "POST",
      url: "/api/skills/" + skillId + "/pin",
      payload: { pinned: true }
    });
    expect(pinned.statusCode).toBe(200);
    expect(pinned.json().pinned).toBe(true);
    expect(pinned.json().changeReport).toContain("固定技能");

    const archived = await app.inject({
      method: "POST",
      url: "/api/skills/" + skillId + "/archive",
      payload: { reason: "暂时不用" }
    });
    expect(archived.statusCode).toBe(200);
    expect(archived.json()).toMatchObject({ status: "archived", previousStatus: "adopted" });
    expect((await app.inject({ method: "GET", url: "/api/skills" })).json().index).toEqual([]);

    const restored = await app.inject({ method: "POST", url: "/api/skills/" + skillId + "/restore" });
    expect(restored.statusCode).toBe(200);
    expect(restored.json().status).toBe("adopted");
    const snapshot = await app.inject({ method: "GET", url: "/api/skills" });
    expect(snapshot.json().index[0]).toMatchObject({ id: skillId, pinned: true });

    await app.close();
  });

  it("imports, scopes trials, and checks skill execution", async () => {
    const importedSkill = `---
name: imported-review
description: Imported review workflow.
version: 1.0.0
platforms: [windows, macos, linux]
tools: [read_file]
permissions:
  readRoots: ["~/.hearth/notes"]
  writeRoots: []
  networkHosts: []
metadata:
  hearth:
    category: imported
    originTaskId: null
    originHash: null
    adoptedAt: null
---
# Imported Review Skill

## When to Use

Use for imported review tasks.

## Prerequisites

Read the notes folder.

## Procedure

1. Read notes.

## Quick Reference

- notes: local

## Pitfalls

Do not execute without approval.

## Verification

Report the source note.
`;
    const app = await buildServer({ store, serveWeb: false, skillRoot });
    const imported = await app.inject({ method: "POST", url: "/api/skills/import", payload: { content: importedSkill } });
    expect(imported.statusCode).toBe(201);
    const skillId = imported.json().skill.id as string;
    expect(imported.json().skill).toMatchObject({ status: "candidate", origin: "imported", trialTaskIds: [] });

    const service = new HearthService(store);
    const task = service.createTask({
      templateId: "T01",
      title: "导入技能试跑",
      permissions: {
        readRoots: ["~/.hearth/notes"],
        writeRoots: [],
        networkHosts: [],
        tools: ["read_file"]
      }
    });
    const trial = await app.inject({
      method: "POST",
      url: "/api/skills/" + skillId + "/trials",
      payload: { taskIds: [task.id] }
    });
    expect(trial.statusCode).toBe(200);
    expect(trial.json()).toMatchObject({ status: "trial", trialTaskIds: [task.id] });

    const checked = await app.inject({
      method: "POST",
      url: "/api/skills/" + skillId + "/check",
      payload: { taskId: task.id, readPaths: ["~/.hearth/notes/week.md"], allowImported: true }
    });
    expect(checked.statusCode).toBe(200);
    expect(checked.json().allowed).toBe(true);

    const outside = await app.inject({
      method: "POST",
      url: "/api/skills/" + skillId + "/check",
      payload: { taskId: task.id, readPaths: ["/etc/passwd"], allowImported: true }
    });
    expect(outside.statusCode).toBe(200);
    expect(outside.json().allowed).toBe(false);
    expect(outside.json().denied.some((item: { category: string }) => item.category === "read")).toBe(true);

    const authorize = await app.inject({
      method: "POST",
      url: "/api/skills/" + skillId + "/authorize",
      payload: { taskId: task.id }
    });
    expect(authorize.statusCode).toBe(403);
    expect(authorize.json().error).toBe("SKILL_PERMISSION_DENIED");
    await app.close();
  });

  it("rejects invalid exports and transitions", async () => {
    const app = await buildServer({ store, serveWeb: false, skillRoot });
    const invalid = await app.inject({ method: "POST", url: "/api/skills/export", payload: {} });
    expect(invalid.statusCode).toBe(400);
    const missing = await app.inject({ method: "POST", url: "/api/skills/missing/restore" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toBe("SKILL_NOT_FOUND");
    await app.close();
  });
});
