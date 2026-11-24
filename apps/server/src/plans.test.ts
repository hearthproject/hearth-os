import { describe, expect, it, vi } from "vitest";
import { HearthStore } from "@hearth/eventlog";
import type { PlanSchedulerPort } from "./plans.ts";
import { PlanService } from "./plans.ts";
import { HearthService } from "./service.ts";

function setup() {
  const store = new HearthStore(":memory:");
  const service = new HearthService(store);
  const conversation = store.createConversation("plan conversation");
  const plans = new PlanService({ service });
  const scheduler = {
    requeuePlanTask: vi.fn((taskId: string) => service.requireTask(taskId)),
    cancel: vi.fn((taskId: string) => service.updateTask(taskId, { status: "cancelled" })),
    addFollowUp: vi.fn(),
    kick: vi.fn()
  } as unknown as PlanSchedulerPort;
  plans.attachScheduler(scheduler);
  return { store, service, conversation, plans, scheduler };
}

describe("PlanService", () => {
  it("creates one read-only planning task and persists its plan", () => {
    const { service, conversation, plans } = setup();
    const plan = plans.create({
      conversationId: conversation.id,
      title: "Add cache",
      objective: "Add a cache layer",
      textInput: "Add a cache layer"
    });
    expect(plan.stage).toBe("planning");
    expect(plan.planningTaskId).toBeTruthy();
    const task = service.requireTask(plan.planningTaskId!);
    expect(task.mode).toBe("plan");
    expect(task.planId).toBe(plan.id);
    expect(task.expectedOutputs).toEqual([]);
    expect(service.store.getConversation(conversation.id)?.settings.collaborationMode).toBe("plan");

    const ready = plans.onPlanningTaskReady(task.id, "## Plan\n\n1. Add cache", "/tmp/plan.md");
    expect(ready?.stage).toBe("awaiting_approval");
    expect(ready?.planMarkdown).toContain("Add cache");
    expect(ready?.planPath).toBe("/tmp/plan.md");
    expect(() => plans.create({ conversationId: conversation.id, objective: "second" })).toThrow();
  });

  it("approves into a build task and completes the plan", async () => {
    const { service, conversation, plans, scheduler } = setup();
    const plan = plans.create({ conversationId: conversation.id, objective: "Ship feature", textInput: "Ship feature" });
    plans.onPlanningTaskReady(plan.planningTaskId!, "## Plan\n\n- Implement it", "/tmp/plan.md");

    const approved = await plans.action(plan.id, "approve");
    expect(approved.stage).toBe("executing");
    expect(approved.executionTaskId).toBeTruthy();
    const execution = service.requireTask(approved.executionTaskId!);
    expect(execution.mode).toBe("build");
    expect(execution.planId).toBe(plan.id);
    expect(execution.inputs.some((input) => input.kind === "text" && input.value.includes("已经由用户明确批准"))).toBe(true);
    expect(service.store.getConversation(conversation.id)?.settings.collaborationMode).toBe("build");
    expect(scheduler.kick).toHaveBeenCalled();

    const completed = plans.onExecutionTaskCompleted(execution.id);
    expect(completed?.stage).toBe("completed");
  });

  it("retries a failed execution with the same approved plan", async () => {
    const { service, conversation, plans } = setup();
    const plan = plans.create({ conversationId: conversation.id, objective: "Ship feature", textInput: "Ship feature" });
    plans.onPlanningTaskReady(plan.planningTaskId!, "## Plan\n\n- Implement it", "/tmp/plan.md");
    const approved = await plans.action(plan.id, "approve");
    const firstExecution = approved.executionTaskId!;
    const failed = plans.onTaskFailed(firstExecution, "boom");
    expect(failed?.stage).toBe("failed");
    expect(failed?.error).toBe("boom");

    const retried = await plans.action(plan.id, "retry");
    expect(retried.stage).toBe("executing");
    expect(retried.executionTaskId).not.toBe(firstExecution);
    expect(service.requireTask(retried.executionTaskId!).mode).toBe("build");
  });

  it("keeps executing plans from auto-running after a restart", async () => {
    const { service, conversation, plans, scheduler } = setup();
    const plan = plans.create({ conversationId: conversation.id, objective: "Restart", textInput: "Restart" });
    plans.onPlanningTaskReady(plan.planningTaskId!, "## Plan\n\n- Resume safely", "/tmp/plan.md");
    const approved = await plans.action(plan.id, "approve");
    service.updateTask(approved.executionTaskId!, { status: "running" });

    plans.recoverOnBoot();
    const recovered = plans.get(plan.id);
    expect(recovered?.stage).toBe("awaiting_approval");
    expect(recovered?.executionTaskId).toBe(approved.executionTaskId);
    expect(scheduler.cancel).toHaveBeenCalledWith(approved.executionTaskId);
  });

  it("continues planning in the same task after user feedback", () => {
    const { conversation, plans, scheduler } = setup();
    const plan = plans.create({ conversationId: conversation.id, objective: "Iterate", textInput: "Iterate" });
    plans.onPlanningTaskReady(plan.planningTaskId!, "## Plan\n\n- First", "/tmp/plan.md");
    const revised = plans.continuePlanning(plan.id, "Use a smaller scope");
    expect(revised.stage).toBe("planning");
    expect(revised.planMarkdown).toBeNull();
    expect(revised.planningTaskId).toBe(plan.planningTaskId);
    expect(scheduler.requeuePlanTask).toHaveBeenCalledWith(plan.planningTaskId, "Use a smaller scope", { allowCompleted: true });
  });
});
