import type { ExecutorId, OnboardingSnapshot, OnboardingState } from "@hearth/core";
import type { HearthStore } from "@hearth/eventlog";

export const ONBOARDING_SETTINGS_KEY = "onboarding.v1";

export interface OnboardingDependencies {
  store: HearthStore;
  isChatModelConfigured: () => boolean;
  readyExecutorIds: () => ExecutorId[];
  memoryAutoCapture: () => OnboardingSnapshot["checks"]["memoryAutoCapture"];
  proactiveEnabled: () => boolean;
  now?: () => Date;
}

export class OnboardingService {
  private readonly store: HearthStore;
  private readonly isChatModelConfigured: () => boolean;
  private readonly readyExecutorIds: () => ExecutorId[];
  private readonly memoryAutoCapture: () => OnboardingSnapshot["checks"]["memoryAutoCapture"];
  private readonly proactiveEnabled: () => boolean;
  private readonly now: () => Date;

  constructor(dependencies: OnboardingDependencies) {
    this.store = dependencies.store;
    this.isChatModelConfigured = dependencies.isChatModelConfigured;
    this.readyExecutorIds = dependencies.readyExecutorIds;
    this.memoryAutoCapture = dependencies.memoryAutoCapture;
    this.proactiveEnabled = dependencies.proactiveEnabled;
    this.now = dependencies.now ?? (() => new Date());
  }

  snapshot(): OnboardingSnapshot {
    const state = this.state();
    const chatModelConfigured = this.isChatModelConfigured();
    return {
      required: state === null && !chatModelConfigured,
      state,
      checks: {
        chatModelConfigured,
        readyExecutorIds: this.readyExecutorIds(),
        memoryAutoCapture: this.memoryAutoCapture(),
        proactiveEnabled: this.proactiveEnabled()
      }
    };
  }

  complete(input: { skipped?: boolean | undefined } = {}): OnboardingSnapshot {
    const state: OnboardingState = {
      status: input.skipped ? "skipped" : "completed",
      completedAt: this.now().toISOString()
    };
    this.store.setAppSetting(ONBOARDING_SETTINGS_KEY, JSON.stringify(state));
    return this.snapshot();
  }

  reset(): OnboardingSnapshot {
    this.store.deleteAppSetting(ONBOARDING_SETTINGS_KEY);
    return this.snapshot();
  }

  private state(): OnboardingState | null {
    const raw = this.store.getAppSetting(ONBOARDING_SETTINGS_KEY);
    if (!raw) return null;
    try {
      const value = JSON.parse(raw) as unknown;
      if (!value || typeof value !== "object") return null;
      const record = value as Record<string, unknown>;
      if (record.status !== "completed" && record.status !== "skipped") return null;
      if (typeof record.completedAt !== "string" || !record.completedAt) return null;
      return { status: record.status, completedAt: record.completedAt };
    } catch {
      return null;
    }
  }
}