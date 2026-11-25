import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserSessionManager, browserFinishIssue, type BrowserSessionManagerOptions } from "./browser-session.ts";
import type { BrowserPage, BrowserScreenshotOptions, BrowserWaitOptions } from "./browser-page.ts";
import type { RawBrowserSnapshot } from "./browser-snapshot.ts";
import type { BrowserService } from "./browser-service.ts";
import type { ExtensionBrowserConnection } from "./browser-extension.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hearth-browser-"));
  tempDirs.push(dir);
  return dir;
}

class FakePage implements BrowserPage {
  readonly backend = "managed" as const;
  currentUrl = "about:blank";
  closed = false;

  url(): string {
    return this.currentUrl;
  }

  async title(): Promise<string> {
    return `Page ${this.currentUrl}`;
  }

  async goto(url: string): Promise<void> {
    this.currentUrl = url;
  }

  async snapshot(epoch: number): Promise<RawBrowserSnapshot> {
    return {
      url: this.currentUrl,
      title: await this.title(),
      frames: [{
        index: 0,
        url: this.currentUrl,
        name: "main",
        text: `page ${this.currentUrl}`,
        elements: [{ ref: `${epoch}:e1`, role: "button", name: "Continue", value: null, disabled: false, checked: null, bbox: { x: 1, y: 2, width: 10, height: 20 }, tag: "button", type: null }]
      }]
    };
  }

  async bringToFront(): Promise<void> {}
  async close(): Promise<void> { this.closed = true; }
  async screenshot(_options?: BrowserScreenshotOptions): Promise<Buffer> { return Buffer.from("png"); }
  async click(): Promise<void> {}
  async hover(): Promise<void> {}
  async type(): Promise<void> {}
  async key(): Promise<void> {}
  async wait(_options: BrowserWaitOptions): Promise<void> {}
  async select(): Promise<void> {}
  async drag(): Promise<void> {}
  async clickAt(): Promise<void> {}
  async typeAt(): Promise<void> {}
  async scroll(): Promise<void> {}
  async upload(): Promise<void> {}
  async download(): Promise<{ data: Buffer; suggestedName: string }> { return { data: Buffer.from("x"), suggestedName: "x.txt" }; }
  async execute(): Promise<unknown> { return null; }
}

function fakeService() {
  return {
    context: vi.fn(),
    close: vi.fn(async () => undefined)
  } as unknown as BrowserService;
}

function manager(options: { statePath?: string; connector?: BrowserSessionManagerOptions["extensionConnector"] } = {}) {
  const pages: FakePage[] = [];
  const instance = new BrowserSessionManager(fakeService(), {
    ...(options.statePath ? { statePath: options.statePath } : {}),
    managedPageFactory: async (url) => {
      const page = new FakePage();
      if (url) page.currentUrl = url;
      pages.push(page);
      return page;
    },
    ...(options.connector ? { extensionConnector: options.connector } : {})
  });
  return { instance, pages };
}

describe("BrowserSessionManager", () => {
  it("reuses one session per task without fixed global session or tab limits", async () => {
    const { instance } = manager();
    try {
      const first = await instance.session("task-a");
      expect(await instance.session("task-a")).toBe(first);
      for (let index = 0; index < 8; index += 1) await instance.createTab("task-a", `https://example.com/${index}`);
      expect(instance.describe("task-a")!.tabs).toHaveLength(9);
      for (let index = 0; index < 8; index += 1) await instance.session(`task-${index}`);
      expect(instance.describe("task-7")?.exists).toBe(true);
    } finally {
      await instance.releaseAll();
    }
  });

  it("uses epoch-scoped refs and requires a fresh observation after takeover", async () => {
    const { instance } = manager();
    try {
      await instance.session("task-a");
      const before = await instance.snapshot("task-a");
      expect(before.elements[0]!.ref).toBe("1:e1");
      const takeover = instance.requestUserTakeover("task-a", "captcha", "请完成验证码");
      expect(takeover.controlState).toBe("awaiting_user");
      expect(takeover.controlEpoch).toBe(2);
      await expect(instance.activePage("task-a")).rejects.toMatchObject({ code: "BROWSER_TAKEOVER" });
      instance.beginUserTakeover("task-a", "captcha");
      const released = await instance.releaseToAgent("task-a");
      expect(released.session.controlState).toBe("agent");
      expect(released.session.controlEpoch).toBe(4);
      const after = released.snapshot!;
      expect(after.elements[0]!.ref).toBe("4:e1");
    } finally {
      await instance.releaseAll();
    }
  });

  it("restores session metadata from disk until an explicit close", async () => {
    const statePath = join(tempDir(), "sessions.json");
    const first = manager({ statePath }).instance;
    await first.session("task-a");
    await first.createTab("task-a", "https://example.com/one");
    first.requestUserTakeover("task-a", "payment_confirmation", "请确认支付");
    await first.stop();

    const second = manager({ statePath }).instance;
    try {
      const descriptor = second.describe("task-a");
      expect(descriptor).toMatchObject({
        exists: true,
        backend: "managed",
        controlState: "awaiting_user",
        takeoverKind: "payment_confirmation",
        takeoverReason: "请确认支付"
      });
      expect(descriptor?.tabs).toHaveLength(2);
      await second.close("task-a");
      expect(second.describe("task-a")).toBeNull();
    } finally {
      await second.releaseAll();
    }
  });

  it("falls back to managed Chrome when a paired extension is not available", async () => {
    const connector = vi.fn(async () => { throw new Error("extension offline"); });
    const tokenPath = join(tempDir(), "extension-token");
    writeFileSync(tokenPath, "1234567890abcdef");
    const pages: FakePage[] = [];
    const instance = new BrowserSessionManager(fakeService(), {
      extensionTokenPath: tokenPath,
      extensionConnector: connector,
      managedPageFactory: async () => {
        const page = new FakePage();
        pages.push(page);
        return page;
      }
    });
    try {
      const session = await instance.session("task-a");
      expect(session.backend).toBe("managed");
      expect(session.unavailableReason).toContain("回退到受管 Chrome");
      expect(pages).toHaveLength(1);
    } finally {
      await instance.releaseAll();
    }
  });

  it("stores and reports an extension token without exposing it in status", async () => {
    const dir = tempDir();
    const tokenPath = join(dir, "extension-token");
    const instance = new BrowserSessionManager(fakeService(), { extensionTokenPath: tokenPath });
    writeFileSync(tokenPath, "1234567890abcdef");
    expect(instance.extensionStatus()).toMatchObject({ paired: true, extensionId: "mmlmfjhmonkocbjadbfplnigmagldckm" });
    expect(JSON.stringify(instance.extensionStatus())).not.toContain("1234567890abcdef");
  });

  it("preserves tab order and the active tab when reconnecting the extension", async () => {
    const connector = vi.fn(async () => ({
      attachInitialPage: async (url?: string) => {
        const page = new FakePage();
        page.currentUrl = url ?? "about:blank";
        return page;
      },
      createPage: async (url?: string) => {
        const page = new FakePage();
        page.currentUrl = url ?? "about:blank";
        return page;
      },
      close: async () => undefined
    } as unknown as ExtensionBrowserConnection));
    const { instance } = manager({ connector });
    try {
      await instance.session("task-a", { backend: "managed" });
      await instance.createTab("task-a", "https://example.com/one");
      const active = await instance.createTab("task-a", "https://example.com/two");
      await instance.createTab("task-a", "https://example.com/three");
      await instance.activateTab("task-a", active.id);

      await instance.connectExtension("task-a");

      const descriptor = instance.describe("task-a")!;
      expect(descriptor.tabs.map((tab) => tab.url)).toEqual([
        "about:blank",
        "https://example.com/one",
        "https://example.com/two",
        "https://example.com/three"
      ]);
      expect(descriptor.tabs.find((tab) => tab.active)?.url).toBe("https://example.com/two");
    } finally {
      await instance.stop();
      await instance.releaseAll();
    }
  });

  it("does not replace the previous token when an extension connection attempt fails", async () => {
    const tokenPath = join(tempDir(), "extension-token");
    writeFileSync(tokenPath, "1234567890abcdef");
    const instance = new BrowserSessionManager(fakeService(), {
      extensionTokenPath: tokenPath,
      extensionConnector: async (options) => {
        expect(options.token).toBe("fedcba0987654321");
        expect(readFileSync(options.tokenPath, "utf8")).toBe("1234567890abcdef");
        throw new Error("pairing rejected");
      }
    });

    await expect(instance.connectExtension("task-a", "fedcba0987654321")).rejects.toThrow("pairing rejected");
    expect(readFileSync(tokenPath, "utf8")).toBe("1234567890abcdef");
    expect(existsSync(tokenPath)).toBe(true);
    await instance.releaseAll();
  });

  it("persists a supplied token only after the extension session is usable", async () => {
    const tokenPath = join(tempDir(), "extension-token");
    const instance = new BrowserSessionManager(fakeService(), {
      extensionTokenPath: tokenPath,
      extensionConnector: async (options) => {
        expect(options.token).toBe("fedcba0987654321");
        expect(existsSync(tokenPath)).toBe(false);
        return {
          attachInitialPage: async () => new FakePage(),
          createPage: async () => new FakePage(),
          close: async () => undefined
        } as unknown as ExtensionBrowserConnection;
      }
    });

    await instance.connectExtension("task-a", "fedcba0987654321");
    expect(readFileSync(tokenPath, "utf8")).toBe("fedcba0987654321");
    await instance.releaseAll();
  });
});

describe("browserFinishIssue", () => {
  it("never gates completion on browser assertions", () => {
    expect(browserFinishIssue(undefined)).toBeNull();
    expect(browserFinishIssue({ assertions: [], steps: [{ tool: "browser_open" }] } as never)).toBeNull();
  });
});
