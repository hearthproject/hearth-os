import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HearthStore } from "@hearth/eventlog";
import { buildServer } from "./app.ts";
import { SecretBox } from "./secrets.ts";

interface TreeNode {
  id: string;
  ref: string;
  title: string;
  path: string;
  kind: string;
  metadata: Record<string, unknown>;
  children?: TreeNode[];
}

function flatten(nodes: TreeNode[]): TreeNode[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children ?? [])]);
}

describe("cross-module integration", () => {
  let tmp: string;
  let store: HearthStore;
  let app: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "hearth-integration-"));
    store = new HearthStore(":memory:");
    app = await buildServer({
      store,
      serveWeb: false,
      startScheduler: false,
      startMaintenance: false,
      startMailSync: false,
      libraryEmbeddingProvider: null,
      secretBox: new SecretBox(Buffer.alloc(32, 7)),
      contextBlobRoot: join(tmp, "context"),
      sourceContentRoot: join(tmp, "sources"),
      outboxRoot: join(tmp, "outbox"),
      deviceFrameRoot: join(tmp, "frames"),
      backupRoot: join(tmp, "backups"),
      attachmentRoot: join(tmp, "attachments"),
      modelSettingsPath: join(tmp, "model-settings.json"),
      executorSettingsPath: join(tmp, "executor-settings.json"),
      masterKeyPath: join(tmp, "master.key")
    });
  });

  afterEach(async () => {
    await app.close();
    store.close();
    rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  async function createTask(title = "集成测试任务") {
    const response = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: {
        title,
        goal: "验证跨模块集成行为",
        executorId: "native",
        taskKind: "general",
        expectedOutputs: ["result.md"]
      }
    });
    expect(response.statusCode).toBe(201);
    return response.json() as { id: string };
  }

  describe("library file roots", () => {
    it("indexes a folder, hides credentials, and stops serving it after the root is removed", async () => {
      const root = join(tmp, "工作资料");
      mkdirSync(join(root, "子目录"), { recursive: true });
      mkdirSync(join(root, "node_modules"), { recursive: true });
      mkdirSync(join(root, ".ssh"), { recursive: true });
      writeFileSync(join(root, "notes.md"), "# 周报\n季度目标是提升集成测试覆盖。\n");
      writeFileSync(join(root, "子目录", "data.csv"), "name,score\nalpha,1\n");
      writeFileSync(join(root, ".env"), "SECRET=leak\n");
      writeFileSync(join(root, "id_rsa"), "PRIVATE KEY\n");
      writeFileSync(join(root, "node_modules", "dep.md"), "# 依赖\n");
      writeFileSync(join(root, ".ssh", "known_hosts"), "host\n");

      const added = await app.inject({ method: "POST", url: "/api/library/roots", payload: { path: root } });
      expect(added.statusCode).toBe(201);
      const rootId = added.json().root.id as string;
      expect(added.json().root.recursive).toBe(true);

      const reindex = await app.inject({ method: "POST", url: "/api/library/reindex" });
      expect(reindex.statusCode).toBe(200);
      expect(reindex.json().result.semanticError).toBeNull();

      const tree = await app.inject({ method: "GET", url: "/api/library/tree?depth=6" });
      expect(tree.statusCode).toBe(200);
      const nodes = flatten(tree.json().nodes as TreeNode[]);
      const status = await app.inject({ method: "GET", url: "/api/library/status" });
      expect(status.statusCode).toBe(200);
      expect(status.json().itemCount).toBe(2);
      expect(status.json().nodeCount).toBeGreaterThan(status.json().itemCount);
      const titles = nodes.map((node) => node.title);
      expect(titles).toContain("notes.md");
      expect(titles).toContain("data.csv");
      for (const hidden of [".env", "id_rsa", "dep.md", "known_hosts"]) {
        expect(titles).not.toContain(hidden);
      }
      expect(nodes.every((node) => !node.path.includes("node_modules"))).toBe(true);
      expect(nodes.every((node) => !node.path.includes(".ssh"))).toBe(true);
      expect(nodes.every((node) => !String(node.metadata.absolutePath ?? "").includes(".env"))).toBe(true);

      const search = await app.inject({
        method: "GET",
        url: "/api/library/search?q=" + encodeURIComponent("集成测试覆盖")
      });
      expect(search.statusCode).toBe(200);
      expect(search.json().hits.length).toBeGreaterThan(0);
      const hit = search.json().hits[0] as { node: TreeNode };
      expect(hit.node.kind).toBe("file");
      expect(hit.node.metadata.relativePath).toBe("notes.md");

      const content = await app.inject({ method: "GET", url: `/api/library/nodes/${hit.node.id}/content` });
      expect(content.statusCode).toBe(200);
      expect(content.json().content).toContain("集成测试覆盖");

      const resolved = await app.inject({
        method: "GET",
        url: "/api/library/resolve?node=" + encodeURIComponent(hit.node.ref)
      });
      expect(resolved.statusCode).toBe(200);
      expect(resolved.json().node.metadata.relativePath).toBe("notes.md");

      const removed = await app.inject({ method: "DELETE", url: `/api/library/roots/${rootId}` });
      expect(removed.statusCode).toBe(200);

      const after = flatten((await app.inject({ method: "GET", url: "/api/library/tree?depth=6" })).json().nodes as TreeNode[]);
      expect(after.some((node) => node.title === "notes.md")).toBe(false);
      expect(after.some((node) => node.title === "data.csv")).toBe(false);

      const afterSearch = await app.inject({
        method: "GET",
        url: "/api/library/search?q=" + encodeURIComponent("集成测试覆盖")
      });
      expect(afterSearch.statusCode).toBe(200);
      expect(afterSearch.json().hits).toHaveLength(0);
    });

    it("reindexes a single file root without walking unrelated folders", async () => {
      const fileRoot = join(tmp, "单文件.md");
      writeFileSync(fileRoot, "# 单文件\n只索引这一份。\n");
      const added = await app.inject({ method: "POST", url: "/api/library/roots", payload: { path: fileRoot } });
      expect(added.statusCode).toBe(201);
      expect(added.json().root.kind).toBe("file");
      expect(added.json().root.recursive).toBe(false);

      const tree = flatten((await app.inject({ method: "GET", url: "/api/library/tree?depth=6" })).json().nodes as TreeNode[]);
      expect(tree.some((node) => node.title === "单文件.md")).toBe(true);
    });

    it("rejects a library root that does not exist", async () => {
      const missing = await app.inject({
        method: "POST",
        url: "/api/library/roots",
        payload: { path: join(tmp, "does-not-exist") }
      });
      expect(missing.statusCode).toBe(400);
      expect(missing.json().error).toBe("INVALID_ROOT");
    });
  });

  describe("memory lifecycle", () => {
    it("keeps recall inside the configured budget and honors forget tombstones", async () => {
      const task = await createTask();

      const created = await app.inject({
        method: "POST",
        url: "/api/memory",
        payload: {
          kind: "preference",
          content: "回答时先给结论，再补充证据。",
          subjectKey: "回答风格",
          source: { type: "user", id: null, label: "用户", excerpt: null },
          confidence: "high"
        }
      });
      expect(created.statusCode).toBe(201);
      const memoryId = created.json().id as string;
      expect(created.json().status).toBe("candidate");

      const confirmed = await app.inject({ method: "POST", url: `/api/memory/${memoryId}/confirm` });
      expect(confirmed.statusCode).toBe(200);
      expect(confirmed.json().status).toBe("active");

      const secret = await app.inject({
        method: "POST",
        url: "/api/memory",
        payload: {
          kind: "fact",
          content: "银行卡尾号 8888。",
          subjectKey: "银行卡",
          source: { type: "user", id: null, label: "用户", excerpt: null },
          sensitivity: "secret",
          allowRecall: false,
          confidence: "high"
        }
      });
      expect(secret.statusCode).toBe(201);

      const recall = await app.inject({
        method: "POST",
        url: "/api/memory/recall",
        payload: { taskId: task.id, text: "请按我的偏好回答银行的问题", maxItems: 1, maxChars: 200 }
      });
      expect(recall.statusCode).toBe(200);
      const recalled = recall.json() as { memories: Array<{ id: string }>; usedChars: number; budget: { maxItems: number; maxChars: number } };
      expect(recalled.memories).toHaveLength(1);
      expect(recalled.memories[0]!.id).toBe(memoryId);
      expect(recalled.usedChars).toBeLessThanOrEqual(recalled.budget.maxChars);
      expect(recalled.budget.maxItems).toBe(1);
      expect(recalled.budget.maxChars).toBe(200);

      const exportBefore = await app.inject({ method: "GET", url: "/api/memory/export" });
      expect(exportBefore.statusCode).toBe(200);
      const exported = exportBefore.json() as { schemaVersion: number; memories: Array<{ id: string }>; forgets: unknown[] };
      expect(exported.schemaVersion).toBe(1);
      expect(exported.memories.some((memory) => memory.id === memoryId)).toBe(true);
      expect(exported.forgets).toHaveLength(0);

      const forgotten = await app.inject({ method: "POST", url: `/api/memory/${memoryId}/forget` });
      expect(forgotten.statusCode).toBe(200);
      expect(forgotten.json().status).toBe("forgotten");

      const exportAfter = await app.inject({ method: "GET", url: "/api/memory/export" });
      const after = exportAfter.json() as { memories: Array<{ id: string; status: string }>; forgets: unknown[] };
      expect(after.memories.find((memory) => memory.id === memoryId)?.status).toBe("forgotten");
      expect(after.forgets.length).toBeGreaterThan(0);

      const secondRecall = await app.inject({
        method: "POST",
        url: "/api/memory/recall",
        payload: { taskId: task.id, text: "再回答一次", maxItems: 5, maxChars: 2_000 }
      });
      expect(secondRecall.statusCode).toBe(200);
      expect(secondRecall.json().memories.every((memory: { id: string }) => memory.id !== memoryId)).toBe(true);
      expect(secondRecall.json().memories.some((memory: { id: string }) => memory.id === secret.json().id)).toBe(false);
    });

    it("rejects recall for a task that does not exist", async () => {
      const recall = await app.inject({
        method: "POST",
        url: "/api/memory/recall",
        payload: { taskId: "TASK-missing", text: "任意内容" }
      });
      expect(recall.statusCode).toBe(404);
      expect(recall.json().error).toBe("TASK_NOT_FOUND");
    });
  });

  describe("schedules", () => {
    it("creates a schedule with a computed next run and rejects impossible cron expressions", async () => {
      const created = await app.inject({
        method: "POST",
        url: "/api/schedules",
        payload: {
          name: "集成测试巡检",
          prompt: "检查工作区并汇报",
          cron: "0 9 * * 1-5",
          timezone: "Asia/Shanghai"
        }
      });
      expect(created.statusCode).toBe(201);
      const schedule = created.json() as {
        id: string;
        nextRunAt: string;
        enabled: boolean;
        timezone: string;
        conversationId: string;
        catchUpPolicy: string;
        catchUpMaxRuns: number;
      };
      expect(schedule.enabled).toBe(true);
      expect(schedule.timezone).toBe("Asia/Shanghai");
      expect(schedule.conversationId).toBeTruthy();
      expect(schedule.catchUpPolicy).toBe("run_once");
      expect(schedule.catchUpMaxRuns).toBe(3);
      const next = Date.parse(schedule.nextRunAt);
      expect(Number.isFinite(next)).toBe(true);
      expect(next).toBeGreaterThan(Date.now() - 60_000);
      expect(next).toBeLessThan(Date.now() + 8 * 24 * 60 * 60 * 1000);

      const disabled = await app.inject({
        method: "POST",
        url: "/api/schedules",
        payload: { name: "暂停中的巡检", prompt: "不需要立刻运行", cron: "0 9 * * *", enabled: false }
      });
      expect(disabled.statusCode).toBe(201);
      expect(disabled.json().nextRunAt).toBeNull();

      const invalid = await app.inject({
        method: "POST",
        url: "/api/schedules",
        payload: { name: "坏表达式", prompt: "不会创建", cron: "99 99 * * *" }
      });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json().error).toBe("INVALID_CRON");

      const invalidZone = await app.inject({
        method: "POST",
        url: "/api/schedules",
        payload: { name: "坏时区", prompt: "不会创建", cron: "0 9 * * *", timezone: "Mars/Olympus" }
      });
      expect(invalidZone.statusCode).toBe(400);

      const patched = await app.inject({
        method: "PATCH",
        url: `/api/schedules/${disabled.json().id}`,
        payload: { enabled: true, name: "恢复的巡检" }
      });
      expect(patched.statusCode).toBe(200);
      expect(patched.json().enabled).toBe(true);
      expect(patched.json().name).toBe("恢复的巡检");
      expect(patched.json().nextRunAt).not.toBeNull();

      const runs = await app.inject({ method: "GET", url: `/api/schedules/${schedule.id}/runs` });
      expect(runs.statusCode).toBe(200);
      expect(runs.json().runs).toHaveLength(0);
    });

    it("refuses an immediate run while the executor is unavailable", async () => {
      const created = await app.inject({
        method: "POST",
        url: "/api/schedules",
        payload: { name: "离线巡检", prompt: "检查工作区", cron: "0 9 * * *" }
      });
      expect(created.statusCode).toBe(201);
      const run = await app.inject({ method: "POST", url: `/api/schedules/${created.json().id}/run` });
      expect(run.statusCode).toBe(409);
      expect(run.json().error).toBe("EXECUTOR_UNAVAILABLE");

      const removed = await app.inject({ method: "DELETE", url: `/api/schedules/${created.json().id}` });
      expect(removed.statusCode).toBe(204);
      const list = await app.inject({ method: "GET", url: "/api/schedules" });
      expect(list.json().schedules).toHaveLength(0);
    });
  });

  describe("task input guards", () => {
    it("rejects expected outputs that escape the task directory before a run starts", async () => {
      for (const bad of ["../escape.md", "..\\escape.md", "C:\\temp\\x.md", "/etc/passwd", "docs/../../x.md", "."]) {
        const response = await app.inject({
          method: "POST",
          url: "/api/tasks",
          payload: { title: "越界产物", goal: "验证路径校验", expectedOutputs: [bad] }
        });
        expect(response.statusCode, bad).toBe(400);
        expect(response.json().error, bad).toBe("INVALID_EXPECTED_OUTPUT");
      }
    });

    it("accepts nested relative outputs and rejects a project that does not exist", async () => {
      const ok = await app.inject({
        method: "POST",
        url: "/api/tasks",
        payload: { title: "嵌套产物", goal: "生成文档", expectedOutputs: ["docs/result.md"] }
      });
      expect(ok.statusCode).toBe(201);
      expect(ok.json().expectedOutputs).toEqual(["docs/result.md"]);

      const missing = await app.inject({
        method: "POST",
        url: "/api/tasks",
        payload: { title: "缺少项目", goal: "生成文档", expectedOutputs: ["result.md"], projectId: "PRJ-missing" }
      });
      expect(missing.statusCode).toBe(404);
      expect(missing.json().error).toBe("PROJECT_NOT_FOUND");
    });
  });

  it("reports a missing task as 404 on retry, cancel, and budget actions", async () => {
    for (const path of ["/api/tasks/TASK-missing/retry", "/api/tasks/TASK-missing/cancel", "/api/tasks/TASK-missing/budget/extend"]) {
      const response = await app.inject({ method: "POST", url: path, payload: {} });
      expect(response.statusCode, path).toBe(404);
      expect(response.json().error, path).toBe("TASK_NOT_FOUND");
      expect(response.json().message, path).toContain("任务不存在");
    }
  });

  describe("api robustness", () => {
    it("answers malformed requests with client errors instead of crashing", async () => {
      const cases: Array<{ method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE"; url: string; payload?: Record<string, unknown> }> = [
        { method: "POST", url: "/api/tasks", payload: {} },
        { method: "POST", url: "/api/tasks", payload: { title: 123, goal: [] } },
        { method: "POST", url: "/api/tasks", payload: { title: "x", goal: "y", expectedOutputs: "result.md" } },
        { method: "POST", url: "/api/tasks", payload: { title: "x", goal: "y", executorId: "unknown" } },
        { method: "GET", url: "/api/tasks/TASK-missing" },
        { method: "GET", url: "/api/tasks/TASK-missing/turns" },
        { method: "POST", url: "/api/tasks/TASK-missing/cancel", payload: {} },
        { method: "POST", url: "/api/tasks/TASK-missing/rewind", payload: { runId: "r", turn: "x" } },
        { method: "GET", url: "/api/library/tree?depth=abc" },
        { method: "GET", url: "/api/library/tree?depth=99" },
        { method: "GET", url: "/api/library/search" },
        { method: "GET", url: "/api/library/nodes/../../etc/passwd" },
        { method: "POST", url: "/api/library/roots", payload: {} },
        { method: "POST", url: "/api/library/roots", payload: { path: 42 } },
        { method: "DELETE", url: "/api/library/roots/missing", payload: {} },
        { method: "POST", url: "/api/memory", payload: {} },
        { method: "POST", url: "/api/memory", payload: { kind: "nope", content: "x", subjectKey: "y", source: {} } },
        { method: "POST", url: "/api/memory/recall", payload: {} },
        { method: "PATCH", url: "/api/memory/missing", payload: {} },
        { method: "POST", url: "/api/memory/missing/confirm" },
        { method: "POST", url: "/api/memory/missing/forget" },
        { method: "POST", url: "/api/schedules", payload: {} },
        { method: "POST", url: "/api/schedules", payload: { name: "x", prompt: "y", cron: 5 } },
        { method: "PATCH", url: "/api/schedules/missing", payload: {} },
        { method: "POST", url: "/api/schedules/missing/run" },
        { method: "DELETE", url: "/api/schedules/missing" },
        { method: "PATCH", url: "/api/context/settings", payload: { mode: "bogus" } },
        { method: "PATCH", url: "/api/context/settings", payload: { maxHandoffs: 99 } },
        { method: "PATCH", url: "/api/context/settings", payload: { nope: true } },
        { method: "PATCH", url: "/api/browser/settings", payload: { enabled: "yes" } },
        { method: "PATCH", url: "/api/browser/settings", payload: { allowedDomains: [1] } },
        { method: "POST", url: "/api/model-profiles", payload: {} },
        { method: "POST", url: "/api/model-profiles", payload: { name: "x", baseUrl: "not a url", model: "m" } },
        { method: "PUT", url: "/api/model-registry/chat-profile", payload: { profileId: 5 } },
        { method: "POST", url: "/api/backups", payload: { passphrase: "short" } },
        { method: "POST", url: "/api/backups/restore", payload: {} },
        { method: "POST", url: "/api/mcp/servers", payload: {} },
        { method: "POST", url: "/api/mcp/servers", payload: { name: "", command: 1 } },
        { method: "PUT", url: "/api/executor-settings", payload: { preferredExecutorId: "nope" } },
        { method: "POST", url: "/api/chat", payload: { message: "" } },
        { method: "POST", url: "/api/chat", payload: { message: "hi", conversationId: "missing" } },
        { method: "PUT", url: "/api/integrations/feishu", payload: { appId: 1 } },
        { method: "PATCH", url: "/api/web-search/settings", payload: { provider: "bogus" } }
      ];
      for (const testCase of cases) {
        const response = await app.inject({
          method: testCase.method,
          url: testCase.url,
          ...(testCase.payload === undefined ? {} : { payload: testCase.payload })
        });
        expect(
          [500, 502].includes(response.statusCode),
          `${testCase.method} ${testCase.url} -> ${response.statusCode} ${response.body.slice(0, 200)}`
        ).toBe(false);
        if (response.statusCode >= 400) {
          const body = JSON.parse(response.body) as { error?: string; message?: string };
          expect(body.error ?? body.message, `${testCase.method} ${testCase.url} should explain itself`).toBeTruthy();
        }
      }
    });
  });

  describe("context ledger", () => {
    it("reports settings, ledger counts, and diagnosis metrics as one consistent snapshot", async () => {
      const task = await createTask();
      const before = await app.inject({ method: "GET", url: "/api/context/metrics" });
      expect(before.statusCode).toBe(200);
      const metrics = before.json();
      expect(metrics.ledger.tasks).toBe(0);
      expect(metrics.ledger.items).toBe(0);
      expect(metrics.handoffs.successRate).toBeNull();
      expect(metrics.diagnosis.total).toBe(0);

      const settings = await app.inject({ method: "GET", url: "/api/context/settings" });
      expect(settings.statusCode).toBe(200);
      expect(settings.json().settings.mode).toMatch(/^(off|shadow|on)$/);

      const patched = await app.inject({
        method: "PATCH",
        url: "/api/context/settings",
        payload: { maxHandoffs: 2, retentionDays: 30 }
      });
      expect(patched.statusCode).toBe(200);
      expect(patched.json().settings.maxHandoffs).toBe(2);
      expect(patched.json().settings.retentionDays).toBe(30);

      const rejected = await app.inject({
        method: "PATCH",
        url: "/api/context/settings",
        payload: { maxHandoffs: 99 }
      });
      expect(rejected.statusCode).toBe(400);

      const context = await app.inject({ method: "GET", url: `/api/tasks/${task.id}/context` });
      expect(context.statusCode).toBe(200);
      expect(context.json().items.items).toEqual([]);
    });
  });
});
