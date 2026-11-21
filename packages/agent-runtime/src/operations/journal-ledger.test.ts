import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonlOperationLedger } from "./journal-ledger.ts";
import { OperationLedgerError, type PrepareOperationInput } from "./types.ts";

const tempDirs: string[] = [];
const ledgers: JsonlOperationLedger[] = [];

afterEach(() => {
  for (const ledger of ledgers.splice(0)) ledger.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "hearth-operations-"));
  tempDirs.push(dir);
  return join(dir, "operations.jsonl");
}

function prepareInput(overrides: Partial<PrepareOperationInput> = {}): PrepareOperationInput {
  return {
    operationId: "run-1:call-1",
    runId: "run-1",
    taskId: "task-1",
    toolCallId: "call-1",
    toolName: "write_file",
    argsHash: "args-1",
    effect: "local_write",
    beforeDigest: "before-1",
    permissionsDigest: "permissions-1",
    startedAt: "2026-11-21T10:00:00.000Z",
    ...overrides
  };
}

describe("JsonlOperationLedger", () => {
  it("enforces prepare, dispatch and settle transitions", async () => {
    const ledger = new JsonlOperationLedger();
    ledgers.push(ledger);
    const input = prepareInput();
    const prepared = await ledger.prepare(input);
    expect(prepared.phase).toBe("prepared");
    expect((await ledger.prepare(input)).operationId).toBe(prepared.operationId);

    await expect(ledger.prepare({ ...input, argsHash: "other" }))
      .rejects.toMatchObject({ code: "OPERATION_ARGS_MISMATCH" });

    const dispatched = await ledger.dispatch({ operationId: prepared.operationId });
    expect(dispatched.phase).toBe("dispatched");
    await expect(ledger.dispatch({ operationId: prepared.operationId }))
      .rejects.toBeInstanceOf(OperationLedgerError);

    const settled = await ledger.settle({
      operationId: prepared.operationId,
      phase: "settled",
      resultDigest: "result-1",
      outputRef: "out/result.md",
      effectRef: "effect-1",
      receipt: { ok: true }
    });
    expect(settled.phase).toBe("settled");
    expect(settled.receipt).toEqual({ ok: true });
    expect((await ledger.settle({
      operationId: prepared.operationId,
      phase: "settled",
      resultDigest: "result-1"
    })).phase).toBe("settled");
    await expect(ledger.settle({
      operationId: prepared.operationId,
      phase: "settled",
      resultDigest: "different"
    })).rejects.toMatchObject({ code: "OPERATION_SETTLE_MISMATCH" });
    expect(await ledger.listUnsettled("run-1")).toHaveLength(0);
  });

  it("records unknown outcomes and lists them for recovery", async () => {
    const ledger = new JsonlOperationLedger();
    ledgers.push(ledger);
    const prepared = await ledger.prepare(prepareInput({ operationId: "run-1:call-2", toolCallId: "call-2" }));
    await ledger.dispatch({ operationId: prepared.operationId });
    const unknown = await ledger.settle({ operationId: prepared.operationId, phase: "unknown", errorCode: "TOOL_TIMEOUT" });
    expect(unknown.phase).toBe("unknown");
    expect(unknown.errorCode).toBe("TOOL_TIMEOUT");
    expect(await ledger.listUnsettled("run-1")).toHaveLength(1);
  });

  it("replays committed transitions from JSONL", async () => {
    const path = tempPath();
    const ledger = new JsonlOperationLedger({ path });
    ledgers.push(ledger);
    const prepared = await ledger.prepare(prepareInput({ operationId: "run-1:call-3", toolCallId: "call-3" }));
    await ledger.dispatch({ operationId: prepared.operationId });
    ledger.close();

    const reopened = new JsonlOperationLedger({ path });
    ledgers.push(reopened);
    const fact = await reopened.get(prepared.operationId);
    expect(fact?.phase).toBe("dispatched");
    expect(fact?.beforeDigest).toBe("before-1");
    expect((await reopened.listUnsettled("run-1")).map((item) => item.operationId)).toContain(prepared.operationId);
    const raw = readFileSync(path, "utf8").trim().split("\n");
    expect(raw.length).toBe(2);
    expect(raw.every((line) => JSON.parse(line).version === 1)).toBe(true);
  });

  it("ignores a torn tail instead of treating it as committed", async () => {
    const path = tempPath();
    const ledger = new JsonlOperationLedger({ path });
    ledgers.push(ledger);
    const prepared = await ledger.prepare(prepareInput({ operationId: "run-1:call-4", toolCallId: "call-4" }));
    ledger.close();
    appendFileSync(path, '{"version":1,"fact":', "utf8");

    const reopened = new JsonlOperationLedger({ path });
    ledgers.push(reopened);
    expect((await reopened.get(prepared.operationId))?.phase).toBe("prepared");
  });
});
