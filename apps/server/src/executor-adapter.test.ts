import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ContextSettings, ExecutorSettings, RunBudget, TaskRecord } from "@hearth/core";
import {
  ExternalExecutorAdapter,
  createExecutorAdapters,
  type CodexRunner,
  type ExternalRunner,
  type HermesRunner,
  type NativeRunner
} from "./executor-adapter.ts";
import type { ExecutorInvocation } from "./executor-adapter.ts";
import type { PreparedWorkspace } from "./workspace.ts";
import { defaultExecutorSettings } from "./executor-settings.ts";

const EXTERNAL_IDS = ["qoder", "workbuddy", "kimi"] as const;
const roots: string[] = [];
const previousDetect = process.env.HEARTH_EXECUTOR_DETECT;

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "hearth-adapter-"));
  roots.push(root);
  return root;
}

function writeFile(path: string, content = "export {};\n"): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function configureExecutable(settings: ExecutorSettings, id: (typeof EXTERNAL_IDS)[number], root: string): string {
  const path = join(root, `${id}.mjs`);
  writeFile(path);
  settings.executors[id] = { executablePath: path };
  return path;
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
    onHermesContextItem: () => undefined,
    onDshContextItem: () => undefined,
    onCodexContextItem: () => undefined,
    onCodexThreadStarted: () => undefined
  };
}

describe("external executor adapters", () => {
  beforeEach(() => {
    process.env.HEARTH_EXECUTOR_DETECT = "off";
  });

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
    if (previousDetect === undefined) delete process.env.HEARTH_EXECUTOR_DETECT;
    else process.env.HEARTH_EXECUTOR_DETECT = previousDetect;
  });

  it.each(EXTERNAL_IDS)("executes %s and forwards its session", async (id) => {
    const root = tempRoot();
    const settingsPath = join(root, "executor-settings.json");
    const settings = defaultExecutorSettings();
    configureExecutable(settings, id, root);
    const calls: Parameters<ExternalRunner>[0][] = [];
    const progress: string[] = [];
    const runner: ExternalRunner = async (options) => {
      calls.push(options);
      options.onProgress?.({ type: "text", message: "working" });
      return {
        finalResponse: `done by ${id}`,
        usage: null,
        sessionId: `session-${id}`,
        exitCode: 0,
        durationMs: 12
      };
    };
    const adapter = new ExternalExecutorAdapter(id, settingsPath, runner);

    expect(adapter.supportsResume).toBe(true);
    expect(adapter.canRun({
      task: invocation(settings, root).task,
      prepared: null,
      settings: {} as ContextSettings,
      executorSettings: settings
    }).ok).toBe(true);

    const outcome = await adapter.execute(invocation(settings, root, progress));
    expect(calls[0]).toMatchObject({
      id,
      workingDirectory: root,
      prompt: "do the work",
      mode: "full",
      maxTurns: 7,
      runBudgetSeconds: 90,
      resumeSessionId: "thread-previous"
    });
    expect(outcome).toMatchObject({
      status: "completed",
      finalResponse: `done by ${id}`,
      threadId: `session-${id}`,
      question: null
    });
    expect(outcome.label).toContain(`session-${id}`);
    expect(progress).toEqual(["text"]);
  });

  it("reports an actionable reason when an executor is missing", () => {
    const root = tempRoot();
    const settings = defaultExecutorSettings();
    const adapter = new ExternalExecutorAdapter("kimi", join(root, "executor-settings.json"), async () => {
      throw new Error("should not run");
    });
    const availability = adapter.canRun({
      task: invocation(settings, root).task,
      prepared: null,
      settings: {} as ContextSettings,
      executorSettings: settings
    });
    expect(availability.ok).toBe(false);
    expect(availability.reason).toContain("Kimi Code");
    expect(availability.reason).toContain("设置");
  });

  it("wires all four external executors through the factory", () => {
    const root = tempRoot();
    const settingsPath = join(root, "executor-settings.json");
    const adapters = createExecutorAdapters({
      native: (async () => { throw new Error("unused"); }) as NativeRunner,
      codex: (async () => { throw new Error("unused"); }) as CodexRunner,
      hermes: (async () => { throw new Error("unused"); }) as HermesRunner,
      settingsPath
    });
    for (const id of EXTERNAL_IDS) expect(adapters[id]).toBeInstanceOf(ExternalExecutorAdapter);
  });
});
