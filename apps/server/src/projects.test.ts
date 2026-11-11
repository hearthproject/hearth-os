import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HearthStore } from "@hearth/eventlog";
import { buildServer } from "./app.ts";
import { ProjectService } from "./projects.ts";

describe("local projects", () => {
  let store: HearthStore;
  let root: string;
  let repo: string;

  beforeEach(() => {
    store = new HearthStore(":memory:");
    root = mkdtempSync(join(tmpdir(), "hearth-projects-"));
    repo = join(root, "repo");
    git(root, ["init", "-b", "main", repo]);
    git(repo, ["-c", "user.name=Hearth Test", "-c", "user.email=hearth@example.test", "commit", "--allow-empty", "-m", "init"]);
  });

  afterEach(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("registers a Git root and exposes live branch status", () => {
    const projects = new ProjectService(store);
    const project = projects.create({ path: repo });
    expect(project).toMatchObject({
      name: "repo",
      defaultBranch: "main",
      currentBranch: "main",
      available: true,
      dirty: false,
      error: null
    });

    writeFileSync(join(repo, "dirty.txt"), "change", "utf8");
    expect(projects.get(project.id)).toMatchObject({ dirty: true, available: true });
    expect(() => projects.create({ path: repo }))
      .toThrowError(expect.objectContaining({ code: "PROJECT_ALREADY_EXISTS" }));
  });

  it("rejects non-Git folders and branches that do not exist", () => {
    const projects = new ProjectService(store);
    const plain = join(root, "plain");
    mkdirSync(plain);
    expect(() => projects.create({ path: plain }))
      .toThrowError(expect.objectContaining({ code: "PROJECT_NOT_GIT" }));
    expect(() => projects.create({ path: repo, defaultBranch: "missing" }))
      .toThrowError(expect.objectContaining({ code: "PROJECT_BRANCH_NOT_FOUND" }));

    git(repo, ["branch", "release"]);
    const project = projects.create({ path: repo, defaultBranch: "release" });
    expect(projects.update(project.id, { name: "Hearth", defaultBranch: "main" })).toMatchObject({
      name: "Hearth",
      defaultBranch: "main"
    });
  });

  it("provides CRUD endpoints with validation errors", async () => {
    const app = await buildServer({ store, serveWeb: false });
    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { path: repo, name: "Core" }
    });
    expect(created.statusCode).toBe(201);
    const projectId = created.json().project.id as string;

    const list = await app.inject({ method: "GET", url: "/api/projects" });
    expect(list.statusCode).toBe(200);
    expect(list.json().projects).toContainEqual(expect.objectContaining({ id: projectId, name: "Core" }));

    const updated = await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}`,
      payload: { name: "Core 2" }
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().project.name).toBe("Core 2");

    const invalid = await app.inject({ method: "POST", url: "/api/projects", payload: { path: root } });
    expect(invalid.statusCode).toBe(409);
    expect(invalid.json().error).toBe("PROJECT_NOT_GIT");

    const removed = await app.inject({ method: "DELETE", url: `/api/projects/${projectId}` });
    expect(removed.statusCode).toBe(204);
    const missing = await app.inject({ method: "GET", url: `/api/projects/${projectId}` });
    expect(missing.statusCode).toBe(404);
  });
});

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.error?.message || "unknown"}`);
  }
}
