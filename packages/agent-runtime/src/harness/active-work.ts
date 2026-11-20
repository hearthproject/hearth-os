import type { AgentActiveWork, AgentToolState } from "../types.ts";

const MAX_ACTIVE_WORK = 100;

export interface ActiveWorkInput {
  id: string;
  kind: AgentActiveWork["kind"];
  label?: string;
}

export function startActiveWork(state: AgentToolState | undefined, input: ActiveWorkInput): void {
  if (!state) return;
  state.activeWork ??= [];
  const existing = state.activeWork.find((item) => item.id === input.id);
  if (existing) {
    existing.status = "running";
    delete existing.endedAt;
    return;
  }
  state.activeWork.push({
    ...input,
    status: "running",
    startedAt: Date.now()
  });
  if (state.activeWork.length > MAX_ACTIVE_WORK) {
    state.activeWork.splice(0, state.activeWork.length - MAX_ACTIVE_WORK);
  }
}

export function finishActiveWork(
  state: AgentToolState | undefined,
  id: string,
  status: Exclude<AgentActiveWork["status"], "running"> = "completed",
  exitCode?: number | null
): void {
  if (!state) return;
  const work = state.activeWork?.find((item) => item.id === id);
  if (!work) return;
  work.status = status;
  work.endedAt = Date.now();
  if (exitCode !== undefined) work.exitCode = exitCode;
}

export function runningActiveWork(state: AgentToolState | undefined): AgentActiveWork[] {
  return (state?.activeWork ?? []).filter((item) => item.status === "running");
}

export function markLostActiveWork(state: AgentToolState | undefined): AgentActiveWork[] {
  const running = runningActiveWork(state);
  for (const work of running) {
    work.status = "lost";
    work.endedAt = Date.now();
  }
  return running;
}
