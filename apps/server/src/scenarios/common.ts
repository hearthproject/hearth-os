import { HearthStore } from "@hearth/eventlog";
import { ApprovalManager } from "../approvals.ts";
import { HearthService } from "../service.ts";
import { createTaskWithRun } from "./support.ts";
import type { ScenarioContext, ScenarioHandlerResult } from "./types.ts";

export function harness(): { store: HearthStore; service: HearthService } {
  const store = new HearthStore(":memory:");
  return { store, service: new HearthService(store) };
}

export async function withHarness(
  run: (service: HearthService, store: HearthStore) => Promise<ScenarioHandlerResult>
): Promise<ScenarioHandlerResult> {
  const { store, service } = harness();
  try {
    return await run(service, store);
  } finally {
    store.close();
  }
}

export function result(context: ScenarioContext): ScenarioHandlerResult {
  return { summary: context.evidence, assertions: context.assertions };
}

export async function externalApproval(service: HearthService, workspace: string) {
  const { task, run } = createTaskWithRun(service, {
    title: "向假用户发送周报",
    goal: "验证外部动作审批边界",
    workspace,
    status: "waiting_approval"
  });
  const manager = new ApprovalManager(service, async () => ({ messageId: "unexpected" }));
  const approval = await manager.request({
    taskId: task.id,
    runId: run.id,
    kind: "email.smtp-send",
    summary: "向假用户发送邮件",
    target: { to: ["fake-user@example.test"], subject: "周报" },
    preview: { body: "只允许在审批后发送" }
  });
  return { task, run, manager, approval };
}
