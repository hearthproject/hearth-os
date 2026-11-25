import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { createRequire } from "node:module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { BrowserError } from "./browser-service.ts";
import {
  cssEscape,
  extensionFrameTextCode,
  extensionLocateCode,
  type BrowserPage,
  type BrowserPointerOptions,
  type BrowserScreenshotOptions,
  type BrowserWaitOptions
} from "./browser-page.ts";
import { extensionSnapshotCode, type RawBrowserSnapshot } from "./browser-snapshot.ts";
import { redactKnownSecrets } from "./browser-redaction.ts";

const MCP_PACKAGE = "@playwright/mcp/package.json";
const EXTENSION_ID = "mmlmfjhmonkocbjadbfplnigmagldckm";
const EXTENSION_STORE_URL = `https://chromewebstore.google.com/detail/playwright-extension/${EXTENSION_ID}`;
const PALETTE = ["blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"] as const;

export interface ExtensionConnectionOptions {
  taskId: string;
  tokenPath: string;
  token?: string | undefined;
  outputDir: string;
  profileDirName?: string | undefined;
  connectTimeoutMs?: number | undefined;
}

export interface ExtensionStatus {
  extensionId: string;
  installUrl: string;
  paired: boolean;
  tokenPath: string;
}

export interface McpContent {
  type?: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface McpResult {
  content?: McpContent[];
  isError?: boolean;
  structuredContent?: unknown;
}

export class ExtensionBrowserConnection {
  readonly taskId: string;
  readonly tokenPath: string;
  private readonly token: string | undefined;
  private readonly outputDir: string;
  private readonly profileDirName: string | undefined;
  private readonly connectTimeoutMs: number;
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private pages: ExtensionBrowserPage[] = [];
  private pageCount = 0;
  private disposed = false;

  private constructor(options: ExtensionConnectionOptions) {
    this.taskId = options.taskId;
    this.tokenPath = options.tokenPath;
    this.token = options.token;
    this.outputDir = options.outputDir;
    this.profileDirName = options.profileDirName;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 90_000;
  }

  static async connect(options: ExtensionConnectionOptions): Promise<ExtensionBrowserConnection> {
    const connection = new ExtensionBrowserConnection(options);
    await connection.open();
    return connection;
  }

  static status(tokenPath: string): ExtensionStatus {
    let paired = false;
    try {
      paired = readFileSync(tokenPath, "utf8").trim().length >= 16;
    } catch {
      paired = false;
    }
    return { extensionId: EXTENSION_ID, installUrl: EXTENSION_STORE_URL, paired, tokenPath };
  }

  static saveToken(tokenPath: string, token: string): void {
    mkdirSync(dirname(tokenPath), { recursive: true });
    writeFileSync(tokenPath, token.trim(), { encoding: "utf8", mode: 0o600 });
  }

  async createPage(url?: string): Promise<ExtensionBrowserPage> {
    const action = url ? "new" : "new";
    const result = await this.call("browser_tabs", { action, ...(url ? { url } : {}) });
    assertToolOk(result, "扩展浏览器无法新建标签页");
    this.pageCount += 1;
    const index = await this.currentTabIndex();
    const page = new ExtensionBrowserPage(this, Math.max(0, index));
    this.pages.push(page);
    return page;
  }

  async attachInitialPage(restoredUrl?: string): Promise<ExtensionBrowserPage> {
    // The first snapshot is also the point where Chrome opens its extension
    // approval page. A token created from the extension UI bypasses that step.
    const initial = await this.call("browser_snapshot", {}, this.connectTimeoutMs);
    if (initial.isError) throw new BrowserError("BROWSER_EXTENSION_UNAVAILABLE", textFrom(initial) || "Playwright Extension 未连接");
    this.pageCount = 1;
    const page = new ExtensionBrowserPage(this, await this.currentTabIndex());
    this.pages.push(page);
    if (restoredUrl && restoredUrl !== "about:blank") await page.goto(restoredUrl, 60_000);
    return page;
  }

  async close(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.client?.close().catch(() => undefined);
    await this.transport?.close().catch(() => undefined);
    this.client = null;
    this.transport = null;
  }

  async call(name: string, args: Record<string, unknown>, timeoutMs = 45_000): Promise<McpResult> {
    if (!this.client) throw new BrowserError("BROWSER_EXTENSION_UNAVAILABLE", "Playwright Extension 会话未连接");
    return this.client.callTool(
      { name, arguments: args },
      undefined,
      { timeout: timeoutMs, maxTotalTimeout: timeoutMs }
    ) as Promise<McpResult>;
  }

  async closePage(page: ExtensionBrowserPage): Promise<void> {
    const index = page.tabIndexValue();
    const result = await this.call("browser_tabs", { action: "close", index });
    assertToolOk(result, `无法关闭扩展标签页 ${index}`);
    this.pages = this.pages.filter((item) => item !== page);
    for (const item of this.pages) {
      if (item.tabIndexValue() > index) item.shiftIndex();
    }
  }
  async select(index: number): Promise<void> {
    const result = await this.call("browser_tabs", { action: "select", index });
    assertToolOk(result, `无法切换到标签页 ${index}`);
  }

  private async open(): Promise<void> {
    mkdirSync(this.outputDir, { recursive: true });
    const require = createRequire(import.meta.url);
    const packagePath = require.resolve(MCP_PACKAGE);
    const cliPath = join(dirname(packagePath), "cli.js");
    const token = this.token ?? readToken(this.tokenPath);
    const hash = createHash("sha256").update(this.taskId).digest()[0] ?? 0;
    const args = [
      cliPath,
      "--extension",
      "--browser", "chrome",
      "--caps", "vision",
      "--allow-unrestricted-file-access",
      "--output-dir", this.outputDir,
      "--session-name", `Hearth · ${this.taskId.slice(0, 12)}`,
      "--session-color", PALETTE[hash % PALETTE.length]!,
      "--timeout-action", "45000",
      "--timeout-navigation", "60000",
      "--timeout-settle", "250"
    ];
    if (this.profileDirName) args.push("--profile-dir-name", this.profileDirName);
    const env: Record<string, string> = { ...process.env as Record<string, string> };
    if (token) env.PLAYWRIGHT_MCP_EXTENSION_TOKEN = token;
    const transport = new StdioClientTransport({
      command: process.execPath,
      args,
      cwd: process.cwd(),
      env,
      stderr: "pipe"
    });
    const client = new Client({ name: "hearth-browser", version: "0.6.2" }, { capabilities: {} });
    try {
      await client.connect(transport);
      this.client = client;
      this.transport = transport;
    } catch (error) {
      await client.close().catch(() => undefined);
      await transport.close().catch(() => undefined);
      throw new BrowserError("BROWSER_EXTENSION_UNAVAILABLE", `无法启动 Playwright Extension 连接：${errorMessage(error)}`);
    }
  }

  private async currentTabIndex(): Promise<number> {
    const result = await this.call("browser_tabs", { action: "list" });
    const current = parseTabsMarkdown(textFrom(result)).find((tab) => tab.current);
    if (current) return current.index;
    return Math.max(0, this.pageCount - 1);
  }
}

export class ExtensionBrowserPage implements BrowserPage {
  readonly backend = "extension" as const;
  private tabIndex: number;
  private readonly connection: ExtensionBrowserConnection;

  constructor(connection: ExtensionBrowserConnection, tabIndex: number) {
    this.connection = connection;
    this.tabIndex = tabIndex;
  }

  url(): string {
    return this.lastUrl;
  }

  private lastUrl = "";
  private lastTitle = "";

  async title(): Promise<string> {
    const value = await this.runJson<{ title?: string }>(`async (page) => ({ title: await page.title().catch(() => '') })`);
    return value.title ?? this.lastTitle;
  }

  async goto(url: string, timeoutMs: number): Promise<void> {
    await this.selectBrowserTab();
    const result = await this.connection.call("browser_navigate", { url }, timeoutMs + 5_000);
    assertToolOk(result, `无法打开网页 ${url}`);
    this.lastUrl = url;
  }

  async snapshot(epoch: number): Promise<RawBrowserSnapshot> {
    await this.selectBrowserTab();
    const raw = await this.runJson<RawBrowserSnapshot>(extensionSnapshotCode(epoch));
    if (!raw || !Array.isArray(raw.frames)) throw new BrowserError("BROWSER_SNAPSHOT_FAILED", "扩展浏览器没有返回有效页面快照");
    this.lastUrl = raw.url;
    this.lastTitle = raw.title;
    return raw;
  }

  async bringToFront(): Promise<void> {
    await this.selectBrowserTab();
  }

  async close(): Promise<void> {
    await this.connection.closePage(this);
  }

  async screenshot(options: BrowserScreenshotOptions = {}): Promise<Buffer | void> {
    await this.selectBrowserTab();
    const filename = options.path && isAbsolute(options.path) ? options.path : undefined;
    const result = await this.connection.call("browser_take_screenshot", {
      type: "png",
      ...(options.fullPage ? { fullPage: true } : {}),
      ...(filename ? { filename } : {})
    }, 60_000);
    assertToolOk(result, "扩展浏览器截图失败");
    if (filename) return;
    const image = result.content?.find((item) => item.type === "image" && item.data);
    return image?.data ? Buffer.from(image.data, "base64") : undefined;
  }

  async click(ref: string, timeoutMs: number, options: BrowserPointerOptions = {}): Promise<void> {
    await this.selectBrowserTab();
    await this.runAction(extensionLocateCode(ref, [
      `await item.click({ timeout: ${Math.max(1, timeoutMs)}${options.button ? `, button: '${options.button}'` : ""}${options.clickCount ? `, clickCount: ${options.clickCount}` : ""} });`
    ].join("\n")));
  }

  async hover(ref: string, timeoutMs: number): Promise<void> {
    await this.selectBrowserTab();
    await this.runAction(extensionLocateCode(ref, `await item.hover({ timeout: ${Math.max(1, timeoutMs)} });`));
  }

  async type(ref: string, text: string, clear: boolean, timeoutMs: number): Promise<void> {
    await this.selectBrowserTab();
    const code = extensionLocateCode(
      ref,
      `${clear ? `await item.fill('', { timeout: ${Math.max(1, timeoutMs)} });` : ""}\nawait item.fill(${JSON.stringify(text)}, { timeout: ${Math.max(1, timeoutMs)} });`
    );
    await this.runAction(code, [text]);
  }

  async key(key: string): Promise<void> {
    await this.selectBrowserTab();
    const result = await this.connection.call("browser_press_key", { key });
    assertToolOk(result, `无法按下按键 ${key}`);
  }

  async wait(options: BrowserWaitOptions): Promise<void> {
    await this.selectBrowserTab();
    if (options.kind === "element") {
      if (!options.value) throw new BrowserError("BROWSER_WAIT_VALUE", "等待元素时必须提供元素 ID");
      const code = extensionLocateCode(options.value, "return { ok: true };").replace(
        "return { ok: true };\n        return { ok: true };",
        "return { ok: true };"
      );
      const result = await this.runJson<{ ok?: boolean }>(`async (page) => {
        const deadline = Date.now() + ${Math.max(1, options.timeoutMs)};
        while (Date.now() < deadline) {
          for (const frame of page.frames()) {
            const target = frame.locator('[data-hearth-ref="${cssEscape(options.value)}"]');
            if (await target.count()) {
              await target.first().waitFor({ state: 'visible', timeout: Math.max(1, deadline - Date.now()) });
              return { ok: true };
            }
          }
          await page.waitForTimeout(100);
        }
        return { ok: false };
      }`);
      if (!result.ok) throw new BrowserError("BROWSER_WAIT_TIMEOUT", `等待元素超时：${options.value}`);
      return;
    }
    if (options.kind === "text") {
      if (!options.value) throw new BrowserError("BROWSER_WAIT_VALUE", "等待文字时必须提供文字");
      const result = await this.runJson<{ ok?: boolean }>(`async (page) => {
        const deadline = Date.now() + ${Math.max(1, options.timeoutMs)};
        while (Date.now() < deadline) {
          for (const frame of page.frames()) {
            const found = await frame.evaluate((value) => (document.body?.innerText ?? '').includes(value), ${JSON.stringify(options.value)}).catch(() => false);
            if (found) return { ok: true };
          }
          await page.waitForTimeout(100);
        }
        return { ok: false };
      }`);
      if (!result.ok) throw new BrowserError("BROWSER_WAIT_TIMEOUT", `等待文字超时：${options.value}`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(1_500, options.timeoutMs)));
  }

  async select(ref: string, values: string[], timeoutMs: number): Promise<void> {
    await this.selectBrowserTab();
    await this.runAction(extensionLocateCode(ref, `await item.selectOption(${JSON.stringify(values)}, { timeout: ${Math.max(1, timeoutMs)} });`));
  }

  async drag(startRef: string, endRef: string, timeoutMs: number): Promise<void> {
    await this.selectBrowserTab();
    await this.runAction(`async (page) => {
      const find = async (ref) => {
        for (const frame of page.frames()) {
          const target = frame.locator('[data-hearth-ref="' + ref + '"]');
          if (await target.count()) return target.first();
        }
        return null;
      };
      const start = await find(${JSON.stringify(startRef)});
      const end = await find(${JSON.stringify(endRef)});
      if (!start || !end) return { ok: false, error: 'BROWSER_ELEMENT_MISSING' };
      await start.dragTo(end, { timeout: ${Math.max(1, timeoutMs)} });
      return { ok: true };
    }`);
  }

  async clickAt(x: number, y: number, options: BrowserPointerOptions = {}): Promise<void> {
    await this.selectBrowserTab();
    const result = await this.connection.call("browser_mouse_click_xy", {
      x,
      y,
      ...(options.button ? { button: options.button } : {}),
      ...(options.clickCount ? { clickCount: options.clickCount } : {})
    });
    assertToolOk(result, `无法在坐标 ${x},${y} 点击`);
  }

  async typeAt(x: number, y: number, text: string): Promise<void> {
    await this.selectBrowserTab();
    const result = await this.runJson<{ ok?: boolean }>(`async (page) => {
      await page.mouse.click(${x}, ${y});
      await page.keyboard.insertText(${JSON.stringify(text)});
      return { ok: true };
    }`, 45_000, [text]);
    if (!result.ok) throw new BrowserError("BROWSER_TYPE_AT_FAILED", "坐标输入失败");
  }

  async scroll(deltaX: number, deltaY: number): Promise<void> {
    await this.selectBrowserTab();
    const result = await this.connection.call("browser_mouse_wheel", { deltaX, deltaY });
    assertToolOk(result, "页面滚动失败");
  }

  async upload(ref: string, path: string, timeoutMs: number): Promise<void> {
    await this.selectBrowserTab();
    await this.runAction(extensionLocateCode(ref, `await item.setInputFiles(${JSON.stringify(path)}, { timeout: ${Math.max(1, timeoutMs)} });`));
  }

  async download(ref: string, timeoutMs: number): Promise<{ data: Buffer; suggestedName: string }> {
    await this.selectBrowserTab();
    const result = await this.runJson<{ ok?: boolean; base64?: string; name?: string; error?: string }>(`async (page) => {
      for (const frame of page.frames()) {
        const target = frame.locator('[data-hearth-ref="${cssEscape(ref)}"]');
        if (!(await target.count())) continue;
        const promise = page.waitForEvent('download', { timeout: ${Math.max(1, timeoutMs)} });
        await target.first().click({ timeout: ${Math.max(1, timeoutMs)} });
        const download = await promise;
        const downloadPath = await download.path();
        if (!downloadPath) return { ok: false, error: 'BROWSER_DOWNLOAD_FAILED' };
        const fs = await import('node:fs/promises');
        const bytes = await fs.readFile(downloadPath);
        return { ok: true, base64: bytes.toString('base64'), name: download.suggestedFilename() };
      }
      return { ok: false, error: 'BROWSER_ELEMENT_MISSING' };
    }`, timeoutMs + 5_000);
    if (!result.ok || !result.base64) throw new BrowserError(result.error ?? "BROWSER_DOWNLOAD_FAILED", "浏览器下载失败");
    return { data: Buffer.from(result.base64, "base64"), suggestedName: result.name ?? `download-${Date.now()}` };
  }

  async execute(code: string): Promise<unknown> {
    await this.selectBrowserTab();
    return this.runJson(code);
  }

  tabIndexValue(): number {
    return this.tabIndex;
  }

  shiftIndex(): void {
    this.tabIndex = Math.max(0, this.tabIndex - 1);
  }
  private async selectBrowserTab(): Promise<void> {
    await this.connection.select(this.tabIndex);
  }


  private async runAction(code: string, secrets: Iterable<string> = []): Promise<void> {
    const result = await this.runJson<{ ok?: boolean; error?: string }>(code, 45_000, secrets);
    if (!result.ok) {
      throw new BrowserError(
        "BROWSER_ACTION_FAILED",
        redactKnownSecrets(result.error ?? "扩展浏览器动作失败", secrets)
      );
    }
  }

  private async runJson<T>(code: string, timeoutMs = 45_000, secrets: Iterable<string> = []): Promise<T> {
    try {
      const result = await this.connection.call("browser_run_code_unsafe", { code }, timeoutMs);
      assertToolOk(result, "扩展浏览器执行失败", secrets);
      failIfToolError(result, secrets);
      return parseJsonResult<T>(result, secrets);
    } catch (error) {
      throw redactExtensionError(error, secrets);
    }
  }
}

function readToken(path: string): string | null {
  try {
    return readFileSync(path, "utf8").trim() || null;
  } catch {
    return null;
  }
}

function textFrom(result: McpResult): string {
  return (result.content ?? []).filter((item) => item.type === "text").map((item) => item.text ?? "").join("\n").trim();
}

function assertToolOk(result: McpResult, message: string, secrets: Iterable<string> = []): void {
  if (result.isError) {
    const detail = redactKnownSecrets(textFrom(result) || "未知错误", secrets);
    throw new BrowserError("BROWSER_EXTENSION_UNAVAILABLE", `${message}：${detail}`);
  }
}

function failIfToolError(result: McpResult, secrets: Iterable<string> = []): void {
  const text = redactKnownSecrets(textFrom(result), secrets);
  if (/^error\b/i.test(text) || /\nError:/.test(text)) {
    throw new BrowserError("BROWSER_EXTENSION_ACTION_FAILED", text.slice(0, 1_200));
  }
}

export interface ExtensionTabSummary {
  index: number;
  current: boolean;
  title: string;
  url: string;
}

/** Parse the stable markdown produced by Playwright MCP's browser_tabs tool. */
export function parseTabsMarkdown(markdown: string): ExtensionTabSummary[] {
  const tabs: ExtensionTabSummary[] = [];
  for (const line of markdown.replace(/\r/g, "").split("\n")) {
    const match = /^\s*-\s*(\d+):\s*(\(current\))?\s*\[(.*?)\]\((.*?)\)/.exec(line);
    if (!match?.[1]) continue;
    tabs.push({
      index: Number(match[1]),
      current: Boolean(match[2]),
      title: match[3] ?? "",
      url: match[4] ?? ""
    });
  }
  return tabs;
}

export function parseJsonResult<T>(result: McpResult, secrets: Iterable<string> = []): T {
  if (result.structuredContent !== undefined) {
    if (result.structuredContent && typeof result.structuredContent === "object" && "result" in result.structuredContent) {
      return (result.structuredContent as { result: T }).result;
    }
    return result.structuredContent as T;
  }
  const text = textFrom(result);
  const resultBody = labelledSection(text, "Result") ?? text;
  const json = firstBalancedJson(resultBody);
  if (json) {
    try {
      return JSON.parse(json) as T;
    } catch {
      // Fall through to the readable error below.
    }
  }
  const detail = redactKnownSecrets(text, secrets).slice(0, 1_000);
  throw new BrowserError("BROWSER_EXTENSION_RESULT", `无法解析扩展浏览器返回：${detail}`);
}

function redactExtensionError(error: unknown, secrets: Iterable<string>): BrowserError {
  if (error instanceof BrowserError) {
    return new BrowserError(error.code, redactKnownSecrets(error.message, secrets));
  }
  return new BrowserError(
    "BROWSER_EXTENSION_ACTION_FAILED",
    redactKnownSecrets(error instanceof Error ? error.message : String(error), secrets)
  );
}

function labelledSection(text: string, name: string): string | null {
  const marker = `### ${name}`;
  const start = text.indexOf(marker);
  if (start < 0) return null;
  const bodyStart = text.indexOf("\n", start);
  if (bodyStart < 0) return "";
  const next = text.indexOf("\n### ", bodyStart + 1);
  return text.slice(bodyStart + 1, next < 0 ? undefined : next).trim();
}

function firstBalancedJson(text: string): string | null {
  const start = text.search(/[\[{]/);
  if (start < 0) return null;
  const opening = text[start];
  const closing = opening === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === opening) depth += 1;
    if (char === closing) {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
