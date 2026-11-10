import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ArtifactRecord, EffectRecord, GoalContract } from "@hearth/core";
import { HearthStore } from "@hearth/eventlog";
import { judgeCompletion } from "./completion-judge.ts";
import { HearthService } from "./service.ts";

describe("completion judge", () => {
  let root: string;
  let store: HearthStore;
  let service: HearthService;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hearth-judge-"));
    store = new HearthStore(":memory:");
    service = new HearthService(store);
  });

  afterEach(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("passes only when artifacts and key fields match the recorded evidence", async () => {
    const goal = createGoal(service, "auto");
    const task = service.createTask({ title: "研究摘要", goalId: goal.goalId, executorId: "native" });
    const artifact = writeArtifact(root, task.id, "research-summary.json", JSON.stringify({ title: "周报", summary: "完成" }));
    const report = await judgeCompletion({ goal, task, artifacts: [artifact], effects: [], now: new Date("2026-11-09T00:00:00.000Z") });
    expect(report.verdict).toBe("pass");
    expect(report.criteria.map((criterion) => criterion.status)).toEqual(["passed", "passed"]);
    expect(report.evidenceRefs.some((ref) => ref.includes("research-summary.json#sha256="))).toBe(true);
    expect(report.evidenceRefs).toContain("research-summary.json#title");
  });

  it("rejects completion after the artifact is deleted", async () => {
    const goal = createGoal(service, "auto");
    const task = service.createTask({ title: "研究摘要", goalId: goal.goalId, executorId: "native" });
    const artifact = writeArtifact(root, task.id, "research-summary.json", JSON.stringify({ title: "周报", summary: "完成" }));
    unlinkSync(artifact.absolutePath);
    const report = await judgeCompletion({ goal, task, artifacts: [artifact], effects: [] });
    expect(report.verdict).toBe("fail");
    expect(report.criteria[0]?.detail).toContain("不存在");
  });

  it("rejects completion when a key field or file hash changes", async () => {
    const goal = createGoal(service, "auto");
    const task = service.createTask({ title: "研究摘要", goalId: goal.goalId, executorId: "native" });
    const artifact = writeArtifact(root, task.id, "research-summary.json", JSON.stringify({ title: "周报", summary: "完成" }));
    writeFileSync(artifact.absolutePath, JSON.stringify({ title: "周报", summary: "被篡改" }));
    const changedHash = await judgeCompletion({ goal, task, artifacts: [artifact], effects: [] });
    expect(changedHash.verdict).toBe("fail");
    expect(changedHash.criteria[0]?.detail).toContain("内容已被修改");

    const missingFieldArtifact = {
      ...artifact,
      sha256: createHash("sha256").update(JSON.stringify({ title: "周报" })).digest("hex")
    };
    writeFileSync(artifact.absolutePath, JSON.stringify({ title: "周报" }));
    const missingField = await judgeCompletion({ goal, task, artifacts: [missingFieldArtifact], effects: [] });
    expect(missingField.verdict).toBe("fail");
    expect(missingField.criteria[1]?.detail).toContain("summary");
  });

  it("blocks uncertain effects and rejects effects without receipts", async () => {
    const goal = createGoal(service, "auto");
    const task = service.createTask({ title: "研究摘要", goalId: goal.goalId, executorId: "native" });
    const artifact = writeArtifact(root, task.id, "research-summary.json", JSON.stringify({ title: "周报", summary: "完成" }));
    const uncertain = effect(task.id, goal.goalId, "uncertain", null);
    expect((await judgeCompletion({ goal, task, artifacts: [artifact], effects: [uncertain] })).verdict).toBe("blocked");

    const noReceipt = effect(task.id, goal.goalId, "committed", null);
    expect((await judgeCompletion({ goal, task, artifacts: [artifact], effects: [noReceipt] })).verdict).toBe("fail");
  });

  it("does not treat an unrun validator as proof of completion", async () => {
    const goal = createGoal(service, "auto", [
      { id: "manual", description: "人工确认语气", validator: "manual", check: "review", required: true }
    ]);
    const task = service.createTask({ title: "人工审核", goalId: goal.goalId, executorId: "native" });
    const report = await judgeCompletion({ goal, task, artifacts: [], effects: [] });
    expect(report.verdict).toBe("needs_human");
    expect(report.criteria[0]?.status).toBe("not_run");
  });

  it("runs command and git validators against the task workspace", async () => {
    execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Hearth Test"], { cwd: root });
    execFileSync("git", ["config", "user.email", "hearth@example.test"], { cwd: root });
    writeFileSync(join(root, "README.md"), "# test\n");
    execFileSync("git", ["add", "README.md"], { cwd: root });
    execFileSync("git", ["commit", "-m", "test"], { cwd: root, stdio: "ignore" });
    const goal = createGoal(service, "auto", [
      { id: "tests", description: "测试通过", validator: "command", check: JSON.stringify({ executable: "node", args: ["-e", "process.exit(0)"] }), required: true },
      { id: "branch", description: "分支正确", validator: "git", check: "branch=main", required: true },
      { id: "clean", description: "工作区干净", validator: "git", check: "clean", required: true }
    ], []);
    const task = service.createTask({ title: "运行验收", goalId: goal.goalId, executorId: "native" });

    const report = await judgeCompletion({ goal, task, artifacts: [], effects: [], workspaceRoot: root });

    expect(report.verdict).toBe("pass");
    expect(report.criteria.map((criterion) => criterion.status)).toEqual(["passed", "passed", "passed"]);
    expect(report.evidenceRefs.some((ref) => ref.startsWith("command:sha256="))).toBe(true);
    expect(report.evidenceRefs.some((ref) => ref.startsWith("action:"))).toBe(true);
    expect(report.evidenceRefs).toContain("sandbox:local");
    expect(report.evidenceRefs).toContain("git:branch=main");
  });

  it("fails a command validator with a non-zero exit code", async () => {
    const goal = createGoal(service, "auto", [
      {
        id: "failing", description: "测试必须失败", validator: "command",
        check: JSON.stringify({ executable: "node", args: ["-e", "process.exit(7)"] }), required: true
      }
    ], []);
    const task = service.createTask({ title: "失败验收", goalId: goal.goalId, executorId: "native" });

    const report = await judgeCompletion({ goal, task, artifacts: [], effects: [], workspaceRoot: root });

    expect(report.verdict).toBe("fail");
    expect(report.criteria[0]).toMatchObject({ status: "failed" });
    expect(report.criteria[0]?.detail).toContain("退出码 7");
  });

  it("rejects free-form shell command validators", async () => {
    const goal = createGoal(service, "auto", [
      { id: "freeform", description: "不应执行 shell", validator: "command", check: "node -e \"process.exit(0)\"", required: true }
    ], []);
    const task = service.createTask({ title: "拒绝自由 shell", goalId: goal.goalId, executorId: "native" });

    const report = await judgeCompletion({ goal, task, artifacts: [], effects: [], workspaceRoot: root });

    expect(report.verdict).toBe("fail");
    expect(report.criteria[0]?.detail).toContain("结构化 JSON");
  });

  it("rejects a command validator whose cwd escapes the workspace", async () => {
    const goal = createGoal(service, "auto", [
      {
        id: "escape", description: "不能越界", validator: "command",
        check: JSON.stringify({ executable: "node", args: ["-e", "process.exit(0)"], cwd: ".." }), required: true
      }
    ], []);
    const task = service.createTask({ title: "拒绝路径逃逸", goalId: goal.goalId, executorId: "native" });

    const report = await judgeCompletion({ goal, task, artifacts: [], effects: [], workspaceRoot: root });

    expect(report.verdict).toBe("fail");
    expect(report.criteria[0]?.detail).toContain("超出会话根目录");
  });

  it("requires human review even when all criteria pass", async () => {
    const goal = createGoal(service, "human_on_complete");
    const task = service.createTask({ title: "研究摘要", goalId: goal.goalId, executorId: "native" });
    const artifact = writeArtifact(root, task.id, "research-summary.json", JSON.stringify({ title: "周报", summary: "完成" }));
    const report = await judgeCompletion({ goal, task, artifacts: [artifact], effects: [] });
    expect(report.verdict).toBe("needs_human");
    expect(report.summary).toContain("仍需人工");
  });
});

function createGoal(
  service: HearthService,
  reviewPolicy: GoalContract["reviewPolicy"],
  criteria?: GoalContract["successCriteria"],
  evidenceRequirements: string[] = ["research-summary.json"]
): GoalContract {
  return service.createGoal({
    title: "每周研究摘要",
    objective: "产出可核验的研究摘要",
    reviewPolicy,
    currentState: "active",
    successCriteria: criteria ?? [
      { id: "file", description: "摘要文件存在", validator: "file", check: "research-summary.json", required: true },
      { id: "schema", description: "摘要字段完整", validator: "schema", check: "research-summary.json#title,summary", required: true }
    ],
    evidenceRequirements
  });
}

function writeArtifact(root: string, taskId: string, relativePath: string, content: string): ArtifactRecord {
  const absolutePath = join(root, relativePath);
  writeFileSync(absolutePath, content);
  return {
    id: `artifact-${relativePath}`,
    taskId,
    runId: "run-1",
    relativePath,
    absolutePath,
    mimeType: "application/json",
    sha256: createHash("sha256").update(content).digest("hex"),
    bytes: Buffer.byteLength(content),
    createdAt: new Date().toISOString()
  };
}

function effect(taskId: string, goalId: string, status: EffectRecord["status"], receipt: Record<string, unknown> | null): EffectRecord {
  const now = new Date().toISOString();
  return {
    id: `effect-${status}-${Math.random()}`,
    taskId,
    goalId,
    approvalId: "approval-1",
    kind: "email.smtp-send",
    idempotencyKey: `idem-${Math.random()}`,
    status,
    target: {},
    receipt,
    error: null,
    createdAt: now,
    updatedAt: now,
    effectType: "email.send",
    replayPolicy: "never_replay"
  };
}
