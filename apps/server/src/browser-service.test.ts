import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserService, type BrowserLauncher } from "./browser-service.ts";

function fakeContext() {
  return {
    pages: () => [],
    newPage: vi.fn(async () => ({ url: () => "about:blank", close: async () => undefined })),
    close: vi.fn(async () => undefined)
  };
}

describe("BrowserService", () => {
  it("launches once against the isolated profile and closes the context", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hearth-browser-service-"));
    const context = fakeContext();
    const launch = vi.fn(async () => context);
    try {
      const service = new BrowserService({
        profileDir: join(dir, "profile"),
        launcher: { launchPersistentContext: launch } as unknown as BrowserLauncher
      });
      expect((await service.status()).running).toBe(false);
      expect(await service.context()).toBe(context);
      expect(await service.context()).toBe(context);
      expect(launch).toHaveBeenCalledTimes(1);
      const [profileDir, options] = launch.mock.calls[0] as unknown as [string, Record<string, unknown>];
      expect(profileDir).toBe(join(dir, "profile"));
      expect(options.headless).toBe(false);
      expect(await service.status()).toMatchObject({ running: true, pages: 0 });
      await service.close();
      expect(context.close).toHaveBeenCalledTimes(1);
      expect((await service.status()).running).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("surfaces a clear launch failure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hearth-browser-service-"));
    try {
      const service = new BrowserService({
        profileDir: join(dir, "profile"),
        launcher: { launchPersistentContext: async () => { throw new Error("no chrome"); } } as unknown as BrowserLauncher
      });
      await expect(service.context()).rejects.toMatchObject({ code: "BROWSER_LAUNCH_FAILED" });
      expect((await service.status()).lastError).toContain("no chrome");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
