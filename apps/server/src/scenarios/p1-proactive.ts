import { HearthStore } from "@hearth/eventlog";
import { ProactiveService } from "../proactive.ts";
import { HearthService } from "../service.ts";
import { StandingIntentService } from "../standing-intents.ts";
import { harness, result } from "./common.ts";
import type { ScenarioHandler } from "./types.ts";

export const p1ProactiveScenarios: Record<string, ScenarioHandler> = {
  "proactive-noise-budget": async (context) => {
    context.clock.set(new Date(2026, 10, 10, 10, 0, 0, 0).toISOString());
    const { store, service } = harness();
    try {
      const proactive = new ProactiveService(service, context.clock.now);
      proactive.updateSettings({ dailyLimit: 1, cooldownMinutes: 60, quietStart: "00:00", quietEnd: "00:00" });
      const seedTask = (title: string) => {
        const task = service.createTask({ title, goal: "验证主动提醒预算" });
        store.appendEvent({
          type: "task.updated",
          taskId: task.id,
          payload: { deadline: new Date(context.clock.now().getTime() + 2 * 3_600_000).toISOString(), updatedAt: context.clock.now().toISOString() }
        });
      };
      seedTask("假用户任务一");
      const first = proactive.scan();
      seedTask("假用户任务二");
      context.clock.advance(10 * 60_000);
      const duringCooldown = proactive.scan();
      context.clock.advance(51 * 60_000);
      const afterBudget = proactive.scan();
      context.check("first-delivered", first.delivered === 1, `首次投递=${first.delivered}`);
      context.check("cooldown-blocks", duringCooldown.created === 1 && duringCooldown.delivered === 0, `冷却期投递=${duringCooldown.delivered}`);
      context.check("daily-budget-blocks", afterBudget.delivered === 0 && proactive.snapshot().budget.usedToday === 1, `当日已用=${proactive.snapshot().budget.usedToday}`);
      context.record("firstScan", first);
      context.record("duringCooldown", duringCooldown);
      context.record("afterBudget", afterBudget);
      context.record("snapshot", proactive.snapshot());
    } finally {
      store.close();
    }

    const intentStore = new HearthStore(":memory:");
    try {
      const intentService = new HearthService(intentStore);
      let notifierCalls = 0;
      const intents = new StandingIntentService({
        service: intentService,
        clock: context.clock.now,
        notifier: () => {
          notifierCalls += 1;
        }
      });
      const quiet = await intents.heartbeat();
      const quietNotifierCalls = notifierCalls;
      intents.create({
        description: "假用户发布提醒",
        triggerEntries: [{ terms: ["发布"], mode: "any" }],
        action: "remind",
        maxFires: 1
      });
      const notified = await intents.heartbeat({ text: "准备发布" });
      context.check("no-candidates-no-reply", quiet.decision === "NO_REPLY" && quietNotifierCalls === 0, `${quiet.decision}, notifier=${quietNotifierCalls}`);
      context.check("intent-notifies-once", notified.decision === "notify" && notifierCalls === 1, `${notified.decision}, notifier=${notifierCalls}`);
      context.record("quietHeartbeat", quiet);
      context.record("notifiedHeartbeat", notified);
      context.record("quietNotifierCalls", quietNotifierCalls);
      context.record("notifierCalls", notifierCalls);
    } finally {
      intentStore.close();
    }
    return result(context);
  }
};
