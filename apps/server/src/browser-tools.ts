import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import type { AgentTool, AgentToolContext, AgentToolResult } from "@hearth/agent-runtime";
import type { BrowserSessionManager, BrowserRecipeStep, BrowserSessionState } from "./browser-session.ts";
import { captureBrowserSnapshot, type BrowserSnapshot } from "./browser-snapshot.ts";
import { BrowserError } from "./browser-service.ts";
import { BrowserEvidenceStore, type BrowserEvidenceRecord } from "./browser-evidence.ts";
import { matchesAny, type BrowserSettings } from "./browser-settings.ts";

export interface BrowserToolsOptions {
  taskId: string;
  runId: string | null;
  sessions: BrowserSessionManager;
  evidence: BrowserEvidenceStore;
  settings: BrowserSettings;
  recipesDir: string;
  onEvent?: ((type: string, payload: Record<string, unknown>) => void) | undefined;
}

const MAX_READ_CHARS = 12_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const DANGEROUS_ACTIONS = /(^|\b)(submit|send|pay|purchase|delete|remove|confirm|提交|发送|支付|付款|购买|删除|确认|下单)(\b|$)/i;

export function createBrowserTools(options: BrowserToolsOptions): AgentTool[] {
  const toolkit = new BrowserToolkit(options);
  return [
    toolkit.tool("browser_open", "打开网页", "打开一个 http/https 网页，并返回可交互元素清单。新域名会先请求审批。", {
      type: "object",
      properties: {
        url: { type: "string", description: "要打开的网址" },
        newTab: { type: "boolean", description: "是否在新标签页打开，默认复用当前标签" }
      },
      required: ["url"],
      additionalProperties: false
    }, async (args, context) => toolkit.open(args, context)),
    toolkit.tool("browser_read", "读取当前网页", "读取当前页面的标题、网址、可交互元素和正文摘要。元素使用 e1、e2 这样的短 ID。", {
      type: "object",
      properties: { maxChars: { type: "number", description: "正文最多返回多少字符，默认 12000" } },
      additionalProperties: false
    }, async (args) => toolkit.read(args)),
    toolkit.tool("browser_click", "点击网页元素", "点击快照里的元素 ID。提交、支付、删除、发送类按钮会被拒绝，必须改用 browser_submit。", {
      type: "object",
      properties: { ref: { type: "string", description: "元素 ID，例如 e3" } },
      required: ["ref"],
      additionalProperties: false
    }, async (args) => toolkit.click(args)),
    toolkit.tool("browser_type", "在网页输入文字", "向快照里的输入框写入文字。密码框会被拒绝。", {
      type: "object",
      properties: {
        ref: { type: "string", description: "输入框元素 ID" },
        text: { type: "string", description: "要输入的文字" },
        clear: { type: "boolean", description: "是否先清空，默认 true" }
      },
      required: ["ref", "text"],
      additionalProperties: false
    }, async (args) => toolkit.type(args)),
    toolkit.tool("browser_key", "按下键盘按键", "向当前焦点发送按键，例如 Enter、Escape、Tab。", {
      type: "object",
      properties: { key: { type: "string", description: "Playwright 按键名，例如 Enter" } },
      required: ["key"],
      additionalProperties: false
    }, async (args) => toolkit.key(args)),
    toolkit.tool("browser_wait", "等待网页变化", "等待元素出现、正文包含文字，或页面空闲。", {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["element", "text", "idle"], description: "等待类型" },
        value: { type: "string", description: "元素 ID 或要等待的文字；idle 可省略" },
        timeoutSec: { type: "number", description: "超时秒数，默认 15" }
      },
      required: ["kind"],
      additionalProperties: false
    }, async (args) => toolkit.wait(args)),
    toolkit.tool("browser_submit", "提交网页表单", "点击提交、支付、发送或删除类按钮。每次都要审批，并留下前后截图。", {
      type: "object",
      properties: {
        ref: { type: "string", description: "提交按钮的元素 ID" },
        note: { type: "string", description: "这次提交的说明" }
      },
      additionalProperties: false
    }, async (args) => toolkit.submit(args)),
    toolkit.tool("browser_tabs", "管理网页标签页", "列出、新建、切换或关闭当前任务的标签页。", {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "new", "activate", "close"], description: "操作" },
        tabId: { type: "string", description: "目标标签页 ID" }
      },
      required: ["action"],
      additionalProperties: false
    }, async (args) => toolkit.tabs(args)),
    toolkit.tool("browser_screenshot", "截取网页画面", "保存当前网页截图到任务产物目录，返回文件路径。", {
      type: "object",
      properties: { fullPage: { type: "boolean", description: "是否截取整页，默认否" } },
      additionalProperties: false
    }, async (args, context) => toolkit.screenshot(args, context)),
    toolkit.tool("browser_upload", "上传文件到网页", "把工作区内的文件放进网页的文件选择框。必须审批，且只允许工作区路径。", {
      type: "object",
      properties: {
        ref: { type: "string", description: "文件选择框元素 ID" },
        path: { type: "string", description: "工作区内的文件路径" }
      },
      required: ["ref", "path"],
      additionalProperties: false
    }, async (args, context) => toolkit.upload(args, context)),
    toolkit.tool("browser_download", "下载网页文件", "点击下载链接，把文件保存到任务的 browser-downloads 目录。", {
      type: "object",
      properties: {
        ref: { type: "string", description: "下载链接或按钮的元素 ID" },
        fileName: { type: "string", description: "保存的文件名，可省略" }
      },
      required: ["ref"],
      additionalProperties: false
    }, async (args, context) => toolkit.download(args, context)),
    toolkit.tool("browser_assert", "验证网页状态", "验证页面包含文字、网址匹配、元素存在或元素不存在。浏览器任务结束前至少要有一条通过的断言。", {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["text", "url", "element", "no-element"], description: "断言类型" },
        value: { type: "string", description: "要验证的文字、网址片段或元素 ID" },
        timeoutSec: { type: "number", description: "超时秒数，默认 10" }
      },
      required: ["kind", "value"],
      additionalProperties: false
    }, async (args) => toolkit.assert(args)),
    toolkit.tool("browser_recipe", "保存或回放网页流程", "把当前成功流程保存成站点配方，或在同一站点回放。", {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "save", "replay", "delete"], description: "操作" },
        name: { type: "string", description: "配方名称" }
      },
      required: ["action"],
      additionalProperties: false
    }, async (args) => toolkit.recipe(args)),
    toolkit.finishTool()
  ];
}

class BrowserToolkit {
  private readonly options: BrowserToolsOptions;
  private active = false;

  constructor(options: BrowserToolsOptions) {
    this.options = options;
  }

  tool(
    name: string,
    title: string,
    description: string,
    parameters: Record<string, unknown>,
    execute: (args: Record<string, unknown>, context: AgentToolContext) => Promise<AgentToolResult>
  ): AgentTool {
    return {
      definition: {
        name,
        description: `${title}：${description}`,
        parameters,
        executionMode: "sequential",
        timeoutMs: 45_000
      },
      execute: async (input, context) => {
        this.active = true;
        try {
          return await execute(asRecord(input), context);
        } catch (error) {
          return failure(error);
        }
      }
    };
  }

  finishTool(): AgentTool {
    return {
      definition: {
        name: "finish_task",
        description: "任务真正完成时调用。summary 写给用户看的中文结果，outputs 列出已生成的产物相对路径。浏览器任务结束前必须至少有一条通过的页面断言。",
        parameters: {
          type: "object",
          properties: {
            summary: { type: "string", description: "面向用户的完成结果" },
            outputs: { type: "array", items: { type: "string" }, description: "产物文件路径列表" }
          },
          required: ["summary"],
          additionalProperties: false
        }
      },
      execute: async (input) => {
        const session = this.options.sessions.state(this.options.taskId);
        if (this.active && session) {
          const last = session.assertions[session.assertions.length - 1];
          if (!last) {
            return {
              content: "浏览器任务还不能结束：至少要用 browser_assert 验证一次页面状态，例如确认结果页出现“提交成功”。",
              isError: true
            };
          }
          if (!last.passed) {
            return {
              content: `浏览器任务还不能结束：最后一次页面断言失败（${last.kind}=${last.expected}）。请修复后重新验证。`,
              isError: true,
              metadata: { browserAssertions: session.assertions }
            };
          }
        }
        const args = asRecord(input);
        const summary = stringValue(args.summary) ?? "任务完成";
        const outputs = Array.isArray(args.outputs)
          ? args.outputs.filter((item): item is string => typeof item === "string")
          : [];
        return { content: summary, action: "finish", summary, outputs };
      }
    };
  }

  async open(args: Record<string, unknown>, context: AgentToolContext): Promise<AgentToolResult> {
    const raw = stringValue(args.url);
    if (!raw) throw new BrowserError("BROWSER_URL_REQUIRED", "缺少网址");
    const url = parseHttpUrl(raw);
    this.ensureDomain(url, "open");
    if (!this.options.settings.enabled) throw new BrowserError("BROWSER_DISABLED", "浏览器自动化已在设置中关闭。");
    const page = args.newTab ? (await this.ensurePage(true)).tab.page : (await this.ensurePage()).tab.page;
    const snapshot = await this.options.evidence.capture({
      taskId: this.options.taskId,
      runId: this.options.runId,
      kind: "open",
      page,
      pageDigest: "pending",
      actionDigest: digest({ tool: "browser_open", url: url.toString() }),
      action: async () => {
        await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT_MS });
        await page.waitForTimeout(300);
      }
    });
    this.emitEvidence(snapshot);
    this.pushStep({ tool: "browser_open", url: url.toString() });
    const next = await captureBrowserSnapshot(page);
    this.options.sessions.state(this.options.taskId)!.lastSnapshotDigest = next.digest;
    return {
      content: next.content,
      metadata: {
        browserUrl: next.url,
        browserPageDigest: next.digest,
        browserEvidence: relativeEvidence(snapshot)
      }
    };
  }

  async read(args: Record<string, unknown>): Promise<AgentToolResult> {
    const { tab } = await this.ensurePage();
    const snapshot = await captureBrowserSnapshot(tab.page);
    const max = Math.min(MAX_READ_CHARS, Math.max(1_000, Number(args.maxChars) || MAX_READ_CHARS));
    this.options.sessions.state(this.options.taskId)!.lastSnapshotDigest = snapshot.digest;
    return {
      content: snapshot.content.length > max ? `${snapshot.content.slice(0, max)}\n…（已截断）` : snapshot.content,
      metadata: { browserUrl: snapshot.url, browserPageDigest: snapshot.digest }
    };
  }

  async click(args: Record<string, unknown>): Promise<AgentToolResult> {
    const ref = elementRef(args.ref);
    const { tab, session } = await this.ensurePage();
    const page = tab.page;
    this.ensureDomain(parseHttpUrl(page.url()), "click");
    const target = page.locator(`[data-hearth-ref="${ref}"]`);
    const name = await target.innerText().catch(() => "");
    const aria = await target.getAttribute("aria-label").catch(() => null);
    if (DANGEROUS_ACTIONS.test(`${name} ${aria ?? ""}`)) {
      throw new BrowserError("BROWSER_DANGEROUS_CLICK", "这个按钮可能提交、支付、发送或删除。请改用 browser_submit，并在审批里确认。");
    }
    const before = await captureBrowserSnapshot(page);
    const evidence = await this.options.evidence.capture({
      taskId: this.options.taskId,
      runId: this.options.runId,
      kind: "click",
      page,
      pageDigest: before.digest,
      actionDigest: digest({ tool: "browser_click", ref, url: page.url() }),
      action: () => target.click({ timeout: DEFAULT_TIMEOUT_MS })
    });
    this.emitEvidence(evidence);
    this.pushStep({ tool: "browser_click", ref, ...(name ? { name } : {}) });
    await page.waitForTimeout(300);
    const after = await captureBrowserSnapshot(page);
    session.lastSnapshotDigest = after.digest;
    return {
      content: after.content,
      metadata: {
        browserUrl: after.url,
        browserPageDigest: after.digest,
        browserEvidence: relativeEvidence(evidence)
      }
    };
  }

  async type(args: Record<string, unknown>): Promise<AgentToolResult> {
    const ref = elementRef(args.ref);
    const text = typeof args.text === "string" ? args.text : null;
    if (text === null) throw new BrowserError("BROWSER_TEXT_REQUIRED", "缺少要输入的文字");
    const { tab, session } = await this.ensurePage();
    const page = tab.page;
    this.ensureDomain(parseHttpUrl(page.url()), "type");
    const target = page.locator(`[data-hearth-ref="${ref}"]`);
    const type = await target.getAttribute("type").catch(() => null);
    if (type === "password") {
      throw new BrowserError("BROWSER_PASSWORD_DENIED", "出于安全考虑，Agent 不能直接填写密码框。请由你接管浏览器完成登录。");
    }
    const before = await captureBrowserSnapshot(page);
    const evidence = await this.options.evidence.capture({
      taskId: this.options.taskId,
      runId: this.options.runId,
      kind: "type",
      page,
      pageDigest: before.digest,
      actionDigest: digest({ tool: "browser_type", ref, text }),
      action: async () => {
        if (args.clear !== false) await target.fill("", { timeout: DEFAULT_TIMEOUT_MS });
        await target.fill(text, { timeout: DEFAULT_TIMEOUT_MS });
      }
    });
    this.emitEvidence(evidence);
    this.pushStep({ tool: "browser_type", ref, text });
    await page.waitForTimeout(200);
    const after = await captureBrowserSnapshot(page);
    session.lastSnapshotDigest = after.digest;
    return {
      content: after.content,
      metadata: {
        browserUrl: after.url,
        browserPageDigest: after.digest,
        browserEvidence: relativeEvidence(evidence)
      }
    };
  }

  async key(args: Record<string, unknown>): Promise<AgentToolResult> {
    const key = stringValue(args.key);
    if (!key) throw new BrowserError("BROWSER_KEY_REQUIRED", "缺少按键名");
    const { tab, session } = await this.ensurePage();
    this.ensureDomain(parseHttpUrl(tab.page.url()), "key");
    const before = await captureBrowserSnapshot(tab.page);
    const evidence = await this.options.evidence.capture({
      taskId: this.options.taskId,
      runId: this.options.runId,
      kind: "key",
      page: tab.page,
      pageDigest: before.digest,
      actionDigest: digest({ tool: "browser_key", key }),
      action: () => tab.page.keyboard.press(key)
    });
    this.emitEvidence(evidence);
    this.pushStep({ tool: "browser_key", key });
    await tab.page.waitForTimeout(200);
    const after = await captureBrowserSnapshot(tab.page);
    session.lastSnapshotDigest = after.digest;
    return { content: after.content, metadata: { browserUrl: after.url, browserPageDigest: after.digest } };
  }

  async wait(args: Record<string, unknown>): Promise<AgentToolResult> {
    const kind = stringValue(args.kind);
    if (kind !== "element" && kind !== "text" && kind !== "idle") throw new BrowserError("BROWSER_WAIT_KIND", "等待类型不正确");
    const value = stringValue(args.value);
    const timeout = Math.min(60_000, Math.max(500, (Number(args.timeoutSec) || 15) * 1_000));
    const { tab, session } = await this.ensurePage();
    if (kind === "element") {
      if (!value) throw new BrowserError("BROWSER_WAIT_VALUE", "等待元素时必须提供元素 ID");
      await tab.page.locator(`[data-hearth-ref="${value}"]`).waitFor({ state: "visible", timeout });
    } else if (kind === "text") {
      if (!value) throw new BrowserError("BROWSER_WAIT_VALUE", "等待文字时必须提供文字");
      await tab.page.waitForFunction((text) => (document.body?.innerText ?? "").includes(text), value, { timeout });
    } else {
      await tab.page.waitForLoadState("networkidle", { timeout }).catch(() => undefined);
    }
    if (kind !== "idle") this.pushStep({ tool: "browser_wait", kind, value: value ?? "" });
    const snapshot = await captureBrowserSnapshot(tab.page);
    session.lastSnapshotDigest = snapshot.digest;
    return { content: snapshot.content, metadata: { browserUrl: snapshot.url, browserPageDigest: snapshot.digest } };
  }

  async submit(args: Record<string, unknown>): Promise<AgentToolResult> {
    const ref = args.ref === undefined ? null : elementRef(args.ref);
    const { tab, session } = await this.ensurePage();
    this.ensureDomain(parseHttpUrl(tab.page.url()), "submit", true);
    const target = ref ? tab.page.locator(`[data-hearth-ref="${ref}"]`) : tab.page.locator("button[type=submit], input[type=submit]").first();
    const before = await captureBrowserSnapshot(tab.page);
    const evidence = await this.options.evidence.capture({
      taskId: this.options.taskId,
      runId: this.options.runId,
      kind: "submit",
      page: tab.page,
      pageDigest: before.digest,
      actionDigest: digest({ tool: "browser_submit", ref, url: tab.page.url(), note: args.note }),
      action: async () => {
        await target.click({ timeout: DEFAULT_TIMEOUT_MS });
        await tab.page.waitForTimeout(500);
      }
    });
    this.emitEvidence(evidence);
    this.pushStep({ tool: "browser_click", ref: ref ?? "submit", name: "submit" });
    const after = await captureBrowserSnapshot(tab.page);
    session.lastSnapshotDigest = after.digest;
    return {
      content: after.content,
      metadata: {
        browserUrl: after.url,
        browserPageDigest: after.digest,
        browserEvidence: relativeEvidence(evidence),
        browserAssertions: session.assertions
      }
    };
  }

  async tabs(args: Record<string, unknown>): Promise<AgentToolResult> {
    const action = stringValue(args.action);
    if (action === "list") {
      const session = await this.options.sessions.session(this.options.taskId);
      return {
        content: session.tabs.map((tab) => `${tab.id === session.activeTabId ? "*" : " "} ${tab.id} ${tab.url || "(空白)"}`).join("\n"),
        metadata: { browserTabs: session.tabs.map((tab) => ({ id: tab.id, url: tab.url })) }
      };
    }
    if (action === "new") {
      const tab = await this.options.sessions.createTab(this.options.taskId);
      return { content: `已新建 ${tab.id}。用 browser_open 在当前标签打开网址。`, metadata: { browserTabId: tab.id } };
    }
    const tabId = stringValue(args.tabId);
    if (!tabId) throw new BrowserError("BROWSER_TAB_ID_REQUIRED", "需要标签页 ID");
    if (action === "activate") {
      const tab = await this.options.sessions.activateTab(this.options.taskId, tabId);
      return { content: `已切换到 ${tab.id}：${tab.page.url()}`, metadata: { browserTabId: tab.id } };
    }
    if (action === "close") {
      await this.options.sessions.closeTab(this.options.taskId, tabId);
      return { content: `已关闭 ${tabId}` };
    }
    throw new BrowserError("BROWSER_TABS_ACTION", "标签页操作不正确");
  }

  async screenshot(args: Record<string, unknown>, context: AgentToolContext): Promise<AgentToolResult> {
    const { tab } = await this.ensurePage();
    const dir = join(context.outDir, "browser-screenshots");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `page-${Date.now()}.png`);
    await tab.page.screenshot({ path, fullPage: args.fullPage === true });
    return {
      content: `已保存网页截图：${relative(context.workspaceRoot, path).replaceAll("\\", "/")}`,
      metadata: { browserScreenshot: path }
    };
  }

  async upload(args: Record<string, unknown>, context: AgentToolContext): Promise<AgentToolResult> {
    const ref = elementRef(args.ref);
    const raw = stringValue(args.path);
    if (!raw) throw new BrowserError("BROWSER_UPLOAD_PATH", "缺少上传文件路径");
    const path = isAbsolute(raw) ? resolve(raw) : resolve(context.workspaceRoot, raw);
    if (!insideRoot(context.workspaceRoot, path)) throw new BrowserError("BROWSER_UPLOAD_OUTSIDE", "只能上传工作区内的文件。");
    if (!existsSync(path) || !statSync(path).isFile()) throw new BrowserError("BROWSER_UPLOAD_MISSING", `文件不存在：${raw}`);
    const { tab, session } = await this.ensurePage();
    this.ensureDomain(parseHttpUrl(tab.page.url()), "upload", true);
    const target = tab.page.locator(`[data-hearth-ref="${ref}"]`);
    const before = await captureBrowserSnapshot(tab.page);
    const evidence = await this.options.evidence.capture({
      taskId: this.options.taskId,
      runId: this.options.runId,
      kind: "upload",
      page: tab.page,
      pageDigest: before.digest,
      actionDigest: digest({ tool: "browser_upload", ref, file: basename(path) }),
      action: () => target.setInputFiles(path)
    });
    this.emitEvidence(evidence);
    const after = await captureBrowserSnapshot(tab.page);
    session.lastSnapshotDigest = after.digest;
    return { content: after.content, metadata: { browserUrl: after.url, browserPageDigest: after.digest } };
  }

  async download(args: Record<string, unknown>, context: AgentToolContext): Promise<AgentToolResult> {
    const ref = elementRef(args.ref);
    const { tab } = await this.ensurePage();
    const target = tab.page.locator(`[data-hearth-ref="${ref}"]`);
    const dir = join(context.outDir, "browser-downloads");
    mkdirSync(dir, { recursive: true });
    const downloadPromise = tab.page.waitForEvent("download", { timeout: DEFAULT_TIMEOUT_MS });
    await target.click({ timeout: DEFAULT_TIMEOUT_MS });
    const download = await downloadPromise;
    const suggested = safeFileName(stringValue(args.fileName) ?? download.suggestedFilename() ?? `download-${Date.now()}`);
    const path = uniquePath(dir, suggested);
    await download.saveAs(path);
    return {
      content: `已下载到 ${relative(context.workspaceRoot, path).replaceAll("\\", "/")}（${download.suggestedFilename()}）`,
      metadata: { browserDownload: path }
    };
  }

  async assert(args: Record<string, unknown>): Promise<AgentToolResult> {
    const kind = stringValue(args.kind);
    const value = stringValue(args.value);
    if (!value || (kind !== "text" && kind !== "url" && kind !== "element" && kind !== "no-element")) {
      throw new BrowserError("BROWSER_ASSERT_INPUT", "断言类型或值不正确");
    }
    const timeout = Math.min(60_000, Math.max(500, (Number(args.timeoutSec) || 10) * 1_000));
    const { tab, session } = await this.ensurePage();
    let passed = false;
    let actual = "";
    try {
      if (kind === "text") {
        await tab.page.waitForFunction((text) => (document.body?.innerText ?? "").includes(text), value, { timeout });
        actual = "正文包含目标文字";
        passed = true;
      } else if (kind === "url") {
        await tab.page.waitForFunction((part) => location.href.includes(part), value, { timeout });
        actual = tab.page.url();
        passed = true;
      } else if (kind === "element") {
        await tab.page.locator(`[data-hearth-ref="${value}"]`).waitFor({ state: "visible", timeout });
        actual = `元素 ${value} 可见`;
        passed = true;
      } else {
        await tab.page.waitForFunction((ref) => !document.querySelector(`[data-hearth-ref="${ref}"]`), value, { timeout });
        actual = `元素 ${value} 不存在`;
        passed = true;
      }
    } catch {
      actual = kind === "text"
        ? (await tab.page.locator("body").innerText().catch(() => "")).slice(0, 300)
        : tab.page.url();
    }
    const assertion = { kind, expected: value, passed, ...(passed ? {} : { actual }) };
    session.assertions.push(assertion);
    this.pushStep({ tool: "browser_assert", kind: kind as "text" | "url" | "element" | "no-element", value });
    return {
      content: passed
        ? `断言通过：${assertionLabel(kind, value)}`
        : `断言失败：${assertionLabel(kind, value)}。当前页面：${actual.slice(0, 300)}`,
      isError: !passed,
      metadata: { browserAssertions: session.assertions }
    };
  }

  async recipe(args: Record<string, unknown>): Promise<AgentToolResult> {
    const action = stringValue(args.action);
    const name = stringValue(args.name);
    if (action === "list") {
      const recipes = listRecipes(this.options.recipesDir);
      return { content: recipes.length > 0 ? recipes.map((recipe) => `- ${recipe.name} (${recipe.domain})`).join("\n") : "还没有保存过网页配方。" };
    }
    if (!name) throw new BrowserError("BROWSER_RECIPE_NAME", "需要配方名称");
    if (action === "save") {
      const session = await this.options.sessions.session(this.options.taskId);
      const active = this.options.sessions.activeTab(this.options.taskId);
      if (!active) throw new BrowserError("BROWSER_RECIPE_EMPTY", "当前任务没有网页流程可以保存。");
      const domain = new URL(active.page.url()).hostname;
      const file = join(this.options.recipesDir, `${safeSlug(domain)}-${safeSlug(name)}.json`);
      mkdirSync(this.options.recipesDir, { recursive: true });
      writeFileSync(file, JSON.stringify({ name, domain, steps: session.steps, createdAt: new Date().toISOString() }, null, 2), "utf8");
      return { content: `已保存网页配方：${name}（${session.steps.length} 步）` };
    }
    const recipe = findRecipe(this.options.recipesDir, name);
    if (!recipe) throw new BrowserError("BROWSER_RECIPE_MISSING", `找不到配方：${name}`);
    if (action === "delete") {
      rmSync(recipe.path, { force: true });
      return { content: `已删除网页配方：${recipe.name}` };
    }
    if (action !== "replay") throw new BrowserError("BROWSER_RECIPE_ACTION", "配方操作不正确");
    for (const step of recipe.steps) await this.replayStep(step);
    const snapshot = await this.snapshotCurrent();
    return { content: `已回放 ${recipe.steps.length} 步。\n\n${snapshot.content}`, metadata: { browserPageDigest: snapshot.digest } };
  }

  private async replayStep(step: BrowserRecipeStep): Promise<void> {
    switch (step.tool) {
      case "browser_open":
        await this.open({ url: step.url }, fakeContext());
        break;
      case "browser_click":
        await this.click({ ref: step.ref });
        break;
      case "browser_type":
        await this.type({ ref: step.ref, text: step.text });
        break;
      case "browser_key":
        await this.key({ key: step.key });
        break;
      case "browser_wait":
        await this.wait({ kind: step.kind, value: step.value, ...(step.timeoutMs ? { timeoutSec: step.timeoutMs / 1_000 } : {}) });
        break;
      case "browser_assert":
        await this.assert({ kind: step.kind, value: step.value });
        break;
    }
  }

  private async ensurePage(newTab = false): Promise<{ session: BrowserSessionState; tab: { id: string; page: import("playwright-core").Page; url: string } }> {
    if (newTab) await this.options.sessions.createTab(this.options.taskId);
    return this.options.sessions.activePage(this.options.taskId);
  }

  private ensureDomain(url: URL, action: string, allowHighRisk = false): void {
    const host = url.hostname;
    if (!this.options.settings.enabled) throw new BrowserError("BROWSER_DISABLED", "浏览器自动化已在设置中关闭。");
    const readOnly = matchesAny(host, this.options.settings.readOnlyDomains);
    if (readOnly && action !== "open" && action !== "read") {
      throw new BrowserError("BROWSER_READ_ONLY_SITE", `${host} 被设为只读站点，不能执行 ${action}。`);
    }
    const highRisk = matchesAny(host, this.options.settings.highRiskDomains);
    if (highRisk && !allowHighRisk && action !== "open" && action !== "read" && action !== "assert") {
      throw new BrowserError("BROWSER_HIGH_RISK_SITE", `${host} 被设为高风险站点，只能读取；写入或提交必须由你人工确认。`);
    }
    if (this.options.settings.allowedDomains.length > 0 && !matchesAny(host, this.options.settings.allowedDomains) && !highRisk) {
      throw new BrowserError("BROWSER_DOMAIN_DENIED", `域名 ${host} 不在允许列表里。请先在浏览器设置里添加，或在审批卡片里允许该域名。`);
    }
  }

  private pushStep(step: BrowserRecipeStep): void {
    const session = this.options.sessions.state(this.options.taskId);
    if (session) session.steps.push(step);
  }

  private emitEvidence(record: BrowserEvidenceRecord): void {
    this.options.onEvent?.("browser.evidence", {
      kind: record.kind,
      url: record.url,
      pageDigest: record.pageDigest,
      actionDigest: record.actionDigest,
      screenshotBefore: record.screenshotBefore,
      screenshotAfter: record.screenshotAfter
    });
  }

  private async snapshotCurrent(): Promise<BrowserSnapshot> {
    const { tab, session } = await this.ensurePage();
    const snapshot = await captureBrowserSnapshot(tab.page);
    session.lastSnapshotDigest = snapshot.digest;
    return snapshot;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function elementRef(value: unknown): string {
  const ref = stringValue(value);
  if (!ref || !/^e\d+$/.test(ref)) throw new BrowserError("BROWSER_ELEMENT_REF", "元素 ID 必须像 e1、e2 这样。请先 browser_read 刷新页面。");
  return ref;
}

function parseHttpUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BrowserError("BROWSER_URL_INVALID", `网址格式不正确：${value}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BrowserError("BROWSER_SCHEME_DENIED", "浏览器只允许 http 或 https 网址。");
  }
  return url;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

function assertionLabel(kind: string, value: string): string {
  if (kind === "text") return `页面包含「${value}」`;
  if (kind === "url") return `网址包含「${value}」`;
  if (kind === "element") return `元素 ${value} 存在`;
  return `元素 ${value} 不存在`;
}

function insideRoot(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function relativeEvidence(record: BrowserEvidenceRecord): Record<string, string | null> {
  return { before: record.screenshotBefore, after: record.screenshotAfter };
}

function safeFileName(name: string): string {
  const base = basename(name).replace(/[^a-zA-Z0-9._-]/g, "_");
  return base || `download-${Date.now()}`;
}

function uniquePath(dir: string, name: string): string {
  const extension = extname(name);
  const stem = extension ? name.slice(0, -extension.length) : name;
  let path = join(dir, name);
  let index = 1;
  while (existsSync(path)) {
    path = join(dir, `${stem}-${index}${extension}`);
    index += 1;
  }
  return path;
}

function safeSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "recipe";
}

function listRecipes(dir: string): Array<{ name: string; domain: string; path: string }> {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .flatMap((name) => {
      try {
        const raw = JSON.parse(readFileSync(join(dir, name), "utf8")) as { name?: string; domain?: string };
        return [{ name: raw.name ?? name, domain: raw.domain ?? "", path: join(dir, name) }];
      } catch {
        return [];
      }
    });
}

function findRecipe(dir: string, name: string): { name: string; domain: string; steps: BrowserRecipeStep[]; path: string } | null {
  const match = listRecipes(dir).find((recipe) => recipe.name === name);
  if (!match) return null;
  try {
    const raw = JSON.parse(readFileSync(match.path, "utf8")) as { name?: string; domain?: string; steps?: BrowserRecipeStep[] };
    return { name: raw.name ?? name, domain: raw.domain ?? "", steps: raw.steps ?? [], path: match.path };
  } catch {
    return null;
  }
}

function failure(error: unknown): AgentToolResult {
  const code = error instanceof BrowserError ? error.code : null;
  return {
    content: `${code ? `[${code}] ` : ""}${error instanceof Error ? error.message : String(error)}`,
    isError: true
  };
}

function fakeContext(): AgentToolContext {
  return { workspaceRoot: process.cwd(), outDir: process.cwd(), permissions: { readRoots: [], writeRoots: [], networkHosts: [], tools: [] }, signal: new AbortController().signal };
}
