import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HearthStore } from "@hearth/eventlog";
import type { TaskPermissions, TaskRecord } from "@hearth/core";
import type { NativeRunOptions, NativeRunResult } from "./native-executor.ts";
import type { ModelSettings } from "./model-settings.ts";
import { ProjectService } from "./projects.ts";
import { TEAM_RECEIPT_SCHEMA } from "./agent-mode.ts";
import { createAgentTool, createSubagentResumeHandler, createSubagentTool, type SubagentFinishedInfo } from "./subagents.ts";
import { createAgentLifecycleTools, SubagentTaskManager } from "./subagent-manager.ts";
import { TaskWorktreeService } from "./worktrees.ts";

describe("native subagents", () => {
  let root: string;
  let repo: string;
  let workspace: string;
  let store: HearthStore;
  let projectId: string;
  let worktrees: TaskWorktreeService;
  let task: TaskRecord;
  let permissions: TaskPermissions;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hearth-subagents-"));
    repo = join(root, "repo");
    workspace = join(root, "workspaces");
    mkdirSync(workspace, { recursive: true });
    git(root, ["init", "-b", "main", repo]);
    git(repo, ["config", "user.name", "Hearth Test"]);
    git(repo, ["config", "user.email", "hearth@example.test"]);
    writeFileSync(join(repo, "README.md"), "base\n", "utf8");
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-m", "init"]);
    store = new HearthStore(":memory:");
    projectId = new ProjectService(store).create({ path: repo, name: "Repo" }).id;
    worktrees = new TaskWorktreeService(store, { workspaceRoot: workspace });
    task = taskRecord("TASK-PARENT", projectId);
    permissions = {
      readRoots: [repo],
      writeRoots: [repo],
      networkHosts: ["example.test"],
      tools: ["read_file", "read_document", "glob", "grep", "write_file", "edit_file", "apply_patch", "shell", "fetch_url", "finish_task"]
    };
  });

  afterEach(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("runs read-only work in a fresh context and aggregates child usage", async () => {
    const captured: NativeRunOptions[] = [];
    const parentWorktree = worktrees.ensure(task);
    const tool = createSubagentTool({
      task,
      prepared: { root: parentWorktree.path, outDir: join(parentWorktree.path, "out"), inputs: [] },
      settings: settings(),
      permissions,
      signal: new AbortController().signal,
      worktrees,
      parentWorktree,
      runner: async (options) => {
        captured.push(options);
        return result("调查完成", { ...usage(0), inputTokens: 31, outputTokens: 12 });
      }
    });

    const output = await tool.execute({ objective: "检查 README 并给出结论", mode: "read-only" }, context(parentWorktree.path));

    const options = captured[0];
    expect(options).toBeDefined();
    expect(options?.resume).toBeUndefined();
    expect(options?.task.goal).toBe("检查 README 并给出结论");
    expect(options?.permissions?.writeRoots).toEqual([]);
    expect(options?.permissions?.tools).not.toContain("write_file");
    expect(options?.permissions?.tools).toContain("shell");
    expect(options?.mode).toBe("plan");
    expect(options?.extraTools?.some((tool) => tool.definition.name === "delegate_task")).toBe(true);
    expect(output.usage).toMatchObject({ inputTokens: 31, outputTokens: 12 });
  });

  it("dispatches a typed explore agent with a plan-mode tool boundary", async () => {
    const captured: NativeRunOptions[] = [];
    const parentWorktree = worktrees.ensure(task);
    const tool = createAgentTool({
      task,
      prepared: { root: parentWorktree.path, outDir: join(parentWorktree.path, "out"), inputs: [] },
      settings: settings(),
      permissions,
      signal: new AbortController().signal,
      worktrees,
      parentWorktree,
      runner: async (options) => {
        captured.push(options);
        return result("找到 README.md:1");
      }
    });

    const output = await tool.execute({ subagent_type: "explore", description: "定位 README", prompt: "找到入口文档并返回行号" }, context(parentWorktree.path));

    expect(output.content).toContain("agentId:");
    expect(output.content).toContain("type: explore");
    expect(output.metadata).toMatchObject({ subagentType: "explore", agentStatus: "completed" });
    expect(captured[0]?.mode).toBe("plan");
    expect(captured[0]?.task.goal).toBe("找到入口文档并返回行号");
    expect(captured[0]?.permissions?.tools).toContain("agent");
    expect(captured[0]?.extraTools?.some((tool) => tool.definition.name === "agent")).toBe(true);
    expect(captured[0]?.prompt).toContain("输出契约");
    const transcriptPath = output.metadata?.transcriptPath;
    expect(transcriptPath && existsSync(transcriptPath)).toBe(true);
    const lines = transcriptPath ? readFileSync(transcriptPath, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
    expect(lines[0]).toMatchObject({ event: "started", type: "explore", title: "定位 README" });
    expect(lines[1]).toMatchObject({ event: "completed", type: "explore", summary: "找到 README.md:1" });
  });

  it("uses the team receipt schema and writes evidence under the stable agent root", async () => {
    const parentWorktree = worktrees.ensure(task);
    const finished: SubagentFinishedInfo[] = [];
    const tool = createAgentTool({
      task,
      prepared: { root: parentWorktree.path, outDir: join(parentWorktree.path, "out"), inputs: [] },
      settings: settings(),
      permissions,
      signal: new AbortController().signal,
      worktrees,
      parentWorktree,
      allowedTypes: ["explore", "plan", "review"],
      defaultOutputSchema: TEAM_RECEIPT_SCHEMA,
      evidenceRoot: join(root, "agents"),
      onFinished: (info) => finished.push(info),
      runner: async () => result(JSON.stringify({
        status: "completed",
        summary: "README 存在",
        evidence: [{ claim: "README 存在", source: "README.md:1" }]
      }))
    });

    const output = await tool.execute({ subagent_type: "explore", description: "核验 README", prompt: "读取 README 并给出证据" }, context(parentWorktree.path));

    expect(output.content).toContain("structured_output");
    expect(output.metadata?.structured).toMatchObject({ status: "completed" });
    const transcript = String(output.metadata?.transcriptPath ?? "");
    expect(transcript.startsWith(join(root, "agents"))).toBe(true);
    expect(existsSync(join(dirname(transcript), "report.json"))).toBe(true);
    expect(finished[0]).toMatchObject({ status: "completed", structured: { status: "completed" } });
  });

  it("keeps a blocked receipt out of completion and reports the real status", async () => {
    const parentWorktree = worktrees.ensure(task);
    const finished: SubagentFinishedInfo[] = [];
    const tool = createAgentTool({
      task,
      prepared: { root: parentWorktree.path, outDir: join(parentWorktree.path, "out"), inputs: [] },
      settings: settings(),
      permissions,
      signal: new AbortController().signal,
      worktrees,
      parentWorktree,
      allowedTypes: ["explore"],
      defaultOutputSchema: TEAM_RECEIPT_SCHEMA,
      evidenceRoot: join(root, "agents"),
      onFinished: (info) => finished.push(info),
      runner: async () => result(JSON.stringify({
        status: "blocked",
        summary: "缺少远端凭据，无法核验",
        evidence: [{ claim: "远端返回 401", source: "curl https://example.test" }],
        unresolved: ["需要用户提供测试凭据"]
      }))
    });

    const output = await tool.execute({ subagent_type: "explore", description: "核验远端", prompt: "核验远端数据" }, context(parentWorktree.path));

    expect(output.content).toContain("status: blocked");
    expect(output.metadata).toMatchObject({ agentStatus: "blocked" });
    expect(finished[0]).toMatchObject({
      status: "blocked",
      structured: { status: "blocked", unresolved: ["需要用户提供测试凭据"] }
    });
    const report = String(output.metadata?.reportPath ?? "");
    expect(JSON.parse(readFileSync(report, "utf8")).status).toBe("blocked");
  });

  it("rejects write-capable member types in Team v1", async () => {
    const parentWorktree = worktrees.ensure(task);
    const tool = createAgentTool({
      task,
      prepared: { root: parentWorktree.path, outDir: join(parentWorktree.path, "out"), inputs: [] },
      settings: settings(),
      permissions,
      signal: new AbortController().signal,
      worktrees,
      parentWorktree,
      allowedTypes: ["explore", "plan", "review"],
      runner: async () => result("不应运行")
    });
    const definition = tool.definition.parameters as { properties?: { subagent_type?: { enum?: string[] } } };
    expect(definition.properties?.subagent_type?.enum).toEqual(["explore", "plan", "review"]);
    await expect(tool.execute({ subagent_type: "general-purpose", description: "写入", prompt: "改文件" }, context(parentWorktree.path)))
      .rejects.toThrow("当前 Agent 模式不支持子代理类型");
  });

  it("starts background agents and exposes wait/status/kill", async () => {
    const parentWorktree = worktrees.ensure(task);
    const manager = new SubagentTaskManager(2);
    const tool = createAgentTool({
      task,
      prepared: { root: parentWorktree.path, outDir: join(parentWorktree.path, "out"), inputs: [] },
      settings: settings(),
      permissions,
      signal: new AbortController().signal,
      worktrees,
      parentWorktree,
      manager,
      runner: async () => {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 30));
        return result("后台完成");
      }
    });
    const lifecycle = createAgentLifecycleTools(manager);
    const waitTool = lifecycle.find((item) => item.definition.name === "agent_wait")!;
    const statusTool = lifecycle.find((item) => item.definition.name === "agent_status")!;

    const started = await tool.execute({ subagent_type: "explore", description: "后台调查", prompt: "调查", run_in_background: true }, context(parentWorktree.path));
    expect(started.content).toContain("status: running");
    const waited = await waitTool.execute({ agent_id: started.metadata?.agentId, timeout_seconds: 1 }, context(parentWorktree.path));
    expect(waited.content).toContain("status: completed");
    expect(waited.content).toContain("后台完成");
    expect((await statusTool.execute({}, context(parentWorktree.path))).content).toContain("completed");
    const notifications = manager.takeNotifications();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.content).toContain("<subagent_notification>");
  });

  it("persists sessions, reports stalls, and resumes a killed child", async () => {
    const parentWorktree = worktrees.ensure(task);
    const sessionPath = join(root, "subagents", "session.json");
    let calls = 0;
    const manager = new SubagentTaskManager(2, sessionPath);
    const tool = createAgentTool({
      task,
      prepared: { root: parentWorktree.path, outDir: join(parentWorktree.path, "out"), inputs: [] },
      settings: settings(),
      permissions,
      signal: new AbortController().signal,
      worktrees,
      parentWorktree,
      manager,
      runner: async () => {
        calls += 1;
        return result(calls === 1 ? "第一轮" : "续跑完成");
      }
    });

    const started = await tool.execute({ subagent_type: "explore", description: "持久化", prompt: "调查", run_in_background: true }, context(parentWorktree.path));
    const id = String(started.metadata?.agentId);
    await manager.wait(id, 100);
    expect(manager.get(id)?.status).toBe("completed");
    expect(existsSync(sessionPath)).toBe(true);

    const reloaded = new SubagentTaskManager(2, sessionPath);
    expect(reloaded.get(id)?.status).toBe("completed");
    expect(manager.sendMessage(id, "继续补充")).toMatchObject({ status: "running" });
    const resumed = await manager.wait(id, 100);
    expect(resumed.status).toBe("completed");
    expect(resumed.summary).toContain("续跑完成");
    expect(calls).toBe(2);

    const stalled = new SubagentTaskManager(2, join(root, "subagents", "stalled.json"));
    stalled.start({ id: "stalled", type: "explore", title: "stalled" }, () => new Promise(() => undefined));
    const notices = stalled.stallNotices(Date.now() + 16 * 60_000);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.content).toContain("stall");
  });

  it("creates an isolated child worktree from the parent HEAD and commits its changes", async () => {
    const parentWorktree = worktrees.ensure(task);
    writeFileSync(join(parentWorktree.path, "parent.txt"), "parent commit\n", "utf8");
    git(parentWorktree.path, ["add", "parent.txt"]);
    git(parentWorktree.path, ["commit", "-m", "parent work"]);
    const parentHead = gitOutput(parentWorktree.path, ["rev-parse", "HEAD"]).trim();
    const parentStatus = gitOutput(parentWorktree.path, ["status", "--porcelain"]);
    let childRoot = "";
    const tool = createSubagentTool({
      task,
      prepared: { root: parentWorktree.path, outDir: join(parentWorktree.path, "out"), inputs: [] },
      settings: settings(),
      permissions,
      signal: new AbortController().signal,
      worktrees,
      parentWorktree,
      runner: async (options) => {
        childRoot = options.prepared.root;
        expect(options.permissions?.writeRoots).toContain(childRoot);
        expect(options.permissions?.writeRoots).not.toContain(parentWorktree.path);
        writeFileSync(join(childRoot, "child.txt"), "child change\n", "utf8");
        return result("已实现隔离改动");
      }
    });

    const output = await tool.execute({ objective: "完成一项独立代码改动", mode: "isolated-write", title: "独立改动" }, context(parentWorktree.path));

    expect(childRoot).not.toBe(parentWorktree.path);
    expect(existsSync(join(childRoot, "child.txt"))).toBe(true);
    expect(gitOutput(parentWorktree.path, ["status", "--porcelain"])).toBe(parentStatus);
    expect(gitOutput(parentWorktree.path, ["show", "HEAD:README.md"])).toBe("base\n");
    expect(output.content).toContain("agentId:");
    expect(output.content).toContain("type: general-purpose");
    expect(output.content).toContain("branch: hearth/");
    expect(output.content).toContain("commit:");
    const recorded = store.listTaskWorktrees(projectId).find((item) => item.path === childRoot);
    expect(recorded?.baseSha).toBe(parentHead);
    expect(gitOutput(childRoot, ["rev-parse", "HEAD"])).not.toBe(parentHead);
    expect(gitOutput(childRoot, ["log", "-1", "--format=%s"])).toContain("hearth subagent");
  });

  it("validates a child output schema before marking it completed", async () => {
    const parentWorktree = worktrees.ensure(task);
    let answer = '{"files":["README.md"],"risk":"low"}';
    const tool = createAgentTool({
      task,
      prepared: { root: parentWorktree.path, outDir: join(parentWorktree.path, "out"), inputs: [] },
      settings: settings(),
      permissions,
      signal: new AbortController().signal,
      worktrees,
      parentWorktree,
      runner: async () => result(answer)
    });
    const outputSchema = {
      type: "object",
      required: ["files", "risk"],
      properties: { files: { type: "array", items: { type: "string" } }, risk: { type: "string", enum: ["low", "high"] } },
      additionalProperties: false
    };

    const output = await tool.execute({ subagent_type: "explore", description: "结构化输出", prompt: "检查 README", output_schema: outputSchema }, context(parentWorktree.path));
    expect(output.content).toContain('structured_output: {"files":["README.md"],"risk":"low"}');

    answer = '{"files":"README.md","risk":"low"}';
    await expect(tool.execute({ subagent_type: "explore", description: "结构化输出", prompt: "检查 README", output_schema: outputSchema }, context(parentWorktree.path)))
      .rejects.toThrow("SUBAGENT_SCHEMA_FAILED");
  });

  it("resumes a completed child from persisted session and checkpoint after a restart", async () => {
    const parentWorktree = worktrees.ensure(task);
    const sessionPath = join(root, "subagents", "cold-session.json");
    let resumedFromCheckpoint = false;
    const options = {
      task,
      prepared: { root: parentWorktree.path, outDir: join(parentWorktree.path, "out"), inputs: [] },
      settings: settings(),
      permissions,
      signal: new AbortController().signal,
      worktrees,
      parentWorktree,
      runner: async (input: NativeRunOptions) => {
        expect(input.onCheckpoint).toBeTypeOf("function");
        resumedFromCheckpoint = Boolean(input.resume);
        await input.onCheckpoint?.({
          seq: 1,
          kind: "turn",
          messages: [{ role: "system", content: "system" }, { role: "user", content: "检查 README" }, { role: "assistant", content: "已有进度", toolCalls: [] }],
          usage: usage(1),
          turns: 1,
          toolCalls: 0,
          summary: "已有进度"
        });
        return result(resumedFromCheckpoint ? "冷恢复完成" : "首次完成");
      }
    };
    const manager = new SubagentTaskManager(2, sessionPath);
    const tool = createAgentTool({ ...options, manager });
    const started = await tool.execute({ subagent_type: "explore", description: "冷恢复", prompt: "检查 README", run_in_background: true }, context(parentWorktree.path));
    const id = String(started.metadata?.agentId);
    await manager.wait(id, 100);

    const reloaded = new SubagentTaskManager(2, sessionPath);
    reloaded.setResumeHandler(createSubagentResumeHandler(options));
    expect(reloaded.get(id)?.status).toBe("completed");
    expect(reloaded.get(id)?.session).toBeDefined();
    reloaded.sendMessage(id, "继续补充结论");
    const resumed = await reloaded.wait(id, 100);
    expect(resumed.status).toBe("completed");
    expect(resumed.summary).toContain("冷恢复完成");
    expect(resumedFromCheckpoint).toBe(true);
  });

  it("enforces the two-subagent limit and rejects nested delegation", async () => {
    const parentWorktree = worktrees.ensure(task);
    let calls = 0;
    const tool = createSubagentTool({
      task,
      prepared: { root: parentWorktree.path, outDir: join(parentWorktree.path, "out"), inputs: [] },
      settings: settings(),
      permissions,
      signal: new AbortController().signal,
      worktrees,
      parentWorktree,
      maxSubagents: 2,
      runner: async () => {
        calls += 1;
        return result("完成");
      }
    });

    await tool.execute({ objective: "第一项", mode: "read-only" }, context(parentWorktree.path));
    await tool.execute({ objective: "第二项", mode: "read-only" }, context(parentWorktree.path));
    await expect(tool.execute({ objective: "第三项", mode: "read-only" }, context(parentWorktree.path)))
      .rejects.toThrow("最多启动 2 个");
    expect(calls).toBe(2);

    const nested = createSubagentTool({
      task,
      prepared: { root: parentWorktree.path, outDir: join(parentWorktree.path, "out"), inputs: [] },
      settings: settings(),
      permissions,
      signal: new AbortController().signal,
      worktrees,
      parentWorktree,
      depth: 3,
      runner: async () => result("不应运行")
    });
    await expect(nested.execute({ objective: "嵌套", mode: "read-only" }, context(parentWorktree.path)))
      .rejects.toThrow("最多委派 2 层");
  });
});

function taskRecord(id: string, projectId: string): TaskRecord {
  const now = new Date().toISOString();
  return {
    id,
    templateId: null,
    title: "父任务",
    goal: "完成父任务",
    status: "running",
    createdAt: now,
    updatedAt: now,
    deadline: null,
    inputs: [],
    networkHosts: [],
    outputDir: ".hearth/out",
    currentRunId: null,
    nextAction: null,
    error: null,
    executorId: "native",
    taskKind: "workspace",
    projectId
  };
}

function settings(): ModelSettings {
  return {
    providerId: "test",
    providerName: "Test",
    protocol: "openai-chat",
    baseUrl: "https://example.test/v1",
    model: "test-model",
    contextWindowTokens: 128_000,
    maxOutputTokens: 8_000,
    apiKey: "test",
    updatedAt: null
  };
}

function result(summary: string, value = usage(0)): NativeRunResult {
  return {
    status: "completed",
    finalResponse: summary,
    usage: value,
    turns: 1,
    toolCalls: 1,
    question: null,
    outputs: []
  };
}

function usage(value: number) {
  return {
    inputTokens: value,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: value,
    reasoningOutputTokens: 0
  };
}

function context(workspaceRoot: string): { workspaceRoot: string; outDir: string; permissions: TaskPermissions; signal: AbortSignal } {
  return {
    workspaceRoot,
    outDir: join(workspaceRoot, "out"),
    permissions: {
      readRoots: [workspaceRoot],
      writeRoots: [],
      networkHosts: [],
      tools: ["finish_task"]
    },
    signal: new AbortController().signal
  };
}

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 20_000, windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || result.error?.message || "git failed");
}

function gitOutput(cwd: string, args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 20_000, windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || result.error?.message || "git failed");
  return result.stdout;
}
