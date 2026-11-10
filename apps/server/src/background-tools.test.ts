import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HearthStore } from "@hearth/eventlog";
import { BackgroundToolService } from "./background-tools.ts";
import { HearthService } from "./service.ts";

describe("BackgroundToolService", () => {
  let root: string | null = null;
  let store: HearthStore | null = null;

  afterEach(() => {
    store?.close();
    store = null;
    if (root) rmSync(root, { recursive: true, force: true });
    root = null;
  });

  function setup(maxConcurrent = 2, authorize?: (toolName: string) => Promise<void>) {
    root = mkdtempSync(join(tmpdir(), "hearth-bgtool-"));
    store = new HearthStore(":memory:");
    const service = new HearthService(store);
    const tools = new BackgroundToolService(service, {
      maxConcurrent,
      ...(authorize ? { authorize: (input) => authorize(input.job.toolName) } : {}),
      runner: async (job, signal) => {
        if (job.toolName === "list_files") {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, 5_000);
            signal.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(new Error("aborted"));
            }, { once: true });
          });
          return { output: "slow done", exitCode: 0 };
        }
        return { output: `ran ${job.toolName}`, exitCode: 0 };
      }
    });
    return { service, tools };
  }

  it("runs a job to completion and persists its output", async () => {
    const { service, tools } = setup();
    const task = service.createTask({ title: "bg", goal: "run background tool" });
    const job = await tools.start({ taskId: task.id, toolName: "read_file", args: { a: 1 } });
    const finished = await tools.waitFor(job.id, 5_000);
    expect(finished.status).toBe("finished");
    expect(finished.output).toContain("ran read_file");
    expect(store?.getBackgroundToolJob(job.id)?.status).toBe("finished");
    expect(tools.list({ taskId: task.id })).toHaveLength(1);
  });

  it("stops a slow job and exposes the interruption", async () => {
    const { service, tools } = setup();
    const task = service.createTask({ title: "bg", goal: "stop" });
    const job = await tools.start({ taskId: task.id, toolName: "list_files" });
    const stopped = tools.stop(job.id, "用户不需要了");
    expect(stopped.status).toBe("stopped");
    expect(stopped.stopReason).toBe("用户不需要了");
    const settled = await tools.waitFor(job.id, 5_000);
    expect(["stopped", "failed"]).toContain(settled.status);
  });

  it("enforces the concurrency cap", async () => {
    const { service, tools } = setup(1);
    const task = service.createTask({ title: "bg", goal: "cap" });
    const first = await tools.start({ taskId: task.id, toolName: "list_files" });
    await expect(tools.start({ taskId: task.id, toolName: "read_file" })).rejects.toMatchObject({
      code: "BACKGROUND_TOOL_BUSY"
    });
    tools.stop(first.id, "结束");
  });

  it("refuses non-read-only tools without an authorization channel", async () => {
    const { service, tools } = setup();
    const task = service.createTask({ title: "bg", goal: "secure" });
    await expect(tools.start({ taskId: task.id, toolName: "shell" })).rejects.toMatchObject({
      code: "BACKGROUND_TOOL_APPROVAL_REQUIRED"
    });
  });

  it("runs a sensitive tool only after the authorization hook succeeds", async () => {
    const seen: string[] = [];
    const { service, tools } = setup(2, async (toolName) => { seen.push(toolName); });
    const task = service.createTask({ title: "bg", goal: "approved" });
    const job = await tools.start({ taskId: task.id, toolName: "shell", args: { command: "echo ok" } });
    expect(seen).toEqual(["shell"]);
    expect((await tools.waitFor(job.id, 5_000)).status).toBe("finished");
  });

  it("exposes agent tools for start and check", async () => {
    const { service, tools } = setup();
    const task = service.createTask({ title: "bg", goal: "tools" });
    const [startTool, checkTool] = tools.toolsFor(task);
    const started = await startTool!.execute({ toolName: "read_file", args: {} }, {
      workspaceRoot: root!, outDir: root!, permissions: { readRoots: [root!], writeRoots: [], networkHosts: [], tools: [] }, signal: new AbortController().signal
    });
    const jobId = started.content.match(/bgtool:[a-f0-9-]+/)?.[0] ?? "";
    expect(jobId).toBeTruthy();
    await tools.waitFor(jobId, 5_000);
    const checked = await checkTool!.execute({ jobId }, {
      workspaceRoot: root!, outDir: root!, permissions: { readRoots: [root!], writeRoots: [], networkHosts: [], tools: [] }, signal: new AbortController().signal
    });
    expect(checked.content).toContain("finished");
  });
});