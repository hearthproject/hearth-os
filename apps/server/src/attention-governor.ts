import { randomUUID } from "node:crypto";
import type { AttentionFeedbackRecord, AttentionItem } from "@hearth/core";
import type { HearthService } from "./service.ts";
import type { HeartbeatRun } from "@hearth/core";

export interface AttentionGovernorSettings {
  shadowMode: boolean;
  minFeedbackSamples: number;
}

export interface AttentionScoreBreakdown {
  priority: number;
  urgency: number;
  impact: number;
  waitingOn: number;
  critical: number;
  reversibility: number;
  feedbackBias: number;
  total: number;
}

export interface AttentionExplanation {
  item: AttentionItem;
  score: AttentionScoreBreakdown;
  whyYouSeeThis: string;
  feedback: { total: number; accepted: number; ignored: number; wrong: number; bias: number };
  aggregation: { key: string; peers: number };
}

export type AttentionFeedbackAction = AttentionFeedbackRecord["action"];

export interface AttentionFeedbackInput {
  action: AttentionFeedbackAction;
  channel?: string;
  note?: string;
}

const SETTINGS_KEY = "attention.governor";
const DEFAULT_SETTINGS: AttentionGovernorSettings = {
  shadowMode: false,
  minFeedbackSamples: 20
};

const DEFAULT_IMPACT: Record<string, number> = {
  decision: 16,
  approval: 12,
  credential: 12,
  conflict: 15,
  commitment: 10,
  deadline: 18,
  blocked: 14,
  reconcile: 20,
  opportunity: 8,
  progress: 4,
  suggestion: 3
};

export class AttentionGovernor {
  constructor(
    private readonly service: HearthService,
    private readonly clock: () => Date = () => new Date()
  ) {}

  settings(): AttentionGovernorSettings {
    const raw = this.service.store.getAppSetting(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    try {
      const parsed = JSON.parse(raw) as Partial<AttentionGovernorSettings>;
      return {
        shadowMode: parsed.shadowMode === true,
        minFeedbackSamples: Math.max(20, Math.min(500, Number(parsed.minFeedbackSamples ?? DEFAULT_SETTINGS.minFeedbackSamples)))
      };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  updateSettings(patch: Partial<AttentionGovernorSettings>): AttentionGovernorSettings {
    const next = {
      shadowMode: patch.shadowMode ?? this.settings().shadowMode,
      minFeedbackSamples: Math.max(20, Math.min(500, patch.minFeedbackSamples ?? this.settings().minFeedbackSamples))
    };
    this.service.store.setAppSetting(SETTINGS_KEY, JSON.stringify(next));
    return next;
  }

  list(items: AttentionItem[]): AttentionItem[] {
    const now = this.clock();
    const shadow = this.settings().shadowMode;
    const scored = items.map((item) => ({ item, score: this.score(item, now).total }));
    const byAggregation = new Map<string, Array<{ item: AttentionItem; score: number }>>();
    for (const entry of scored) {
      const key = entry.item.aggregationKey ?? "";
      if (!key) continue;
      const group = byAggregation.get(key) ?? [];
      group.push(entry);
      byAggregation.set(key, group);
    }
    const shadowed = new Set<string>();
    for (const group of byAggregation.values()) {
      group.sort((left, right) => right.score - left.score);
      for (const entry of group.slice(1)) shadowed.add(entry.item.id);
    }
    return scored
      .map(({ item, score }) => ({
        ...item,
        score: Math.round(score * 10) / 10,
        shadowed: shadow || shadowed.has(item.id)
      }))
      .sort((left, right) => (right.score ?? 0) - (left.score ?? 0)
        || Date.parse(left.waitingSince) - Date.parse(right.waitingSince));
  }

  explain(id: string): AttentionExplanation | null {
    const item = this.service.store.getAttentionItem(id);
    if (!item) return null;
    const score = this.score(item, this.clock());
    const feedback = this.feedbackStats(item.kind);
    const peers = item.aggregationKey
      ? this.service.store.listAttentionItems({ status: "open", limit: 500 }).filter((entry) => entry.aggregationKey === item.aggregationKey).length
      : 1;
    const why = [
      `现在提醒：${item.whyNow}`,
      `需要你处理：${item.waitingOn === "user" ? "是" : item.waitingOn === "agent" ? "由 Agent 继续推进" : "等待外部系统"}`,
      `不处理：${item.consequence}`,
      `建议动作：${item.nextAction}`,
      item.evidenceRefs?.length ? `证据：${item.evidenceRefs.slice(0, 6).join("、")}` : ""
    ].filter(Boolean).join("\n");
    return {
      item,
      score,
      whyYouSeeThis: why,
      feedback,
      aggregation: { key: item.aggregationKey ?? item.dedupeKey, peers }
    };
  }

  feedback(id: string, input: AttentionFeedbackInput): { record: AttentionFeedbackRecord; stats: ReturnType<AttentionGovernor["feedbackStats"]> } {
    const item = this.service.store.getAttentionItem(id);
    if (!item) throw new Error("ATTENTION_NOT_FOUND");
    const now = this.clock();
    const record: AttentionFeedbackRecord = {
      id: `afb:${randomUUID()}`,
      attentionId: id,
      kind: item.kind,
      action: input.action,
      timeOfDay: `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`,
      channel: input.channel?.trim() || "app",
      createdAt: now.toISOString()
    };
    const event = this.service.store.appendEvent({ type: "attention.feedback.recorded", taskId: item.taskId, payload: record });
    this.service.bus.publish(event);
    return { record, stats: this.feedbackStats(item.kind) };
  }

  feedbackStats(kind: string): { total: number; accepted: number; ignored: number; wrong: number; bias: number } {
    const records = this.service.store.listAttentionFeedback({ kind, limit: 500 });
    const accepted = records.filter((record) => record.action === "accept" || record.action === "resolve").length;
    const ignored = records.filter((record) => record.action === "ignore" || record.action === "snooze").length;
    const wrong = records.filter((record) => record.action === "wrong").length;
    const settings = this.settings();
    let bias = 0;
    if (records.length >= settings.minFeedbackSamples) {
      const negativeRate = (ignored + wrong) / records.length;
      const positiveRate = accepted / records.length;
      if (negativeRate >= 0.6) bias -= 15;
      else if (positiveRate >= 0.6) bias += 10;
    }
    return { total: records.length, accepted, ignored, wrong, bias };
  }

  deliveryAllowed(run: HeartbeatRun): boolean {
    if (!this.settings().shadowMode) return true;
    return run.attentionIds.length === 0;
  }

  private score(item: AttentionItem, now: Date): AttentionScoreBreakdown {
    const ageHours = Math.max(0, (now.getTime() - Date.parse(item.waitingSince)) / 3_600_000);
    const priority = Math.max(0, 100 - item.priority * 7);
    const urgency = Math.min(20, Math.round(ageHours * 1.5));
    const impact = Math.min(25, item.impact ?? DEFAULT_IMPACT[item.kind] ?? 5);
    const waitingOn = item.waitingOn === "user" ? 8 : item.waitingOn === "external" ? 2 : -6;
    const critical = item.critical ? 30 : 0;
    const reversibility = item.reversibility === "irreversible" ? 8 : item.reversibility === "hard" ? 4 : 0;
    const feedbackBias = this.feedbackStats(item.kind).bias;
    const total = Math.max(0, Math.min(200, priority + urgency + impact + waitingOn + critical + reversibility + feedbackBias));
    return { priority, urgency, impact, waitingOn, critical, reversibility, feedbackBias, total };
  }
}
