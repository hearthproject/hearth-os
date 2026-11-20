import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HearthStore } from "@hearth/eventlog";
import { extractWorkspacePath } from "./chat-routes.ts";
import { HearthService } from "./service.ts";

const roots: string[] = [];

function tempDir(): string {
  const root = mkdtempSync(join(tmpdir(), "hearth-workspace-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("workspace path detection", () => {
  it("detects an existing folder and resolves a file to its parent", () => {
    const root = tempDir();
    const folder = join(root, "notes");
    mkdirSync(folder);
    writeFileSync(join(folder, "todo.md"), "x", "utf8");
    const fromFolder = extractWorkspacePath(`帮我整理 ${folder} 里的待办`);
    expect(fromFolder?.toLowerCase()).toContain("notes");
    const fromFile = extractWorkspacePath(`改一下 ${join(folder, "todo.md")} 的标题`);
    expect(fromFile?.toLowerCase()).toBe(fromFolder?.toLowerCase());
    expect(extractWorkspacePath("没有路径的普通问题")).toBeNull();
  });

  it("creates a workspace task with read/write roots for a given folder", () => {
    const root = tempDir();
    const store = new HearthStore(":memory:");
    const service = new HearthService(store);
    const task = service.createTask({
      title: "整理目录",
      goal: "整理这个目录",
      executorId: "native",
      workspacePath: root
    });
    expect(task.taskKind).toBe("workspace");
    expect(task.inputs).toContainEqual(expect.objectContaining({ kind: "workspace" }));
    expect(task.permissions?.writeRoots[0]?.toLowerCase()).toContain(root.toLowerCase().split("\\").pop());
    store.close();
  });
});