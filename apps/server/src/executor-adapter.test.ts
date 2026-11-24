import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ContextSettings, ExecutorSettings, RunBudget, TaskRecord } from "@hearth/core";
import { NativeExecutorAdapter } from "./executor-adapter.ts";
import type { ExecutorInvocation } from "./executor-adapter.ts";
import type { PreparedWorkspace } from "./workspace.ts";
import { defaultExecutorSettings } from "./executor-settings.ts";
import { nativePermissionsFor } from "./native-executor.ts";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "hearth-adapter-"));
  roots.push(root);
  return root;
}

function invocation(settings: ExecutorSettings, root: string, progress: string[] = []): ExecutorInvocation {
  return {
    task: {
      id: "task-1",
      title: "Build the thing",
      goal: "Write result.md",
      inputs: [],
      permissions: { tools: [] }
    } as unknown as TaskRecord,
    run: {} as unknown as ExecutorInvocation["run"],
    prepared: { root } as PreparedWorkspace,
    budget: { maxTurns: 7, maxDurationMs: 90_000 } as RunBudget,
    signal: new AbortController().signal,
    fullPermission: true,
    contextSettings: {} as ContextSettings,
    nativeSettings: null,
    dshSettings: null,
    executorSettings: settings,
    prompt: "do the work",
    expectedOutputs: ["result.md"],
    activeThreadId: "thread-previous",
    onProgress: (event) => progress.push(event.kind),
    onNativeContextEvent: () => undefined,
    onNativeCheckpoint: () => undefined,
    onDshContextItem: () => undefined,
    onCodexContextItem: () => undefined,
    onCodexThreadStarted: () => undefined
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

describe("executor adapters", () => {
  it("allows native to attempt GitHub repository work", () => {
    const root = tempRoot();
    const adapter = new NativeExecutorAdapter(async () => {
      throw new Error("should not run");
    });
    const availability = adapter.canRun({
      task: {
        ...invocation(defaultExecutorSettings(), root).task,
        title: "审核 GitHub PR",
        goal: "列出需要 rebase 的 PR"
      },
      prepared: null,
      settings: {} as ContextSettings,
      executorSettings: defaultExecutorSettings()
    });
    expect(availability.ok).toBe(true);
  });

  it("grants native GitHub tasks shell access and GitHub network hosts", () => {
    const root = tempRoot();
    const task = {
      ...invocation(defaultExecutorSettings(), root).task,
      title: "审核 GitHub PR",
      goal: "列出需要 rebase 的 PR",
      taskKind: "workspace",
      networkHosts: ["github.com", "api.github.com"],
      permissions: {
        readRoots: [root],
        writeRoots: [root],
        networkHosts: ["github.com", "api.github.com"],
        tools: ["read_file", "finish_task"]
      }
    } as TaskRecord;
    const permissions = nativePermissionsFor(task, { root, outDir: join(root, "out") } as PreparedWorkspace);
    expect(permissions.tools).toContain("shell");
    expect(permissions.networkHosts).toEqual(expect.arrayContaining(["github.com", "api.github.com"]));
  });

  it("falls back to builtin tools when the task carries an empty tool list", () => {
    const root = tempRoot();
    const task = {
      ...invocation(defaultExecutorSettings(), root).task,
      taskKind: "general",
      networkHosts: [],
      permissions: { readRoots: [root], writeRoots: [root], networkHosts: [], tools: [] }
    } as TaskRecord;
    const permissions = nativePermissionsFor(task, { root, outDir: join(root, "out") } as PreparedWorkspace);
    expect(permissions.tools).toContain("read_file");
    expect(permissions.tools).toContain("write_file");
    expect(permissions.tools).toContain("finish_task");
    expect(permissions.tools).toContain("ask_user");
    expect(permissions.tools).toContain("read_desktop_file");
  });

  it("keeps ask_user available when full permission is enabled", async () => {
    const root = tempRoot();
    let observedTools: string[] = [];
    const adapter = new NativeExecutorAdapter(async (options) => {
      observedTools = [...(options.permissions?.tools ?? [])];
      return {
        status: "completed",
        finalResponse: "done",
        usage: { inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
        turns: 1,
        toolCalls: 0,
        question: null,
        outputs: []
      };
    });
    await adapter.execute({
      ...invocation(defaultExecutorSettings(), root),
      task: {
        ...invocation(defaultExecutorSettings(), root).task,
        networkHosts: []
      },
      fullPermission: true,
      nativeSettings: { protocol: "openai-chat" } as ExecutorInvocation["nativeSettings"]
    });
    expect(observedTools).toContain("ask_user");
  });

  it("keeps an explicit tool restriction instead of adding builtin tools", () => {
    const root = tempRoot();
    const task = {
      ...invocation(defaultExecutorSettings(), root).task,
      taskKind: "general",
      networkHosts: [],
      permissions: { readRoots: [root], writeRoots: [root], networkHosts: [], tools: ["shell"] }
    } as TaskRecord;
    const permissions = nativePermissionsFor(task, { root, outDir: join(root, "out") } as PreparedWorkspace);
    expect(permissions.tools).toContain("shell");
    expect(permissions.tools).not.toContain("read_file");
    expect(permissions.tools).not.toContain("finish_task");
  });
});
