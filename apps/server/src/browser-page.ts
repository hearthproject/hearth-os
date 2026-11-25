import type { Frame, Locator, Page } from "playwright-core";
import type { RawBrowserSnapshot } from "./browser-snapshot.ts";
import { captureRawBrowserSnapshot } from "./browser-snapshot.ts";
import { BrowserError } from "./browser-service.ts";

export interface BrowserScreenshotOptions {
  path?: string | undefined;
  fullPage?: boolean | undefined;
}

export interface BrowserWaitOptions {
  kind: "element" | "text" | "idle";
  value?: string | undefined;
  timeoutMs: number;
}

export interface BrowserPointerOptions {
  button?: "left" | "right" | "middle" | undefined;
  clickCount?: number | undefined;
}

/** Minimal page contract shared by the managed profile and the daily-Chrome extension. */
export interface BrowserPage {
  readonly backend: "managed" | "extension";
  url(): string;
  title(): Promise<string>;
  goto(url: string, timeoutMs: number): Promise<void>;
  snapshot(epoch: number): Promise<RawBrowserSnapshot>;
  bringToFront(): Promise<void>;
  close(): Promise<void>;
  screenshot(options?: BrowserScreenshotOptions): Promise<Buffer | void>;
  click(ref: string, timeoutMs: number, options?: BrowserPointerOptions): Promise<void>;
  hover(ref: string, timeoutMs: number): Promise<void>;
  type(ref: string, text: string, clear: boolean, timeoutMs: number): Promise<void>;
  key(key: string): Promise<void>;
  wait(options: BrowserWaitOptions): Promise<void>;
  select(ref: string, values: string[], timeoutMs: number): Promise<void>;
  drag(startRef: string, endRef: string, timeoutMs: number): Promise<void>;
  clickAt(x: number, y: number, options?: BrowserPointerOptions): Promise<void>;
  typeAt(x: number, y: number, text: string): Promise<void>;
  scroll(deltaX: number, deltaY: number): Promise<void>;
  upload(ref: string, path: string, timeoutMs: number): Promise<void>;
  download(ref: string, timeoutMs: number): Promise<{ data: Buffer; suggestedName: string }>;
  execute(code: string): Promise<unknown>;
}

export class ManagedBrowserPage implements BrowserPage {
  readonly backend = "managed" as const;
  private readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  url(): string {
    return this.page.url();
  }

  title(): Promise<string> {
    return this.page.title().catch(() => "");
  }

  async goto(url: string, timeoutMs: number): Promise<void> {
    await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await this.page.waitForTimeout(250);
  }

  snapshot(epoch: number): Promise<RawBrowserSnapshot> {
    return captureRawBrowserSnapshot(this.page, epoch);
  }

  async bringToFront(): Promise<void> {
    await this.page.bringToFront().catch(() => undefined);
  }

  async close(): Promise<void> {
    await this.page.close().catch(() => undefined);
  }

  async screenshot(options: BrowserScreenshotOptions = {}): Promise<Buffer | void> {
    if (options.path) {
      await this.page.screenshot({ path: options.path, fullPage: Boolean(options.fullPage), type: "png" });
      return;
    }
    return this.page.screenshot({ fullPage: Boolean(options.fullPage), type: "png" });
  }

  async click(ref: string, timeoutMs: number, options: BrowserPointerOptions = {}): Promise<void> {
    await (await this.locate(ref)).click({
      timeout: timeoutMs,
      ...(options.button ? { button: options.button } : {}),
      ...(options.clickCount ? { clickCount: options.clickCount } : {})
    });
  }

  async hover(ref: string, timeoutMs: number): Promise<void> {
    await (await this.locate(ref)).hover({ timeout: timeoutMs });
  }

  async type(ref: string, text: string, clear: boolean, timeoutMs: number): Promise<void> {
    const target = await this.locate(ref);
    if (clear) await target.fill("", { timeout: timeoutMs });
    await target.fill(text, { timeout: timeoutMs });
  }

  async key(key: string): Promise<void> {
    await this.page.keyboard.press(key);
  }

  async wait(options: BrowserWaitOptions): Promise<void> {
    if (options.kind === "element") {
      if (!options.value) throw new BrowserError("BROWSER_WAIT_VALUE", "等待元素时必须提供元素 ID");
      for (const frame of this.page.frames()) {
        const target = frame.locator(`[data-hearth-ref="${cssEscape(options.value)}"]`);
        if (await target.count()) {
          await target.first().waitFor({ state: "visible", timeout: options.timeoutMs });
          return;
        }
      }
      throw new BrowserError("BROWSER_ELEMENT_MISSING", `页面中找不到元素 ${options.value}`);
    }
    if (options.kind === "text") {
      if (!options.value) throw new BrowserError("BROWSER_WAIT_VALUE", "等待文字时必须提供文字");
      const deadline = Date.now() + options.timeoutMs;
      while (Date.now() < deadline) {
        for (const frame of this.page.frames()) {
          const found = await frame.evaluate((text) => (document.body?.innerText ?? "").includes(text), options.value).catch(() => false);
          if (found) return;
        }
        await this.page.waitForTimeout(100);
      }
      throw new BrowserError("BROWSER_WAIT_TIMEOUT", `等待文字超时：${options.value}`);
    }
    await this.page.waitForLoadState("networkidle", { timeout: options.timeoutMs }).catch(() => undefined);
  }

  async select(ref: string, values: string[], timeoutMs: number): Promise<void> {
    await (await this.locate(ref)).selectOption(values, { timeout: timeoutMs });
  }

  async drag(startRef: string, endRef: string, timeoutMs: number): Promise<void> {
    await (await this.locate(startRef)).dragTo(await this.locate(endRef), { timeout: timeoutMs });
  }

  async clickAt(x: number, y: number, options: BrowserPointerOptions = {}): Promise<void> {
    await this.page.mouse.click(x, y, {
      ...(options.button ? { button: options.button } : {}),
      ...(options.clickCount ? { clickCount: options.clickCount } : {})
    });
  }

  async typeAt(x: number, y: number, text: string): Promise<void> {
    await this.page.mouse.click(x, y);
    await this.page.keyboard.insertText(text);
  }

  async scroll(deltaX: number, deltaY: number): Promise<void> {
    await this.page.mouse.wheel(deltaX, deltaY);
  }

  async upload(ref: string, path: string, timeoutMs: number): Promise<void> {
    await (await this.locate(ref)).setInputFiles(path, { timeout: timeoutMs });
  }

  async download(ref: string, timeoutMs: number): Promise<{ data: Buffer; suggestedName: string }> {
    const downloadPromise = this.page.waitForEvent("download", { timeout: timeoutMs });
    await (await this.locate(ref)).click({ timeout: timeoutMs });
    const download = await downloadPromise;
    const path = await download.path();
    if (!path) throw new BrowserError("BROWSER_DOWNLOAD_FAILED", "浏览器没有生成可读取的下载文件");
    const { readFile } = await import("node:fs/promises");
    return { data: await readFile(path), suggestedName: download.suggestedFilename() };
  }

  async execute(code: string): Promise<unknown> {
    return this.page.evaluate(code);
  }

  private async locate(ref: string): Promise<Locator> {
    for (const frame of this.page.frames()) {
      const target = frame.locator(`[data-hearth-ref="${cssEscape(ref)}"]`);
      if (await target.count()) return target.first();
    }
    throw new BrowserError("BROWSER_ELEMENT_MISSING", `页面中找不到元素 ${ref}，请先重新读取页面`);
  }
}

export async function frameForRef(page: Page, ref: string): Promise<{ frame: Frame; locator: Locator } | null> {
  for (const frame of page.frames()) {
    const locator = frame.locator(`[data-hearth-ref="${cssEscape(ref)}"]`);
    if (await locator.count()) return { frame, locator: locator.first() };
  }
  return null;
}

export function cssEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function extensionLocateCode(ref: string, action: string): string {
  return `async (page) => {
    for (const frame of page.frames()) {
      const target = frame.locator('[data-hearth-ref="${cssEscape(ref)}"]');
      if (await target.count()) {
        const item = target.first();
        ${action}
        return { ok: true };
      }
    }
    return { ok: false, error: 'BROWSER_ELEMENT_MISSING' };
  }`;
}

export function extensionFrameTextCode(text: string): string {
  return `async (page) => {
    for (const frame of page.frames()) {
      const found = await frame.evaluate((value) => (document.body?.innerText ?? '').includes(value), ${JSON.stringify(text)}).catch(() => false);
      if (found) return { ok: true };
    }
    return { ok: false };
  }`;
}
