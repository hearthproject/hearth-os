import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HearthStore } from "@hearth/eventlog";
import { buildServer } from "./app.ts";
import { OnboardingService } from "./onboarding.ts";

describe("OnboardingService", () => {
  let store: HearthStore;

  beforeEach(() => {
    store = new HearthStore(":memory:");
  });

  afterEach(() => store.close());

  function service(configured = false): OnboardingService {
    return new OnboardingService({
      store,
      isChatModelConfigured: () => configured,
      readyExecutorIds: () => ["native"],
      memoryAutoCapture: () => "off",
      proactiveEnabled: () => true,
      now: () => new Date("2026-11-08T00:00:00.000Z")
    });
  }

  it("requires onboarding only when unconfigured and not completed", () => {
    const instance = service(false);
    expect(instance.snapshot()).toMatchObject({
      required: true,
      state: null,
      checks: { chatModelConfigured: false, readyExecutorIds: ["native"], memoryAutoCapture: "off", proactiveEnabled: true }
    });

    expect(instance.complete()).toMatchObject({
      required: false,
      state: { status: "completed", completedAt: "2026-11-08T00:00:00.000Z" }
    });
    expect(instance.snapshot().required).toBe(false);

    expect(instance.reset().required).toBe(true);
  });

  it("records a skipped onboarding separately", () => {
    const instance = service(false);
    expect(instance.complete({ skipped: true }).state?.status).toBe("skipped");
  });

  it("does not require onboarding when a chat model is already configured", () => {
    expect(service(true).snapshot()).toMatchObject({ required: false, state: null });
  });

  it("ignores malformed stored state", () => {
    store.setAppSetting("onboarding.v1", "{not-json");
    expect(service(false).snapshot().required).toBe(true);
  });
});

describe("onboarding API", () => {
  let store: HearthStore;
  let root: string;

  beforeEach(() => {
    store = new HearthStore(":memory:");
    root = mkdtempSync(join(tmpdir(), "hearth-onboarding-"));
  });

  afterEach(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  async function app() {
    return buildServer({
      store,
      serveWeb: false,
      masterKeyPath: join(root, "master.key"),
      modelSettingsPath: join(root, "model-settings.json"),
      executorSettingsPath: join(root, "executor-settings.json"),
      attachmentRoot: join(root, "attachments")
    });
  }

  it("exposes first-run state, completes, resets, and validates input", async () => {
    const server = await app();
    try {
      const initial = await server.inject({ method: "GET", url: "/api/onboarding" });
      expect(initial.statusCode).toBe(200);
      expect(initial.json().required).toBe(true);

      const completed = await server.inject({
        method: "POST",
        url: "/api/onboarding/complete",
        payload: { skipped: true }
      });
      expect(completed.statusCode).toBe(200);
      expect(completed.json()).toMatchObject({ required: false, state: { status: "skipped" } });

      const reset = await server.inject({ method: "POST", url: "/api/onboarding/reset" });
      expect(reset.json().required).toBe(true);

      const invalid = await server.inject({
        method: "POST",
        url: "/api/onboarding/complete",
        payload: { skipped: "yes" }
      });
      expect(invalid.statusCode).toBe(400);
    } finally {
      await server.close();
    }
  }, 15_000);

  it("stops requiring onboarding after a chat model is saved", async () => {
    const server = await app();
    try {
      const saved = await server.inject({
        method: "PUT",
        url: "/api/model-settings",
        payload: {
          providerId: "deepseek",
          providerName: "DeepSeek",
          baseUrl: "https://api.deepseek.com/v1",
          model: "deepseek-chat",
          apiKey: "sk-test-onboarding"
        }
      });
      expect(saved.statusCode, saved.body).toBe(200);

      const snapshot = await server.inject({ method: "GET", url: "/api/onboarding" });
      expect(snapshot.json()).toMatchObject({
        required: false,
        state: null,
        checks: { chatModelConfigured: true }
      });
    } finally {
      await server.close();
    }
  });
});
