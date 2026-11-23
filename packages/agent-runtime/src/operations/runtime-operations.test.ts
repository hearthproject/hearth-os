import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeModel, fakeToolCall } from "../test-support/fake-model.ts";
import { JsonlOperationLedger } from "./journal-ledger.ts";
import type { AgentRunResult, AgentTool } from "../types.ts";
import type {
  DispatchOperationInput,
  OperationFact,
  OperationLedger,
  PrepareOperationInput,
  SettleCleanupInput,
  SettleOperationInput
} from "./types.ts";
import { runAgent } from "../runtime.ts";

const tempDirs: string[] = [];
const ledgers: JsonlOperationLedger[] = [];

afterEach(() => {
  for (const ledger of ledgers.splice(0)) ledger.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workspace(): { root: string; out: string } {
  const root = mkdtempSync(join(tmpdir(), "hearth-m1-"));
  tempDirs.push(root);
  return { root, out: join(root, "out") };
}

function makeTool(
  name: string,
  effect: NonNullable<AgentTool["definition"]["effect"]>,
  execute: AgentTool["execute"],
  timeoutMs?: number
): AgentTool {
  return {
    definition: {
      name,
      description: name,
      parameters: { type: "object", properties: {}, additionalProperties: true },
      effect,
      ...(timeoutMs ? { timeoutMs } : {})
    },
    execute
  };
}

async function runOne(
  ledger: OperationLedger,
  tool: AgentTool,
  callId: string,
  runId = "run-1",
  args: Record<string, unknown> = {},
  rootOverride?: { root: string; out: string }
): Promise<AgentRunResult> {
  const root = rootOverride ?? workspace();
  const model = createFakeModel([
    { toolCalls: [fakeToolCall(tool.definition.name, args, callId)] },
    { content: "done", finishReason: "stop" }
  ]);
  return runAgent({
    model: model.model,
    tools: [tool],
    goal: "perform the operation",
    systemPrompt: "test",
    budget: { maxTurns: 4, maxToolCalls: 4, maxTokens: 500_000, maxDurationMs: 30_000 },
    permissions: {
      readRoots: [root.root],
      writeRoots: [root.root],
      networkHosts: [],
      tools: [tool.definition.name],
      fullAccess: true
    },
    workspaceRoot: root.root,
    outDir: root.out,
    runId,
    taskId: "task-1",
    operationLedger: ledger,
    requireFinishTool: false,
    stopOnToolError: false
  });
}

class FaultLedger implements OperationLedger {
  constructor(
    private readonly inner: OperationLedger,
    private readonly fault: "prepare" | "dispatch-before" | "dispatch-after" | "settle-before" | "settle-after"
  ) {}

  async prepare(input: PrepareOperationInput): Promise<OperationFact> {
    if (this.fault === "prepare") throw new Error("injected prepare failure");
    return this.inner.prepare(input);
  }

  async dispatch(input: DispatchOperationInput): Promise<OperationFact> {
    if (this.fault === "dispatch-before") throw new Error("injected dispatch failure");
    const fact = await this.inner.dispatch(input);
    if (this.fault === "dispatch-after") throw new Error("injected dispatch crash");
    return fact;
  }

  async settle(input: SettleOperationInput): Promise<OperationFact> {
    if (this.fault === "settle-before") throw new Error("injected settle failure");
    const fact = await this.inner.settle(input);
    if (this.fault === "settle-after") throw new Error("injected post-settle crash");
    return fact;
  }

  async settleCleanup(input: SettleCleanupInput): Promise<OperationFact> {
    return this.inner.settleCleanup(input);
  }

  get(operationId: string): Promise<OperationFact | null> {
    return this.inner.get(operationId);
  }

  listUnsettled(runId: string): Promise<OperationFact[]> {
    return this.inner.listUnsettled(runId);
  }
}

describe("runtime T1/T2 operation ledger", () => {
  it("does not touch the tool when prepare fails", async () => {
    const ledger = new JsonlOperationLedger();
    ledgers.push(ledger);
    let executions = 0;
    const tool = makeTool("write_thing", "local_write", async () => {
      executions += 1;
      return { content: "written" };
    });
    await runOne(new FaultLedger(ledger, "prepare"), tool, "call-prepare", "run-prepare");
    expect(executions).toBe(0);
    expect(await ledger.listUnsettled("run-prepare")).toHaveLength(0);
  });

  it("does not touch the tool when dispatch fails before T1", async () => {
    const ledger = new JsonlOperationLedger();
    ledgers.push(ledger);
    let executions = 0;
    const tool = makeTool("write_thing", "local_write", async () => {
      executions += 1;
      return { content: "written" };
    });
    await runOne(new FaultLedger(ledger, "dispatch-before"), tool, "call-dispatch", "run-dispatch");
    expect(executions).toBe(0);
    const fact = await ledger.get("run-dispatch:call-dispatch");
    expect(fact?.phase).toBe("prepared");
    expect(await ledger.listUnsettled("run-dispatch")).toHaveLength(1);
  });

  it("stops a replay when T1 committed but the process died before the side effect", async () => {
    const ledger = new JsonlOperationLedger();
    ledgers.push(ledger);
    let executions = 0;
    const tool = makeTool("write_thing", "local_write", async () => {
      executions += 1;
      return { content: "written" };
    });
    const root = workspace();
    await runOne(new FaultLedger(ledger, "dispatch-after"), tool, "call-t1", "run-t1", {}, root);
    expect(executions).toBe(0);
    expect((await ledger.get("run-t1:call-t1"))?.phase).toBe("dispatched");
    await runOne(ledger, tool, "call-t1", "run-t1", {}, root);
    expect(executions).toBe(0);
  });

  it("records a thrown tool as unknown and refuses an automatic replay", async () => {
    const ledger = new JsonlOperationLedger();
    ledgers.push(ledger);
    let executions = 0;
    const tool = makeTool("write_thing", "local_write", async () => {
      executions += 1;
      throw new Error("tool crashed mid-write");
    });
    const root = workspace();
    await runOne(ledger, tool, "call-throw", "run-throw", {}, root);
    expect(executions).toBe(1);
    expect((await ledger.get("run-throw:call-throw"))?.phase).toBe("unknown");
    await runOne(ledger, tool, "call-throw", "run-throw", {}, root);
    expect(executions).toBe(1);
  });

  it("settles a local write exactly once and leaves a dispatched fact when T2 fails", async () => {
    const ledger = new JsonlOperationLedger();
    ledgers.push(ledger);
    const root = workspace();
    const file = join(root.root, "edited.txt");
    let executions = 0;
    const tool = makeTool("write_thing", "local_write", async (args) => {
      executions += 1;
      writeFileSync(file, String((args as { text?: string }).text ?? "one"));
      return { content: "written" };
    });
    await runOne(new FaultLedger(ledger, "settle-before"), tool, "call-settle", "run-settle", { path: "edited.txt", text: "one" }, root);
    expect(executions).toBe(1);
    expect(readFileSync(file, "utf8")).toBe("one");
    expect((await ledger.get("run-settle:call-settle"))?.phase).toBe("dispatched");
    await runOne(ledger, tool, "call-settle", "run-settle", { path: "edited.txt", text: "two" }, root);
    expect(executions).toBe(1);
    expect(readFileSync(file, "utf8")).toBe("one");
  });

  it("does not replay a write after a crash that happened after the result was settled", async () => {
    const ledger = new JsonlOperationLedger();
    ledgers.push(ledger);
    const root = workspace();
    let executions = 0;
    const tool = makeTool("write_thing", "local_write", async () => {
      executions += 1;
      return { content: "written" };
    });
    await runOne(new FaultLedger(ledger, "settle-after"), tool, "call-settled", "run-settled", {}, root);
    expect(executions).toBe(1);
    expect((await ledger.get("run-settled:call-settled"))?.phase).toBe("settled");
    await runOne(ledger, tool, "call-settled", "run-settled", {}, root);
    expect(executions).toBe(1);
  });

  it("does not replay after a settled operation survives a process restart", async () => {
    const root = workspace();
    const path = join(root.root, "operations.jsonl");
    const first = new JsonlOperationLedger({ path });
    let executions = 0;
    const tool = makeTool("write_thing", "local_write", async () => {
      executions += 1;
      return { content: "written" };
    });
    await runOne(first, tool, "call-restart", "run-restart", {}, root);
    first.close();
    const reopened = new JsonlOperationLedger({ path });
    ledgers.push(reopened);
    expect((await reopened.get("run-restart:call-restart"))?.phase).toBe("settled");
    await runOne(reopened, tool, "call-restart", "run-restart", {}, root);
    expect(executions).toBe(1);
  });

  it("cancels a timed-out local write, records unknown, and never duplicates it", async () => {
    const ledger = new JsonlOperationLedger();
    ledgers.push(ledger);
    const root = workspace();
    let executions = 0;
    let writes = 0;
    const tool = makeTool("slow_write", "local_write", async (_args, context) => {
      executions += 1;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          writes += 1;
          writeFileSync(join(root.root, "slow.txt"), "late");
          resolve();
        }, 150);
        context.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("aborted by runtime"));
        }, { once: true });
      });
      return { content: "written" };
    }, 40);
    await runOne(ledger, tool, "call-timeout", "run-timeout", {}, root);
    expect(executions).toBe(1);
    expect(writes).toBe(0);
    expect((await ledger.get("run-timeout:call-timeout"))?.phase).toBe("unknown");
    await runOne(ledger, tool, "call-timeout", "run-timeout", {}, root);
    expect(executions).toBe(1);
    expect(writes).toBe(0);
  });

  it("allows a settled read to run again under a new tool call id", async () => {
    const ledger = new JsonlOperationLedger();
    ledgers.push(ledger);
    let executions = 0;
    const tool = makeTool("read_thing", "read", async () => {
      executions += 1;
      return { content: "ok" };
    });
    const root = workspace();
    await runOne(ledger, tool, "call-read-1", "run-read", {}, root);
    expect((await ledger.get("run-read:call-read-1"))?.phase).toBe("settled");
    await runOne(ledger, tool, "call-read-2", "run-read", {}, root);
    expect(executions).toBe(2);
    expect((await ledger.get("run-read:call-read-2"))?.phase).toBe("settled");
  });

  it("settles an external write with its receipt and effect ref", async () => {
    const ledger = new JsonlOperationLedger();
    ledgers.push(ledger);
    const tool = makeTool("send_thing", "external_write", async () => ({
      content: "sent",
      metadata: { effectRef: "email:42", receipt: { messageId: "m-42" } }
    }));
    await runOne(ledger, tool, "call-external", "run-external");
    const fact = await ledger.get("run-external:call-external");
    expect(fact?.phase).toBe("settled");
    expect(fact?.effectRef).toBe("email:42");
    expect(fact?.receipt).toEqual({ messageId: "m-42" });
    expect(await ledger.listUnsettled("run-external")).toHaveLength(0);
  });

  it("parks an external write that returns no receipt", async () => {
    const ledger = new JsonlOperationLedger();
    ledgers.push(ledger);
    const tool = makeTool("send_thing", "external_write", async () => ({ content: "sent" }));
    const result = await runOne(ledger, tool, "call-no-receipt", "run-no-receipt");
    expect(result.status).toBe("failed");
    const fact = await ledger.get("run-no-receipt:call-no-receipt");
    expect(fact?.phase).toBe("unknown");
    expect(fact?.receipt).toBeNull();
    expect(await ledger.listUnsettled("run-no-receipt")).toHaveLength(1);
  });
});
