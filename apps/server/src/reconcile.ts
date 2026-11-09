import { randomUUID } from "node:crypto";
import type {
  EffectRecord,
  ReconcileAction,
  ReconcileItem
} from "@hearth/core";
import { stableStringify } from "./approvals.ts";
import type { HearthService } from "./service.ts";

export type ReconcileCheckResult =
  | { status: "committed"; receipt?: Record<string, unknown>; providerRef?: string }
  | { status: "absent" }
  | { status: "unknown"; reason: string }
  | { status: "conflicting"; reason: string };

export interface EffectReconciler {
  check(effect: EffectRecord): Promise<ReconcileCheckResult> | ReconcileCheckResult;
}

export interface ReconcileServiceOptions {
  providers?: Record<string, EffectReconciler>;
  now?: () => Date;
}

export class ReconcileError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ReconcileError";
    this.code = code;
  }
}

export class ReconcileService {
  private readonly service: HearthService;
  private readonly providers: Record<string, EffectReconciler>;
  private readonly now: () => Date;

  constructor(service: HearthService, options: ReconcileServiceOptions = {}) {
    this.service = service;
    this.providers = options.providers ?? {};
    this.now = options.now ?? (() => new Date());
  }

  enqueue(effect: EffectRecord, reason: string): ReconcileItem {
    const existing = this.service.store.getReconcileItemByEffect(effect.id);
    if (existing && isOpen(existing.status)) return existing;
    const now = this.now().toISOString();
    const targetKey = effect.targetKey ?? targetKeyForEffect(effect);
    this.service.updateEffect(effect.id, { targetKey });
    const item: ReconcileItem = {
      id: randomUUID(),
      effectId: effect.id,
      taskId: effect.taskId,
      goalId: effect.goalId ?? null,
      targetKey,
      summary: `外部动作结果需要核对：${effect.kind}`,
      status: "open",
      reason,
      attempted: [],
      risk: riskForEffect(effect),
      suggestedActions: ["recheck", "mark_committed", "mark_absent", "abandon"],
      provider: effect.provider ?? providerKey(effect),
      checkCount: 0,
      resolutionNote: null,
      createdAt: now,
      updatedAt: now,
      resolvedAt: null
    };
    const created = this.service.createReconcileItem(item);
    this.suspendFollowing(effect, targetKey);
    return created;
  }

  scanUncertain(): ReconcileItem[] {
    const items: ReconcileItem[] = [];
    for (const effect of this.service.store.listAllEffects()) {
      if (effect.status !== "uncertain" && effect.status !== "executing") continue;
      items.push(this.enqueue(effect, "服务恢复时发现未结算的外部动作"));
    }
    return items;
  }

  listOpen(): ReconcileItem[] {
    return this.service.store.listReconcileItems().filter((item) => isOpen(item.status));
  }

  async check(itemId: string): Promise<ReconcileItem> {
    const item = this.service.store.getReconcileItem(itemId);
    if (!item) throw new ReconcileError("RECONCILE_NOT_FOUND", "对账项不存在");
    if (!isOpen(item.status)) return item;
    const effect = this.service.store.getEffect(item.effectId);
    if (!effect) throw new ReconcileError("EFFECT_NOT_FOUND", "对账项关联的效果不存在");
    this.service.updateReconcileItem(item.id, { status: "checking", updatedAt: this.now().toISOString() });
    const reconciler = this.providers[item.provider ?? providerKey(effect)];
    if (!reconciler) {
      return this.service.updateReconcileItem(item.id, {
        status: "needs_human",
        reason: "没有可用的 provider reconcile 适配器",
        updatedAt: this.now().toISOString()
      });
    }
    let result: ReconcileCheckResult;
    try {
      result = await reconciler.check(effect);
    } catch (error) {
      result = { status: "unknown", reason: error instanceof Error ? error.message : String(error) };
    }
    return this.applyResult(item, effect, result);
  }

  resolveManually(itemId: string, resolution: "committed" | "absent" | "abandoned", note: string): ReconcileItem {
    const item = this.service.store.getReconcileItem(itemId);
    if (!item) throw new ReconcileError("RECONCILE_NOT_FOUND", "对账项不存在");
    const now = this.now().toISOString();
    if (resolution === "committed") {
      this.service.updateEffect(item.effectId, {
        status: "reconciled_committed",
        reconcileRef: item.id,
        reconciledAt: now,
        receipt: { manualResolution: "committed", note },
        suspendReason: null
      });
      const resolved = this.service.updateReconcileItem(item.id, {
        status: "resolved_committed",
        resolutionNote: note,
        resolvedAt: now,
        updatedAt: now
      });
      this.resumeFollowing(item);
      return resolved;
    }
    if (resolution === "absent") {
      this.service.updateEffect(item.effectId, {
        status: "reconciled_absent",
        reconcileRef: item.id,
        reconciledAt: now,
        error: note,
        suspendReason: null
      });
      const resolved = this.service.updateReconcileItem(item.id, {
        status: "resolved_absent",
        resolutionNote: note,
        resolvedAt: now,
        updatedAt: now
      });
      this.resumeFollowing(item);
      return resolved;
    }
    this.service.updateEffect(item.effectId, {
      status: "abandoned",
      reconcileRef: item.id,
      reconciledAt: now,
      error: note
    });
    return this.service.updateReconcileItem(item.id, {
      status: "abandoned",
      resolutionNote: note,
      resolvedAt: now,
      updatedAt: now
    });
  }

  private applyResult(item: ReconcileItem, effect: EffectRecord, result: ReconcileCheckResult): ReconcileItem {
    const now = this.now().toISOString();
    if (result.status === "committed") {
      this.service.updateEffect(effect.id, {
        status: "reconciled_committed",
        ...(result.receipt ? { receipt: result.receipt } : {}),
        ...(result.providerRef ? { providerRef: result.providerRef } : {}),
        reconcileRef: item.id,
        reconciledAt: now,
        suspendReason: null
      });
      const resolved = this.service.updateReconcileItem(item.id, {
        status: "resolved_committed",
        attempted: [...item.attempted, "provider:committed"],
        checkCount: item.checkCount + 1,
        resolutionNote: "provider 确认动作已经提交",
        resolvedAt: now,
        updatedAt: now
      });
      this.resumeFollowing(item);
      return resolved;
    }
    if (result.status === "absent") {
      this.service.updateEffect(effect.id, {
        status: "reconciled_absent",
        reconcileRef: item.id,
        reconciledAt: now,
        suspendReason: null
      });
      const resolved = this.service.updateReconcileItem(item.id, {
        status: "resolved_absent",
        attempted: [...item.attempted, "provider:absent"],
        checkCount: item.checkCount + 1,
        resolutionNote: "provider 确认动作没有发生",
        resolvedAt: now,
        updatedAt: now
      });
      this.resumeFollowing(item);
      return resolved;
    }
    if (result.status === "conflicting") {
      this.service.updateEffect(effect.id, {
        status: "uncertain",
        reconcileRef: item.id,
        error: result.reason
      });
      return this.service.updateReconcileItem(item.id, {
        status: "conflicting",
        attempted: [...item.attempted, `provider:conflicting:${result.reason}`],
        checkCount: item.checkCount + 1,
        reason: result.reason,
        updatedAt: now
      });
    }
    const checkCount = item.checkCount + 1;
    return this.service.updateReconcileItem(item.id, {
      status: checkCount >= 3 ? "needs_human" : "open",
      attempted: [...item.attempted, `provider:unknown:${result.reason}`],
      checkCount,
      reason: result.reason,
      updatedAt: now
    });
  }

  private suspendFollowing(effect: EffectRecord, targetKey: string): void {
    for (const candidate of this.service.store.listEffects(effect.taskId)) {
      if (candidate.id === effect.id) continue;
      if ((candidate.targetKey ?? targetKeyForEffect(candidate)) !== targetKey) continue;
      if (candidate.createdAt <= effect.createdAt) continue;
      if (!["pending", "prepared", "admitted"].includes(candidate.status)) continue;
      this.service.updateEffect(candidate.id, {
        status: "prepared",
        suspendReason: `等待前序未知效果 ${effect.id} 对账`,
        availableAt: "9999-12-31T23:59:59.999Z",
        targetKey
      });
    }
  }

  private resumeFollowing(item: ReconcileItem): void {
    if (!item.targetKey) return;
    const now = this.now().toISOString();
    for (const candidate of this.service.store.listEffects(item.taskId)) {
      if (!candidate.suspendReason) continue;
      if ((candidate.targetKey ?? targetKeyForEffect(candidate)) !== item.targetKey) continue;
      this.service.updateEffect(candidate.id, {
        status: "prepared",
        suspendReason: null,
        availableAt: now
      });
    }
  }
}

export function targetKeyForEffect(effect: Pick<EffectRecord, "kind" | "target">): string {
  return `${effect.kind}:${stableStringify(effect.target)}`;
}

function riskForEffect(effect: EffectRecord): ReconcileItem["risk"] {
  if (effect.replayPolicy === "never_replay") return "high";
  if (effect.replayPolicy === "process_bound") return "medium";
  return "low";
}

function providerKey(effect: EffectRecord): string {
  return effect.provider ?? effect.kind.split(".")[0] ?? "unknown";
}

function isOpen(status: ReconcileItem["status"]): boolean {
  return status === "open" || status === "checking" || status === "needs_human" || status === "conflicting";
}

export function recommendedResolveActions(item: ReconcileItem): ReconcileAction[] {
  return [...item.suggestedActions];
}
