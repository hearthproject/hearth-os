import { describe, expect, it } from "vitest";
import { createJobTools } from "./job-tools.ts";
import type { BackgroundToolService } from "./background-tools.ts";
import type { SubagentTaskManager } from "./subagent-manager.ts";
import { createAgentState } from "../../../packages/agent-runtime/src/harness/file-state.ts";
import type { AgentToolContext } from "@hearth/agent-runtime";

function context(): AgentToolContext {
  const state = createAgentState("/workspace");
  state.activeWork = [{ id: "shell-1", kind: "shell", status: "running", startedAt: Date.now() }];
  return {
    workspaceRoot: "/workspace",
    outDir: "/workspace/out",
    permissions: { tools: ["job_list", "job_status", "job_wait", "job_stop"], readRoots: [], writeRoots: [], networkHosts: [] },
    signal: new AbortController().signal,
    state
  };
}

function background(): BackgroundToolService {
  return {
    list: () => [{
      id: "bgtool:1", taskId: "task-1", runId: "run-1", toolName: "shell", args: {}, status: "running",
      output: "partial", outputRef: null, exitCode: null, stopReason: null,
      createdAt: "2026-11-21T00:00:00.000Z", updatedAt: "2026-11-21T00:00:00.000Z", finishedAt: null
    }],
    get: (id: string) => id === "bgtool:1" ? { id, status: "running", output: "partial", stopReason: null } : null,
    waitFor: async (id: string) => ({ id, status: "finished", output: "done", stopReason: null }),
    stop: (id: string) => ({ id, status: "stopped", output: "", stopReason: "user" })
  } as unknown as BackgroundToolService;
}

function subagents(): SubagentTaskManager {
  return {
    status: () => [{
      id: "agent-1", type: "explore", title: "检查", status: "running",
      startedAt: "2026-11-21T00:00:00.000Z", endedAt: null, lastProgressAt: "2026-11-21T00:00:10.000Z",
      summary: null, error: null
    }],
    get: (id: string) => id === "agent-1" ? { id } : null,
    wait: async (id: string) => ({ id, status: "running", summary: null }),
    kill: (id: string) => id === "agent-1"
  } as unknown as SubagentTaskManager;
}

describe("unified job tools", () => {
  it("lists background tools, subagents and shell sessions together", async () => {
    const tools = Object.fromEntries(createJobTools({ owner: { taskId: "task-1", runId: "run-1" }, background: background(), subagents: subagents() })
      .map((tool) => [tool.definition.name, tool]));
    const result = await tools.job_list!.execute({}, context());
    expect(result.content).toContain("bgtool:1");
    expect(result.content).toContain("agent-1");
    expect(result.content).toContain("shell-1");
  });

  it("waits for a background job and reports structured timeouts", async () => {
    const tools = Object.fromEntries(createJobTools({ owner: { taskId: "task-1", runId: "run-1" }, background: background(), subagents: subagents() })
      .map((tool) => [tool.definition.name, tool]));
    const waited = await tools.job_wait!.execute({ id: "bgtool:1", timeoutMs: 1_000 }, context());
    expect(waited.content).toContain("finished");
    await expect(tools.job_wait!.execute({ id: "agent-1", timeoutMs: 1_000 }, context()))
      .rejects.toMatchObject({ code: "JOB_TIMEOUT" });
  });

  it("stops a job through the owning service", async () => {
    const tools = Object.fromEntries(createJobTools({ owner: { taskId: "task-1", runId: "run-1" }, background: background(), subagents: subagents() })
      .map((tool) => [tool.definition.name, tool]));
    const stopped = await tools.job_stop!.execute({ id: "bgtool:1", reason: "user" }, context());
    expect(stopped.content).toContain("stopped");
  });
});
