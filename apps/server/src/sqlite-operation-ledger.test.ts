import { describe, expect, it } from "vitest";
import { HearthStore } from "@hearth/eventlog";
import { SqliteOperationLedger } from "./sqlite-operation-ledger.ts";

describe("SqliteOperationLedger", () => {
  it("maps the eventlog operation table onto the runtime contract", async () => {
    const store = new HearthStore(":memory:");
    const ledger = new SqliteOperationLedger(store);
    const input = {
      operationId: "run-1:call-1",
      runId: "run-1",
      taskId: "task-1",
      toolCallId: "call-1",
      toolName: "send_email",
      argsHash: "args-hash",
      effect: "external_write" as const,
      beforeDigest: null,
      permissionsDigest: "permissions-hash"
    };
    const prepared = await ledger.prepare(input);
    expect(prepared.phase).toBe("prepared");
    await expect(ledger.prepare({ ...input, argsHash: "other" }))
      .rejects.toMatchObject({ code: "OPERATION_ARGS_MISMATCH" });

    expect((await ledger.dispatch({ operationId: input.operationId })).phase).toBe("dispatched");
    await expect(ledger.dispatch({ operationId: input.operationId }))
      .rejects.toMatchObject({ code: "OPERATION_ALREADY_DISPATCHED" });

    const settled = await ledger.settle({
      operationId: input.operationId,
      phase: "settled",
      resultDigest: "result-hash",
      outputRef: "out/sent.txt",
      effectRef: "email:42",
      receipt: { messageId: "m-42" }
    });
    expect(settled.phase).toBe("settled");
    expect(settled.effectRef).toBe("email:42");
    expect(settled.receipt).toEqual({ messageId: "m-42" });
    expect(await ledger.listUnsettled("run-1")).toHaveLength(0);
    store.close();
  });

  it("records physical cleanup separately from the business outcome", async () => {
    const store = new HearthStore(":memory:");
    const ledger = new SqliteOperationLedger(store);
    const operationId = "run-2:call-2";
    await ledger.prepare({
      operationId,
      runId: "run-2",
      taskId: "task-2",
      toolCallId: "call-2",
      toolName: "shell",
      argsHash: "args-2",
      effect: "local_write"
    });
    await ledger.dispatch({ operationId });
    const settled = await ledger.settle({
      operationId,
      phase: "settled",
      resultDigest: "result-2",
      resources: [{ kind: "process", id: "session-1", meta: { background: true } }]
    });
    expect(settled.cleanupState).toBe("pending");
    expect(settled.resources).toEqual([{ kind: "process", id: "session-1", meta: { background: true } }]);
    expect(store.listCleanupPendingRunOperations("task-2")).toHaveLength(1);

    const cleaned = await ledger.settleCleanup({ operationId, state: "confirmed" });
    expect(cleaned.cleanupState).toBe("confirmed");
    expect(cleaned.cleanupAttempts).toBeGreaterThan(0);
    expect(store.listCleanupPendingRunOperations("task-2")).toHaveLength(0);
    await expect(ledger.settleCleanup({ operationId, state: "failed" }))
      .rejects.toMatchObject({ code: "OPERATION_CLEANUP_SETTLED" });
    store.close();
  });
});
