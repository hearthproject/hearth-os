import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TaskRecord } from "@hearth/core";
import { DossierError, DossierStore, dossierPromptBlock } from "./dossier.ts";
import { DEFAULT_WORKSTYLE, WorkstyleError, WorkstyleStore } from "./workstyle.ts";
import { codingPromptSections } from "../../../packages/agent-runtime/src/harness/prompt.ts";

function task(id: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id,
    templateId: null,
    title: `任务 ${id}`,
    goal: `完成 ${id}`,
    status: "completed",
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-02T00:00:00.000Z",
    deadline: null,
    inputs: [],
    networkHosts: [],
    outputDir: `.hearth/artifacts/${id}`,
    currentRunId: null,
    nextAction: null,
    error: null,
    resultSummary: `结果 ${id}`,
    projectId: "project_1",
    ...overrides
  };
}

describe("project dossier", () => {
  it("compiles readable sections and survives corrupt json", () => {
    const root = mkdtempSync(join(tmpdir(), "hearth-dossier-"));
    try {
      const store = new DossierStore(root);
      const dossier = store.compile({
        projectId: "project_1",
        projectName: "Hearth",
        projectPath: root,
        tasks: [
          task("done"),
          task("open", { status: "running", resultSummary: null }),
          task("bad", { status: "failed", resultSummary: null, error: { kind: "execution", message: "测试失败", recoverable: true, guidance: "" } })
        ],
        now: new Date("2026-11-10T00:00:00.000Z")
      });
      expect(dossier.sections.decisions[0]).toContain("结果 done");
      expect(dossier.sections.openTasks[0]).toContain("[running]");
      expect(dossier.sections.pitfalls[0]).toContain("测试失败");
      expect(dossier.markdown).toContain("# 项目档案：Hearth");
      expect(dossier.markdown).toContain("## 未完成任务");

      const read = store.read("project_1");
      expect(read?.sections.evidence[0]).toContain("artifacts/done");

      writeFileSync(join(root, "project_1", "dossier.json"), "{broken", "utf8");
      const fallback = store.read("project_1");
      expect(fallback?.markdown).toContain("项目档案");
      expect(fallback?.sections.decisions[0]).toContain("结果 done");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects path traversal in project ids", () => {
    const store = new DossierStore(join(tmpdir(), "hearth-dossier-invalid"));
    expect(() => store.read("../escape")).toThrow(DossierError);
  });

  it("renders a bounded prompt block", () => {
    const root = mkdtempSync(join(tmpdir(), "hearth-dossier-prompt-"));
    try {
      const store = new DossierStore(root);
      const dossier = store.compile({ projectId: "p", projectName: "P", projectPath: root, tasks: [task("a")] });
      const block = dossierPromptBlock(dossier, 200);
      expect(block).toContain("Project dossier");
      expect(block!.length).toBeLessThanOrEqual(240);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("work style profile", () => {
  it("returns defaults, writes and resets", () => {
    const root = mkdtempSync(join(tmpdir(), "hearth-workstyle-"));
    try {
      const store = new WorkstyleStore(join(root, "WORKSTYLE.md"));
      expect(store.read()).toMatchObject({ isDefault: true, content: DEFAULT_WORKSTYLE });
      const saved = store.write("# 我的工作方式\n\n- 先跑测试。");
      expect(saved.content).toContain("先跑测试");
      expect(store.read().isDefault).toBe(false);
      expect(store.reset().content).toContain("## 沟通");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects empty and oversized work styles", () => {
    const store = new WorkstyleStore(join(tmpdir(), "hearth-workstyle-limits", "WORKSTYLE.md"), { maxChars: 10 });
    expect(() => store.write("   ")).toThrow(WorkstyleError);
    expect(() => store.write("x".repeat(11))).toThrow(WorkstyleError);
  });

  it("places dynamic dossier and work style context after stable prompt rules", () => {
    const sections = codingPromptSections({
      workspaceRoot: process.cwd(),
      outDir: join(process.cwd(), "out"),
      dossier: "## Project dossier\nproject facts",
      workstyle: "## Work style\nbe direct",
      availableTools: ["read_file", "finish_task"]
    });
    const ids = sections.map((section) => section.id);
    expect(ids.indexOf("rules")).toBe(0);
    expect(ids.indexOf("dossier")).toBeGreaterThan(ids.indexOf("environment"));
    expect(ids.indexOf("workstyle")).toBeGreaterThan(ids.indexOf("dossier"));
  });

  it("does not emit empty sections without a dossier", () => {
    const sections = codingPromptSections({ workspaceRoot: process.cwd(), outDir: join(process.cwd(), "out"), availableTools: ["read_file"] });
    expect(sections.some((section) => section.id === "dossier")).toBe(false);
    expect(sections.some((section) => section.id === "workstyle")).toBe(false);
  });
});
