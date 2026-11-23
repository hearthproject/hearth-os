import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createAgentState } from "../../packages/agent-runtime/src/harness/file-state.ts";
import { deserializeAgentState } from "../../packages/agent-runtime/src/harness/checkpoint-state.ts";
import { finishActiveWork, startActiveWork } from "../../packages/agent-runtime/src/harness/active-work.ts";
import { createGoalTools } from "../../packages/agent-runtime/src/harness/goal.ts";
import { ToolCatalog } from "../../packages/agent-runtime/src/harness/tool-catalog.ts";
import { runAgent } from "../../packages/agent-runtime/src/runtime.ts";
import { JsonlOperationLedger } from "../../packages/agent-runtime/src/operations/journal-ledger.ts";
import type {
  DispatchOperationInput,
  OperationFact,
  OperationLedger,
  PrepareOperationInput,
  SettleCleanupInput,
  SettleOperationInput
} from "../../packages/agent-runtime/src/operations/types.ts";
import { createBuiltinTools } from "../../packages/agent-runtime/src/tools.ts";
import { createFakeModel, fakeToolCall, fakeUsage, type FakeModelStep } from "../../packages/agent-runtime/src/test-support/fake-model.ts";
import type { AgentCheckpoint, AgentTool, AgentToolContext, RuntimeEvent } from "../../packages/agent-runtime/src/types.ts";
import { SubagentTaskManager } from "../../apps/server/src/subagent-manager.ts";

interface CaseRecord {
  name: string;
  passed: boolean;
  durationMs: number;
  detail: Record<string, unknown>;
  error?: string;
}

const records: CaseRecord[] = [];
const roots: string[] = [];

afterAll(() => {
  const passed = records.filter((record) => record.passed).length;
  const maxPeak = Math.max(0, ...records.map((record) => Number(record.detail.tokenPeak ?? 0)));
  const recoveries = records.reduce((sum, record) => sum + Number(record.detail.recoveries ?? 0), 0);
  const compactions = records.reduce((sum, record) => sum + Number(record.detail.compactions ?? 0), 0);
  const report = [
    `# Long-run harness acceptance matrix (${new Date().toISOString().slice(0, 10)})`,
    "",
    "Offline matrix using the deterministic fake model. No API key, network or real provider is used.",
    "",
    `- Cases: **${passed}/${records.length} passed**`,
    `- Max estimated context peak: **${maxPeak} tokens**`,
    `- Simulated recoveries: **${recoveries}**`,
    `- Compactions observed: **${compactions}**`,
    "",
    "| Case | Result | Duration | Notes |",
    "|---|---|---|---|",
    ...records.map((record) => `| ${record.name} | ${record.passed ? "PASS" : "FAIL"} | ${record.durationMs}ms | ${record.error ?? compact(record.detail)} |`),
    "",
    "## Environment",
    "",
    "- Runtime: `packages/agent-runtime` with the deterministic fake model.",
    "- Command: `npm run test:longrun`.",
    "- Scope: checkpoint survival, restarts, provider errors, truncation, large output, tool catalog, goals, verifier, subagent stalls and active-work finish gate.",
    ""
  ].join("\n");
  const dir = join(process.cwd(), "docs", "evaluation");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `harness-longrun-${new Date().toISOString().slice(0, 10)}.md`), report, "utf8");
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("long-run acceptance matrix", () => {
  it("survives 500 turns with bounded checkpoints", async () => {
    await runCase("500 turns", async () => {
      const root = workspace();
      const steps: FakeModelStep[] = [];
      for (let index = 0; index < 500; index++) {
        steps.push({ content: "", toolCalls: [fakeToolCall("echo", { value: String(index) })], usage: fakeUsage(100, 5), finishReason: "tool_calls" });
      }
      steps.push({ content: "done", toolCalls: [fakeToolCall("finish_task", { summary: "done" })], usage: fakeUsage(200, 10), finishReason: "tool_calls" });
      const fake = createFakeModel(steps);
      let checkpoints = 0;
      const result = await runAgent({
        model: fake.model,
        tools: [echoTool(), ...createBuiltinTools().filter((tool) => tool.definition.name === "finish_task")],
        goal: "500 turns",
        systemPrompt: "system",
        workspaceRoot: root,
        outDir: join(root, "out"),
        permissions: { tools: ["echo", "finish_task"], readRoots: [root], writeRoots: [root], networkHosts: [] },
        budget: {},
        onCheckpoint: () => { checkpoints += 1; }
      });
      expect(result.status).toBe("completed");
      expect(result.turns).toBe(501);
      expect(checkpoints).toBeGreaterThanOrEqual(501);
      return { tokenPeak: Math.max(...(result.metrics?.contextPeaks ?? [0])), checkpoints };
    });
  });

  it("resumes twice from committed checkpoints without replaying tools", async () => {
    await runCase("two restarts", async () => {
      const root = workspace();
      const tools = [echoTool(), ...createBuiltinTools().filter((tool) => tool.definition.name === "finish_task")];
      const permissions = { tools: ["echo", "finish_task"], readRoots: [root], writeRoots: [root], networkHosts: [] };
      const echoSteps = Array.from({ length: 6 }, (_, index): FakeModelStep => ({
        content: "", toolCalls: [fakeToolCall("echo", { value: String(index) })], usage: fakeUsage(10, 2), finishReason: "tool_calls"
      }));
      const first = createFakeModel(echoSteps);
      const checkpoints: AgentCheckpoint[] = [];
      const firstRun = await runAgent({
        model: first.model, tools, goal: "restart", systemPrompt: "system", workspaceRoot: root,
        outDir: join(root, "out"), permissions, budget: { maxTurns: 3 },
        onCheckpoint: (checkpoint) => { checkpoints.push(checkpoint); }
      });
      expect(firstRun.status).toBe("budget_exceeded");
      const cp1 = [...checkpoints].reverse().find((checkpoint) => checkpoint.messages.length > 0 && checkpoint.kind === "budget")!;
      const state1 = deserializeAgentState(cp1.state);
      expect(state1).toBeTruthy();

      const second = createFakeModel(echoSteps.slice(3));
      const secondCheckpoints: AgentCheckpoint[] = [];
      const secondRun = await runAgent({
        model: second.model, tools, goal: "restart", systemPrompt: "system", workspaceRoot: root,
        outDir: join(root, "out"), permissions, budget: { maxTurns: 6 },
        resume: { messages: cp1.messages, usage: cp1.usage, turns: cp1.turns, toolCalls: cp1.toolCalls, ...(state1 ? { state: state1 } : {}) },
        onCheckpoint: (checkpoint) => { secondCheckpoints.push(checkpoint); }
      });
      expect(secondRun.status).toBe("budget_exceeded");
      const cp2 = [...secondCheckpoints].reverse().find((checkpoint) => checkpoint.kind === "budget")!;
      const state2 = deserializeAgentState(cp2.state);

      const third = createFakeModel([
        { content: "done", toolCalls: [fakeToolCall("finish_task", { summary: "done" })], finishReason: "tool_calls" }
      ]);
      const thirdRun = await runAgent({
        model: third.model, tools, goal: "restart", systemPrompt: "system", workspaceRoot: root,
        outDir: join(root, "out"), permissions, budget: {},
        resume: { messages: cp2.messages, usage: cp2.usage, turns: cp2.turns, toolCalls: cp2.toolCalls, ...(state2 ? { state: state2 } : {}) }
      });
      expect(thirdRun.status).toBe("completed");
      expect(first.state.calls + second.state.calls + third.state.calls).toBe(7);
      return { recoveries: 2, tokenPeak: Math.max(...(thirdRun.metrics?.contextPeaks ?? [0])) };
    });
  });

  it("stops on checkpoint persistence failure", async () => {
    await runCase("checkpoint disk failure", async () => {
      const root = workspace();
      const fake = createFakeModel([
        { content: "", toolCalls: [fakeToolCall("echo", { value: "a" })], finishReason: "tool_calls" },
        { content: "", toolCalls: [fakeToolCall("finish_task", { summary: "done" })], finishReason: "tool_calls" }
      ]);
      let calls = 0;
      const result = await runAgent({
        model: fake.model, tools: [echoTool(), ...createBuiltinTools().filter((tool) => tool.definition.name === "finish_task")],
        goal: "disk", systemPrompt: "system", workspaceRoot: root, outDir: join(root, "out"),
        permissions: { tools: ["echo", "finish_task"], readRoots: [root], writeRoots: [root], networkHosts: [] },
        budget: {},
        onCheckpoint: () => { calls += 1; if (calls === 2) throw new Error("disk full"); }
      });
      expect(result.status).toBe("failed");
      expect(result.summary).toContain("检查点保存失败");
      return { failures: 1 };
    });
  });

  it("retries 429 and 5xx before failing", async () => {
    await runCase("429 and 5xx retry", async () => {
      const root = workspace();
      const retryable = Object.assign(new Error("rate limit"), { status: 429 });
      const transient = Object.assign(new Error("upstream unavailable"), { status: 503 });
      const fake = createFakeModel([
        { error: retryable },
        { error: transient },
        { content: "done", toolCalls: [fakeToolCall("finish_task", { summary: "done" })], finishReason: "tool_calls" }
      ]);
      const result = await runAgent({
        model: fake.model, tools: [...createBuiltinTools().filter((tool) => tool.definition.name === "finish_task")],
        goal: "retry", systemPrompt: "system", workspaceRoot: root, outDir: join(root, "out"),
        permissions: { tools: ["finish_task"], readRoots: [root], writeRoots: [root], networkHosts: [] },
        budget: {}, retryDelayMs: 1
      });
      expect(result.status).toBe("completed");
      expect(fake.state.calls).toBe(3);

      const exhausted = createFakeModel([{ error: transient }]);
      const failed = await runAgent({
        model: exhausted.model, tools: [], goal: "retry", systemPrompt: "system", workspaceRoot: root,
        outDir: join(root, "out"), permissions: { tools: [], readRoots: [root], writeRoots: [root], networkHosts: [] },
        budget: {}, retryDelayMs: 1
      });
      expect(failed.status).toBe("failed");
      expect(exhausted.state.calls).toBe(6);
      return { retries: 5, recoveries: 1 };
    });
  });

  it("continues truncated output three times and fails on the fourth", async () => {
    await runCase("length continuation", async () => {
      const root = workspace();
      const permissions = { tools: ["finish_task"], readRoots: [root], writeRoots: [root], networkHosts: [] };
      const tools = createBuiltinTools().filter((tool) => tool.definition.name === "finish_task");
      const fake = createFakeModel([
        { content: "part 1", finishReason: "length" },
        { content: "part 2", finishReason: "length" },
        { content: "part 3", finishReason: "length" },
        { content: "done", toolCalls: [fakeToolCall("finish_task", { summary: "done" })], finishReason: "tool_calls" }
      ]);
      const result = await runAgent({
        model: fake.model, tools, goal: "length", systemPrompt: "system", workspaceRoot: root,
        outDir: join(root, "out"), permissions, budget: {}
      });
      expect(result.status).toBe("completed");

      const stuck = createFakeModel([{ content: "part", finishReason: "length" }]);
      const failed = await runAgent({
        model: stuck.model, tools, goal: "length", systemPrompt: "system", workspaceRoot: root,
        outDir: join(root, "out"), permissions, budget: {}
      });
      expect(failed.status).toBe("failed");
      expect(failed.summary).toContain("长度上限");
      return { retries: 3, failures: 1 };
    });
  });

  it("stores a 20MB tool result as an artifact without inflating the message", async () => {
    await runCase("20MB tool output", async () => {
      const root = workspace();
      const fake = createFakeModel([
        { content: "", toolCalls: [fakeToolCall("big")], finishReason: "tool_calls" },
        { content: "done", toolCalls: [fakeToolCall("finish_task", { summary: "done" })], finishReason: "tool_calls" }
      ]);
      const result = await runAgent({
        model: fake.model,
        tools: [bigTool("x".repeat(20 * 1024 * 1024)), ...createBuiltinTools().filter((tool) => tool.definition.name === "finish_task")],
        goal: "big", systemPrompt: "system", workspaceRoot: root, outDir: join(root, "out"),
        permissions: { tools: ["big", "finish_task"], readRoots: [root], writeRoots: [root], networkHosts: [] },
        budget: {}
      });
      const toolMessage = result.messages.find((message) => message.role === "tool" && message.name === "big");
      expect(result.status).toBe("completed");
      expect(toolMessage?.role === "tool" ? toolMessage.content.length : Infinity).toBeLessThan(20_000);
      const artifacts = readdirSync(join(root, "out", ".hearth", "tool-results"));
      expect(artifacts.length).toBeGreaterThan(0);
      return { artifactBytes: 20 * 1024 * 1024 };
    });
  });

  it("limits the initial schema with a 100-tool catalog", async () => {
    await runCase("100 tools", async () => {
      const names = ["finish_task", "jira_create_issue", "jira_search_issues", "jira_transition_issue", ...Array.from({ length: 97 }, (_, index) => `mcp_${index}`)];
      const catalog = new ToolCatalog(names.map((name) => fakeTool(name)));
      const definitions = catalog.definitions();
      const matches = catalog.search("jira");
      expect(catalog.deferred).toBe(true);
      expect(definitions.length).toBeLessThanOrEqual(2);
      expect(matches).toHaveLength(3);
      return { exposed: definitions.length, matched: matches.length };
    });
  });

  it("pauses a 20-turn active goal at its maxGoalRounds", async () => {
    await runCase("goal 20 turns", async () => {
      const root = workspace();
      writeGoal(root, 20);
      const steps: FakeModelStep[] = Array.from({ length: 20 }, (_, index) => ({
        content: "", toolCalls: [fakeToolCall("echo", { value: String(index) })], usage: fakeUsage(50, 5), finishReason: "tool_calls"
      }));
      const fake = createFakeModel(steps);
      const result = await runAgent({
        model: fake.model, tools: [echoTool()], goal: "goal", systemPrompt: "system", workspaceRoot: root,
        outDir: join(root, "out"), permissions: { tools: ["echo"], readRoots: [root], writeRoots: [root], networkHosts: [] },
        budget: {}, maxGoalRounds: 20
      });
      expect(result.status).toBe("waiting_input");
      expect(result.turns).toBe(20);
      expect(result.summary).toContain("20 轮上限");
      return { turns: 20, tokenPeak: Math.max(...(result.metrics?.contextPeaks ?? [0])) };
    });
  });

  it("rejects a self-reported goal completion when the verifier fails", async () => {
    await runCase("goal verifier", async () => {
      const root = workspace();
      writeGoal(root, 50);
      const goalTools = createGoalTools();
      const fake = createFakeModel([
        { content: "", toolCalls: [fakeToolCall("update_goal", { status: "completed", note: "claimed" })], finishReason: "tool_calls" },
        { content: "done", toolCalls: [fakeToolCall("finish_task", { summary: "done" })], finishReason: "tool_calls" }
      ]);
      const result = await runAgent({
        model: fake.model,
        tools: [...goalTools, ...createBuiltinTools().filter((tool) => tool.definition.name === "finish_task")],
        goal: "goal", systemPrompt: "system", workspaceRoot: root, outDir: join(root, "out"),
        permissions: { tools: ["update_goal", "create_goal", "finish_task"], readRoots: [root], writeRoots: [root], networkHosts: [] },
        budget: {},
        verifyGoalCompletion: async () => ({ ok: false, reason: "success criteria not evidenced" })
      });
      expect(result.status).toBe("completed");
      const goal = JSON.parse(readFileSync(join(root, ".hearth", "goal.json"), "utf8")) as { status: string };
      expect(goal.status).toBe("active");
      expect(result.messages.some((message) => message.role === "tool" && message.content.includes("校验未通过"))).toBe(true);
      return { rejected: 1 };
    });
  });

  it("keeps a stalled child visible and resumes it from a persisted session", async () => {
    await runCase("subagent stall and resume", async () => {
      const root = workspace();
      const sessionPath = join(root, "subagents.json");
      const manager = new SubagentTaskManager(2, sessionPath);
      let calls = 0;
      const runner = async (): Promise<{ content: string }> => {
        calls += 1;
        if (calls === 1) return new Promise(() => undefined);
        return { content: "resumed" };
      };
      manager.start({ id: "child", type: "explore", title: "child" }, runner, (message) => runner());
      const notices = manager.stallNotices(Date.now() + 16 * 60_000);
      expect(notices).toHaveLength(1);
      manager.kill("child");
      expect(manager.get("child")?.status).toBe("cancelled");
      manager.sendMessage("child", "continue");
      const view = await manager.wait("child", 100);
      expect(view.status).toBe("completed");
      expect(existsSync(sessionPath)).toBe(true);
      return { stalls: 1, resumes: 1 };
    });
  });

  it("refuses finish while background work is running", async () => {
    await runCase("active work finish gate", async () => {
      const root = workspace();
      const state = createAgentState(root);
      startActiveWork(state, { id: "shell-1", kind: "shell", label: "dev server" });
      const events: RuntimeEvent[] = [];
      const fake = createFakeModel([
        { content: "", toolCalls: [fakeToolCall("finish_task", { summary: "done" })], finishReason: "tool_calls" },
        { content: "done", toolCalls: [fakeToolCall("finish_task", { summary: "done" })], finishReason: "tool_calls" }
      ]);
      const result = await runAgent({
        model: fake.model, tools: createBuiltinTools().filter((tool) => tool.definition.name === "finish_task"),
        goal: "finish gate", systemPrompt: "system", workspaceRoot: root, outDir: join(root, "out"),
        permissions: { tools: ["finish_task"], readRoots: [root], writeRoots: [root], networkHosts: [] },
        budget: {}, state,
        onEvent: (event) => {
          events.push(event);
          if (event.type === "tool.finished" && event.call.name === "finish_task" && event.result.content.includes("后台")) {
            finishActiveWork(state, "shell-1", "completed");
          }
        }
      });
      expect(result.status).toBe("completed");
      expect(events.some((event) => event.type === "tool.finished" && event.result.isError === true)).toBe(true);
      return { gated: 1 };
    });
  });

  it("keeps 20 compactions bounded by the circuit breaker", async () => {
    await runCase("20 compactions", async () => {
      const root = workspace();
      const steps: FakeModelStep[] = Array.from({ length: 21 }, (_, index) => ({
        content: "",
        toolCalls: [fakeToolCall("echo", { value: `${index}-${"x".repeat(2_000)}` })],
        usage: fakeUsage(9_000, 100),
        finishReason: "tool_calls"
      }));
      steps.push({ content: "done", toolCalls: [fakeToolCall("finish_task", { summary: "done" })], finishReason: "tool_calls" });
      const fake = createFakeModel(steps);
      const events: RuntimeEvent[] = [];
      const result = await runAgent({
        model: fake.model,
        tools: [echoTool(), ...createBuiltinTools().filter((tool) => tool.definition.name === "finish_task")],
        goal: "compact", systemPrompt: "system", workspaceRoot: root, outDir: join(root, "out"),
        permissions: { tools: ["echo", "finish_task"], readRoots: [root], writeRoots: [root], networkHosts: [] },
        budget: {}, contextWindowTokens: 1_000, contextReserveTokens: 100, maxOutputTokens: 100,
        keepRecentToolOutputs: 1,
        onEvent: (event) => { events.push(event); }
      });
      const compactions = result.metrics?.compactions ?? 0;
      expect(result.status).toBe("completed");
      expect(compactions).toBeGreaterThan(0);
      expect(compactions).toBeLessThan(20);
      expect(events.some((event) => event.type === "notice" && event.message.includes("暂停"))).toBe(true);
      return { compactions };
    });
  });

  it.each(["after-prepare", "after-dispatch", "mid-tool", "after-settle", "after-checkpoint", "after-cleanup"] as const)(
    "survives a crash at %s without duplicating the side effect",
    async (point) => {
      await runCase(`crash: ${point}`, async () => {
        let total = 0;
        for (let repetition = 0; repetition < 3; repetition++) {
          const root = workspace();
          const path = join(root, "operations.jsonl");
          let local = 0;
          const tool = crashTool(() => { local += 1; }, point === "mid-tool");
          if (point === "after-cleanup") {
            const ledger = new JsonlOperationLedger({ path });
            await ledger.prepare({ operationId: "run-cleanup:call-1", runId: "run-cleanup", taskId: "task-cleanup", toolCallId: "call-1" });
            await ledger.dispatch({ operationId: "run-cleanup:call-1" });
            await ledger.settle({ operationId: "run-cleanup:call-1", phase: "settled", resources: [{ kind: "process", id: "4242" }] });
            await ledger.settleCleanup({ operationId: "run-cleanup:call-1", state: "confirmed" });
            const reopened = new JsonlOperationLedger({ path });
            const fact = await reopened.get("run-cleanup:call-1");
            expect(fact?.cleanupState).toBe("confirmed");
            expect(fact?.cleanupAttempts).toBe(2);
            const again = await reopened.settleCleanup({ operationId: "run-cleanup:call-1", state: "confirmed" });
            expect(again.cleanupAttempts).toBe(2);
            total += 0;
            continue;
          }
          const first = new CrashLedger(new JsonlOperationLedger({ path }), point);
          await runCrashAgent(first, tool, root, `call-${repetition}`);
          if (point === "after-prepare") {
            expect(local).toBe(0);
            const resumed = new JsonlOperationLedger({ path });
            await runCrashAgent(resumed, tool, root, `call-${repetition}`);
            expect(local).toBe(1);
          } else {
            expect(local).toBe(point === "after-dispatch" ? 0 : 1);
            const reopened = new JsonlOperationLedger({ path });
            await runCrashAgent(reopened, tool, root, `call-${repetition}`);
            expect(local).toBe(point === "after-dispatch" ? 0 : 1);
          }
          total += local;
        }
        return { crashPoint: point, executions: total };
      });

    }
  );
});

async function runCase(name: string, fn: () => Promise<Record<string, unknown>>): Promise<void> {
  const started = Date.now();
  try {
    const detail = await fn();
    records.push({ name, passed: true, durationMs: Date.now() - started, detail });
  } catch (error) {
    records.push({
      name,
      passed: false,
      durationMs: Date.now() - started,
      detail: {},
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "hearth-longrun-matrix-"));
  roots.push(root);
  return root;
}

function compact(detail: Record<string, unknown>): string {
  return Object.entries(detail).map(([key, value]) => `${key}: ${String(value)}`).join("; ") || "-";
}

function echoTool(): AgentTool {
  return {
    definition: { name: "echo", description: "echo", parameters: { type: "object", properties: { value: { type: "string" } } }, executionMode: "parallel" },
    async execute(input: unknown): Promise<{ content: string }> {
      return { content: String((input as { value?: unknown }).value ?? "") };
    }
  };
}

function bigTool(content: string): AgentTool {
  return {
    definition: { name: "big", description: "return a large payload", parameters: { type: "object", properties: {} } },
    async execute(): Promise<{ content: string }> {
      return { content };
    }
  };
}

function fakeTool(name: string): AgentTool {
  return {
    definition: { name, description: `${name} operates a fake MCP service`, parameters: { type: "object", properties: {} } },
    async execute(_input: unknown, _context: AgentToolContext): Promise<{ content: string }> {
      return { content: `${name} ok` };
    }
  };
}

type CrashPoint = "after-prepare" | "after-dispatch" | "mid-tool" | "after-settle" | "after-checkpoint" | "after-cleanup";

class CrashLedger implements OperationLedger {
  constructor(private readonly inner: OperationLedger, private readonly point: CrashPoint) {}

  async prepare(input: PrepareOperationInput): Promise<OperationFact> {
    if (this.point !== "after-prepare") return this.inner.prepare(input);
    await this.inner.prepare(input);
    throw new Error("simulated crash after prepare");
  }

  async dispatch(input: DispatchOperationInput): Promise<OperationFact> {
    if (this.point !== "after-dispatch") return this.inner.dispatch(input);
    await this.inner.dispatch(input);
    throw new Error("simulated crash after dispatch");
  }

  async settle(input: SettleOperationInput): Promise<OperationFact> {
    if (this.point === "after-settle") throw new Error("simulated crash before settle");
    if (this.point !== "after-checkpoint") return this.inner.settle(input);
    await this.inner.settle(input);
    throw new Error("simulated crash after settle");
  }

  settleCleanup(input: SettleCleanupInput): Promise<OperationFact> {
    return this.inner.settleCleanup(input);
  }

  get(operationId: string): Promise<OperationFact | null> {
    return this.inner.get(operationId);
  }

  listUnsettled(runId: string): Promise<OperationFact[]> {
    return this.inner.listUnsettled(runId);
  }
}

function crashTool(onExecute: () => void, throws: boolean): AgentTool {
  return {
    definition: {
      name: "crash_write",
      description: "simulated side effect",
      parameters: { type: "object", properties: { value: { type: "string" } } },
      effect: "local_write"
    },
    async execute(): Promise<{ content: string }> {
      onExecute();
      if (throws) throw new Error("simulated tool crash");
      return { content: "written" };
    }
  };
}

async function runCrashAgent(ledger: OperationLedger, tool: AgentTool, root: string, callId: string): Promise<void> {
  const fake = createFakeModel([
    { content: "", toolCalls: [fakeToolCall("crash_write", { value: "v" }, callId)], usage: fakeUsage(50, 5), finishReason: "tool_calls" },
    { content: "done", finishReason: "stop" }
  ]);
  try {
    await runAgent({
      model: fake.model,
      tools: [tool],
      goal: "crash matrix",
      systemPrompt: "system",
      workspaceRoot: root,
      outDir: join(root, "out"),
      permissions: { tools: ["crash_write"], readRoots: [root], writeRoots: [root], networkHosts: [] },
      budget: {},
      operationLedger: ledger,
      requireFinishTool: false,
      stopOnToolError: false
    });
  } catch {
    // A crash simulation may surface as a failed run; the ledger is the assertion target.
  }
}

function writeGoal(root: string, maxTurns: number): void {

  mkdirSync(join(root, ".hearth"), { recursive: true });
  writeFileSync(join(root, ".hearth", "goal.json"), JSON.stringify({
    goalId: "goal_matrix",
    title: "Matrix goal",
    objective: "finish the work",
    constraints: [],
    successCriteria: ["done"],
    status: "active",
    note: null,
    maxTurns,
    turnsUsed: 0,
    planPath: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }, null, 2), "utf8");
}
