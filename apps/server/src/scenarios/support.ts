import { randomUUID } from "node:crypto";
import type { EffectRecord, RunRecord, TaskRecord } from "@hearth/core";
import type { HearthService } from "../service.ts";
import type { ControlledClock, ScenarioContext } from "./types.ts";

export function fixedClock(initial = "2026-11-10T02:00:00.000Z"): ControlledClock {
  let current = new Date(initial);
  return {
    now: () => new Date(current),
    set(value) {
      current = new Date(value);
    },
    advance(ms) {
      current = new Date(current.getTime() + ms);
    }
  };
}

export function createTaskWithRun(
  service: HearthService,
  input: {
    title: string;
    goal?: string;
    workspace: string;
    status?: "running" | "waiting_approval";
    executorId?: TaskRecord["executorId"];
    goalId?: string;
  }
): { task: TaskRecord; run: RunRecord } {
  const task = service.createTask({
    title: input.title,
    goal: input.goal ?? input.title,
    executorId: input.executorId ?? "native",
    ...(input.goalId ? { goalId: input.goalId } : {})
  });
  const now = new Date().toISOString();
  const run: RunRecord = {
    id: randomUUID(),
    taskId: task.id,
    attempt: 1,
    status: "running",
    threadId: null,
    workspace: input.workspace,
    startedAt: now,
    endedAt: null,
    failure: null,
    usage: null,
    leaseEpoch: null,
    createdAt: now,
    executorId: input.executorId ?? "native"
  };
  service.createRun(run);
  service.updateTask(task.id, {
    status: "running",
    currentRunId: run.id,
    nextAction: "执行中"
  }, run.id);
  if (input.status === "waiting_approval") {
    service.updateTask(task.id, {
      status: "waiting_approval",
      currentRunId: run.id,
      nextAction: "等待确认"
    }, run.id);
  }
  return { task: service.requireTask(task.id), run };
}

export function effectRecord(
  service: HearthService,
  input: {
    taskId: string;
    status: EffectRecord["status"];
    target?: Record<string, unknown>;
    receipt?: Record<string, unknown> | null;
    kind?: string;
    effectType?: string;
    provider?: string;
    goalId?: string | null;
    createdAt?: string;
    idempotencyKey?: string;
  }
): EffectRecord {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const effect: EffectRecord = {
    id: randomUUID(),
    taskId: input.taskId,
    approvalId: randomUUID(),
    kind: input.kind ?? "email.smtp-send",
    idempotencyKey: input.idempotencyKey ?? randomUUID(),
    status: input.status,
    target: input.target ?? { to: ["fake-user@example.test"] },
    receipt: input.receipt ?? null,
    error: null,
    createdAt,
    updatedAt: createdAt,
    effectType: input.effectType ?? "email.send",
    replayPolicy: "never_replay",
    provider: input.provider ?? "email",
    attemptCount: 1,
    maxAttempts: 1,
    ...(input.goalId !== undefined ? { goalId: input.goalId } : {})
  };
  return service.createEffect(effect);
}

export function errorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const value = (error as { code?: unknown }).code;
  return typeof value === "string" ? value : null;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
