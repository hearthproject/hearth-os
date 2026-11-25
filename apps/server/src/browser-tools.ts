import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import type { AgentTool, AgentToolContext, AgentToolResult } from "@hearth/agent-runtime";
import { takeoverLabel, type BrowserRecipeStep, type BrowserSessionManager, type BrowserTakeoverKind } from "./browser-session.ts";
import type { BrowserSnapshot } from "./browser-snapshot.ts";
import { BrowserError } from "./browser-service.ts";
import { BrowserEvidenceStore, type BrowserEvidenceRecord } from "./browser-evidence.ts";

export interface BrowserToolsOptions {
  taskId: string;
  runId: string | null;
  sessions: BrowserSessionManager;
  evidence: BrowserEvidenceStore;
  recipesDir: string;
  onEvent?: ((type: string, payload: Record<string, unknown>) => void) | undefined;
}

const MAX_READ_CHARS = 16_000;
const DEFAULT_TIMEOUT_MS = 45_000;
const TAKEOVER_KINDS = new Set<BrowserTakeoverKind>(["login", "captcha", "payment_confirmation", "complex_interaction", "other"]);

export function createBrowserTools(options: BrowserToolsOptions): AgentTool[] {
  const toolkit = new BrowserToolkit(options);
  return [
    toolkit.tool("browser_open", "打开网页", "打开任意 http/https 网页并返回页面元素。新标签页可显式指定。", {
      type: "object", properties: { url: { type: "string", description: "要打开的网址" }, newTab: { type: "boolean", description: "是否在新标签页打开" } },
      required: ["url"], additionalProperties: false
    }, async (args, context) => toolkit.open(args, context)),
    toolkit.tool("browser_read", "读取当前网页", "重新观察所有 frame、开放 Shadow DOM、正文和可交互元素。控制权切换后必须先调用。", {
      type: "object", properties: { maxChars: { type: "number" } }, additionalProperties: false
    }, async (args) => toolkit.read(args)),
    toolkit.tool("browser_click", "点击网页元素", "点击当前快照中的元素 ID。登录、验证码、支付最终确认和复杂交互应请求用户接管。", {
      type: "object", properties: { ref: { type: "string" }, button: { type: "string", enum: ["left", "right", "middle"] }, clickCount: { type: "number" } },
      required: ["ref"], additionalProperties: false
    }, async (args) => toolkit.click(args)),
    toolkit.tool("browser_hover", "悬停网页元素", "把鼠标移到快照元素上。", {
      type: "object", properties: { ref: { type: "string" } }, required: ["ref"], additionalProperties: false
    }, async (args) => toolkit.hover(args)),
    toolkit.tool("browser_type", "在网页输入文字", "向快照输入框写入文字，包括密码框。密码不会出现在快照、配方或日志中。", {
      type: "object", properties: { ref: { type: "string" }, text: { type: "string" }, clear: { type: "boolean" } },
      required: ["ref", "text"], additionalProperties: false
    }, async (args) => toolkit.type(args)),
    toolkit.tool("browser_key", "按下键盘按键", "向当前焦点发送按键，例如 Enter、Escape、Tab。", {
      type: "object", properties: { key: { type: "string" } }, required: ["key"], additionalProperties: false
    }, async (args) => toolkit.key(args)),
    toolkit.tool("browser_wait", "等待网页变化", "等待元素出现、正文包含文字或网络空闲。", {
      type: "object", properties: { kind: { type: "string", enum: ["element", "text", "idle"] }, value: { type: "string" }, timeoutSec: { type: "number" } },
      required: ["kind"], additionalProperties: false
    }, async (args) => toolkit.wait(args)),
    toolkit.tool("browser_submit", "提交网页表单", "点击当前快照中的提交按钮。支付最终确认需先请求用户接管。", {
      type: "object", properties: { ref: { type: "string" }, note: { type: "string" } }, required: ["ref"], additionalProperties: false
    }, async (args) => toolkit.submit(args)),
    toolkit.tool("browser_select", "选择下拉选项", "在 select 或组合框中选择一个或多个值。", {
      type: "object", properties: { ref: { type: "string" }, values: { type: "array", items: { type: "string" } } },
      required: ["ref", "values"], additionalProperties: false
    }, async (args) => toolkit.select(args)),
    toolkit.tool("browser_drag", "拖拽网页元素", "把一个快照元素拖到另一个快照元素。", {
      type: "object", properties: { startRef: { type: "string" }, endRef: { type: "string" } },
      required: ["startRef", "endRef"], additionalProperties: false
    }, async (args) => toolkit.drag(args)),
    toolkit.tool("browser_click_at", "按坐标点击", "在页面视口坐标点击，适用于 Canvas、地图和截图类界面。", {
      type: "object", properties: { x: { type: "number" }, y: { type: "number" }, button: { type: "string", enum: ["left", "right", "middle"] }, clickCount: { type: "number" } },
      required: ["x", "y"], additionalProperties: false
    }, async (args) => toolkit.clickAt(args)),
    toolkit.tool("browser_type_at", "按坐标点击并输入", "先点击页面坐标，再向当前焦点输入文字。", {
      type: "object", properties: { x: { type: "number" }, y: { type: "number" }, text: { type: "string" } },
      required: ["x", "y", "text"], additionalProperties: false
    }, async (args) => toolkit.typeAt(args)),
    toolkit.tool("browser_scroll", "滚动网页", "滚动当前页面。", {
      type: "object", properties: { deltaX: { type: "number" }, deltaY: { type: "number" } }, additionalProperties: false
    }, async (args) => toolkit.scroll(args)),
    toolkit.tool("browser_tabs", "管理网页标签页", "列出、新建、切换或关闭当前任务的标签页。", {
      type: "object", properties: { action: { type: "string", enum: ["list", "new", "activate", "close"] }, tabId: { type: "string" }, url: { type: "string" } },
      required: ["action"], additionalProperties: false
    }, async (args) => toolkit.tabs(args)),
    toolkit.tool("browser_screenshot", "截取网页画面", "保存当前网页截图到任务产物目录。", {
      type: "object", properties: { fullPage: { type: "boolean" } }, additionalProperties: false
    }, async (args, context) => toolkit.screenshot(args, context)),
    toolkit.tool("browser_upload", "上传文件到网页", "把工作区内的文件放进网页文件选择框。", {
      type: "object", properties: { ref: { type: "string" }, path: { type: "string" } }, required: ["ref", "path"], additionalProperties: false
    }, async (args, context) => toolkit.upload(args, context)),
    toolkit.tool("browser_download", "下载网页文件", "点击下载链接并保存到任务目录。", {
      type: "object", properties: { ref: { type: "string" }, fileName: { type: "string" } }, required: ["ref"], additionalProperties: false
    }, async (args, context) => toolkit.download(args, context)),
    toolkit.tool("browser_assert", "验证网页状态", "可选地验证文字、网址或元素状态。浏览器任务不再强制要求断言。", {
      type: "object", properties: { kind: { type: "string", enum: ["text", "url", "element", "no-element"] }, value: { type: "string" }, timeoutSec: { type: "number" } },
      required: ["kind", "value"], additionalProperties: false
    }, async (args) => toolkit.assert(args)),
    toolkit.tool("browser_request_takeover", "请求用户接管浏览器", "登录、验证码、支付最终确认或复杂交互时调用。浏览器会置前并等待用户。", {
      type: "object", properties: { kind: { type: "string", enum: ["login", "captcha", "payment_confirmation", "complex_interaction", "other"] }, reason: { type: "string" } },
      required: ["kind", "reason"], additionalProperties: false
    }, async (args) => toolkit.requestTakeover(args)),
    toolkit.tool("browser_recipe", "保存或回放网页流程", "把当前流程保存成站点配方，或回放已有配方。", {
      type: "object", properties: { action: { type: "string", enum: ["list", "save", "replay", "delete"] }, name: { type: "string" } },
      required: ["action"], additionalProperties: false
    }, async (args) => toolkit.recipe(args))
  ];
}

class BrowserToolkit {
  private readonly options: BrowserToolsOptions;

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
      definition: { name, description: `${title}：${description}`, parameters, executionMode: "sequential", timeoutMs: 60_000 },
      execute: async (input, context) => {
        try {
          return await execute(asRecord(input), context);
        } catch (error) {
          return failure(error);
        }
      }
    };
  }

  async open(args: Record<string, unknown>, _context: AgentToolContext): Promise<AgentToolResult> {
    const raw = stringValue(args.url);
    if (!raw) throw new BrowserError("BROWSER_URL_REQUIRED", "缺少网址");
    const url = parseHttpUrl(raw).toString();
    let tab;
    let session;
    if (args.newTab) {
      session = await this.options.sessions.session(this.options.taskId);
      tab = await this.options.sessions.createTab(this.options.taskId);
    } else {
      ({ session, tab } = await this.options.sessions.activePage(this.options.taskId, { allowObservation: true }));
    }
    const evidence = await this.options.evidence.capture({
      taskId: this.options.taskId, runId: this.options.runId, kind: "open", page: tab.page,
      pageDigest: session.lastSnapshotDigest ?? "pending", actionDigest: digest({ tool: "browser_open", url }),
      action: () => tab.page.goto(url, DEFAULT_TIMEOUT_MS)
    });
    this.emitEvidence(evidence);
    this.pushStep({ tool: "browser_open", url });
    return this.afterAction("网页已打开。", evidence);
  }

  async read(args: Record<string, unknown>): Promise<AgentToolResult> {
    const snapshot = await this.options.sessions.snapshot(this.options.taskId);
    const max = Math.min(MAX_READ_CHARS, Math.max(1_000, Number(args.maxChars) || MAX_READ_CHARS));
    return {
      content: snapshot.content.length > max ? `${snapshot.content.slice(0, max)}\n…（已截断）` : snapshot.content,
      metadata: this.snapshotMetadata(snapshot)
    };
  }

  async click(args: Record<string, unknown>): Promise<AgentToolResult> {
    const ref = elementRef(args.ref);
    const { session, tab } = await this.options.sessions.activePage(this.options.taskId);
    const before = await this.options.sessions.snapshot(this.options.taskId);
    const evidence = await this.options.evidence.capture({
      taskId: this.options.taskId, runId: this.options.runId, kind: "click", page: tab.page,
      pageDigest: before.digest, actionDigest: digest({ tool: "browser_click", ref }),
      action: () => tab.page.click(ref, DEFAULT_TIMEOUT_MS, {
        ...(stringValue(args.button) ? { button: stringValue(args.button) as "left" | "right" | "middle" } : {}),
        ...(Number(args.clickCount) > 0 ? { clickCount: Number(args.clickCount) } : {})
      })
    });
    session.lastSnapshotDigest = before.digest;
    this.pushStep({ tool: "browser_click", ref });
    return this.afterAction(`已点击 ${ref}。`, evidence);
  }

  async hover(args: Record<string, unknown>): Promise<AgentToolResult> {
    const ref = elementRef(args.ref);
    const { tab } = await this.options.sessions.activePage(this.options.taskId);
    await tab.page.hover(ref, DEFAULT_TIMEOUT_MS);
    this.pushStep({ tool: "browser_hover", ref });
    return this.afterAction(`已悬停 ${ref}。`, null);
  }

  async type(args: Record<string, unknown>): Promise<AgentToolResult> {
    const ref = elementRef(args.ref);
    const text = typeof args.text === "string" ? args.text : null;
    if (text === null) throw new BrowserError("BROWSER_TEXT_REQUIRED", "缺少要输入的文字");
    const { tab } = await this.options.sessions.activePage(this.options.taskId);
    const before = await this.options.sessions.snapshot(this.options.taskId);
    const evidence = await this.options.evidence.capture({
      taskId: this.options.taskId, runId: this.options.runId, kind: "type", page: tab.page,
      pageDigest: before.digest, actionDigest: digest({ tool: "browser_type", ref, length: text.length }),
      action: () => tab.page.type(ref, text, args.clear !== false, DEFAULT_TIMEOUT_MS)
    });
    this.pushStep({ tool: "browser_type", ref, text: "[REDACTED]" });
    return this.afterAction(`已输入 ${ref}。`, evidence);
  }

  async key(args: Record<string, unknown>): Promise<AgentToolResult> {
    const key = stringValue(args.key);
    if (!key) throw new BrowserError("BROWSER_KEY_REQUIRED", "缺少按键名");
    const { tab } = await this.options.sessions.activePage(this.options.taskId);
    const before = await this.options.sessions.snapshot(this.options.taskId);
    const evidence = await this.options.evidence.capture({
      taskId: this.options.taskId, runId: this.options.runId, kind: "key", page: tab.page,
      pageDigest: before.digest, actionDigest: digest({ tool: "browser_key", key }),
      action: () => tab.page.key(key)
    });
    this.pushStep({ tool: "browser_key", key });
    return this.afterAction(`已按下 ${key}。`, evidence);
  }

  async wait(args: Record<string, unknown>): Promise<AgentToolResult> {
    const kind = stringValue(args.kind);
    if (kind !== "element" && kind !== "text" && kind !== "idle") throw new BrowserError("BROWSER_WAIT_KIND", "等待类型不正确");
    const value = stringValue(args.value) ?? undefined;
    const timeoutMs = Math.min(60_000, Math.max(500, (Number(args.timeoutSec) || 15) * 1_000));
    const { tab } = await this.options.sessions.activePage(this.options.taskId);
    await tab.page.wait({ kind, ...(value ? { value } : {}), timeoutMs });
    if (kind !== "idle") this.pushStep({ tool: "browser_wait", kind, value: value ?? "" });
    return this.afterAction("等待完成。", null);
  }

  async submit(args: Record<string, unknown>): Promise<AgentToolResult> {
    const ref = elementRef(args.ref);
    const { tab } = await this.options.sessions.activePage(this.options.taskId);
    const before = await this.options.sessions.snapshot(this.options.taskId);
    const evidence = await this.options.evidence.capture({
      taskId: this.options.taskId, runId: this.options.runId, kind: "submit", page: tab.page,
      pageDigest: before.digest,
      actionDigest: digest({ tool: "browser_submit", ref, note: stringValue(args.note) }),
      action: () => tab.page.click(ref, DEFAULT_TIMEOUT_MS)
    });
    this.pushStep({ tool: "browser_submit", ref, ...(stringValue(args.note) ? { note: stringValue(args.note) } : {}) });
    return this.afterAction("已提交网页表单。", evidence);
  }

  async select(args: Record<string, unknown>): Promise<AgentToolResult> {
    const ref = elementRef(args.ref);
    const values = Array.isArray(args.values) ? args.values.filter((value): value is string => typeof value === "string") : [];
    if (values.length === 0) throw new BrowserError("BROWSER_SELECT_VALUES", "请至少提供一个要选择的值");
    const { tab } = await this.options.sessions.activePage(this.options.taskId);
    await tab.page.select(ref, values, DEFAULT_TIMEOUT_MS);
    this.pushStep({ tool: "browser_select", ref, values });
    return this.afterAction(`已选择 ${values.join(", ")}。`, null);
  }

  async drag(args: Record<string, unknown>): Promise<AgentToolResult> {
    const startRef = elementRef(args.startRef);
    const endRef = elementRef(args.endRef);
    const { tab } = await this.options.sessions.activePage(this.options.taskId);
    const before = await this.options.sessions.snapshot(this.options.taskId);
    const evidence = await this.options.evidence.capture({
      taskId: this.options.taskId, runId: this.options.runId, kind: "drag", page: tab.page,
      pageDigest: before.digest, actionDigest: digest({ tool: "browser_drag", startRef, endRef }),
      action: () => tab.page.drag(startRef, endRef, DEFAULT_TIMEOUT_MS)
    });
    this.pushStep({ tool: "browser_drag", startRef, endRef });
    return this.afterAction(`已拖拽 ${startRef} 到 ${endRef}。`, evidence);
  }

  async clickAt(args: Record<string, unknown>): Promise<AgentToolResult> {
    const x = finiteNumber(args.x);
    const y = finiteNumber(args.y);
    if (x === null || y === null) throw new BrowserError("BROWSER_COORDINATE", "x 和 y 必须是有效数字");
    const { tab } = await this.options.sessions.activePage(this.options.taskId);
    const before = await this.options.sessions.snapshot(this.options.taskId);
    const evidence = await this.options.evidence.capture({
      taskId: this.options.taskId, runId: this.options.runId, kind: "click_at", page: tab.page,
      pageDigest: before.digest, actionDigest: digest({ tool: "browser_click_at", x, y }),
      action: () => tab.page.clickAt(x, y, {
        ...(stringValue(args.button) ? { button: stringValue(args.button) as "left" | "right" | "middle" } : {}),
        ...(Number(args.clickCount) > 0 ? { clickCount: Number(args.clickCount) } : {})
      })
    });
    this.pushStep({ tool: "browser_click_at", x, y });
    return this.afterAction(`已在 ${x},${y} 点击。`, evidence);
  }

  async typeAt(args: Record<string, unknown>): Promise<AgentToolResult> {
    const x = finiteNumber(args.x);
    const y = finiteNumber(args.y);
    const text = typeof args.text === "string" ? args.text : null;
    if (x === null || y === null || text === null) throw new BrowserError("BROWSER_COORDINATE", "坐标输入需要有效的 x、y 和文字");
    const { tab } = await this.options.sessions.activePage(this.options.taskId);
    const before = await this.options.sessions.snapshot(this.options.taskId);
    const evidence = await this.options.evidence.capture({
      taskId: this.options.taskId, runId: this.options.runId, kind: "type_at", page: tab.page,
      pageDigest: before.digest, actionDigest: digest({ tool: "browser_type_at", x, y, length: text.length }),
      action: () => tab.page.typeAt(x, y, text)
    });
    this.pushStep({ tool: "browser_type_at", x, y, text: "[REDACTED]" });
    return this.afterAction(`已在 ${x},${y} 输入文字。`, evidence);
  }

  async scroll(args: Record<string, unknown>): Promise<AgentToolResult> {
    const deltaX = finiteNumber(args.deltaX) ?? 0;
    const deltaY = finiteNumber(args.deltaY) ?? 600;
    const { tab } = await this.options.sessions.activePage(this.options.taskId);
    await tab.page.scroll(deltaX, deltaY);
    this.pushStep({ tool: "browser_scroll", deltaX, deltaY });
    return this.afterAction("页面已滚动。", null);
  }

  async tabs(args: Record<string, unknown>): Promise<AgentToolResult> {
    const action = stringValue(args.action);
    if (action === "list") {
      const session = await this.options.sessions.session(this.options.taskId);
      return {
        content: session.tabs.map((tab) => `${tab.id === session.activeTabId ? "*" : " "} ${tab.id} ${tab.url || "(空白)"}`).join("\n"),
        metadata: { browserTabs: session.tabs.map((tab) => ({ id: tab.id, url: tab.url, title: tab.title })) }
      };
    }
    if (action === "new") {
      const url = stringValue(args.url);
      const tab = await this.options.sessions.createTab(this.options.taskId, url ? parseHttpUrl(url).toString() : undefined);
      return { content: `已新建 ${tab.id}。${url ? `已打开 ${url}` : "用 browser_open 在当前标签打开网址。"}`, metadata: { browserTabId: tab.id } };
    }
    const tabId = stringValue(args.tabId);
    if (!tabId) throw new BrowserError("BROWSER_TAB_ID_REQUIRED", "需要标签页 ID");
    if (action === "activate") {
      const tab = await this.options.sessions.activateTab(this.options.taskId, tabId);
      return { content: `已切换到 ${tab.id}：${tab.url}`, metadata: { browserTabId: tab.id } };
    }
    if (action === "close") {
      await this.options.sessions.closeTab(this.options.taskId, tabId);
      return { content: `已关闭 ${tabId}` };
    }
    throw new BrowserError("BROWSER_TABS_ACTION", "标签页操作不正确");
  }

  async screenshot(args: Record<string, unknown>, context: AgentToolContext): Promise<AgentToolResult> {
    const { tab } = await this.options.sessions.activePage(this.options.taskId, { allowObservation: true });
    const dir = join(context.outDir, "browser-screenshots");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `page-${Date.now()}.png`);
    await tab.page.screenshot({ path, fullPage: args.fullPage === true });
    return { content: `已保存网页截图：${relative(context.workspaceRoot, path).replaceAll("\\", "/")}`, metadata: { browserScreenshot: path } };
  }

  async upload(args: Record<string, unknown>, context: AgentToolContext): Promise<AgentToolResult> {
    const ref = elementRef(args.ref);
    const raw = stringValue(args.path);
    if (!raw) throw new BrowserError("BROWSER_UPLOAD_PATH", "缺少上传文件路径");
    const path = isAbsolute(raw) ? resolve(raw) : resolve(context.workspaceRoot, raw);
    if (!insideRoot(context.workspaceRoot, path)) throw new BrowserError("BROWSER_UPLOAD_OUTSIDE", "只能上传工作区内的文件。");
    if (!existsSync(path) || !statSync(path).isFile()) throw new BrowserError("BROWSER_UPLOAD_MISSING", `文件不存在：${raw}`);
    const { tab } = await this.options.sessions.activePage(this.options.taskId);
    const before = await this.options.sessions.snapshot(this.options.taskId);
    const evidence = await this.options.evidence.capture({
      taskId: this.options.taskId, runId: this.options.runId, kind: "upload", page: tab.page,
      pageDigest: before.digest, actionDigest: digest({ tool: "browser_upload", ref, file: basename(path) }),
      action: () => tab.page.upload(ref, path, DEFAULT_TIMEOUT_MS)
    });
    this.pushStep({ tool: "browser_upload", ref, file: basename(path) });
    return this.afterAction(`已上传 ${basename(path)}。`, evidence);
  }

  async download(args: Record<string, unknown>, context: AgentToolContext): Promise<AgentToolResult> {
    const ref = elementRef(args.ref);
    const { tab } = await this.options.sessions.activePage(this.options.taskId);
    const result = await tab.page.download(ref, DEFAULT_TIMEOUT_MS);
    const dir = join(context.outDir, "browser-downloads");
    mkdirSync(dir, { recursive: true });
    const suggested = safeFileName(stringValue(args.fileName) ?? result.suggestedName ?? `download-${Date.now()}`);
    const path = uniquePath(dir, suggested);
    writeFileSync(path, result.data);
    this.pushStep({ tool: "browser_download", ref, file: basename(path) });
    return { content: `已下载到 ${relative(context.workspaceRoot, path).replaceAll("\\", "/")}（${result.suggestedName}）`, metadata: { browserDownload: path } };
  }

  async assert(args: Record<string, unknown>): Promise<AgentToolResult> {
    const kind = stringValue(args.kind);
    const value = stringValue(args.value);
    if (!value || (kind !== "text" && kind !== "url" && kind !== "element" && kind !== "no-element")) {
      throw new BrowserError("BROWSER_ASSERT_INPUT", "断言类型或值不正确");
    }
    const timeout = Math.min(60_000, Math.max(500, (Number(args.timeoutSec) || 10) * 1_000));
    const { tab, session } = await this.options.sessions.activePage(this.options.taskId);
    let passed = false;
    let actual = "";
    try {
      if (kind === "text" || kind === "element") {
        await tab.page.wait({ kind, value, timeoutMs: timeout });
        passed = true;
      } else {
        const deadline = Date.now() + timeout;
        do {
          const raw = await tab.page.snapshot(session.controlEpoch);
          const pageText = raw.frames.map((frame) => frame.text).join("\n");
          const hasElement = raw.frames.some((frame) => frame.elements.some((element) => element.ref === value));
          passed = kind === "url" ? raw.url.includes(value) : !hasElement;
          actual = kind === "url" ? raw.url : pageText.slice(0, 300);
          if (passed) break;
          await new Promise((resolve) => setTimeout(resolve, 150));
        } while (Date.now() < deadline);
      }
      if (passed && !actual) actual = kind === "text" ? "正文包含目标文字" : kind === "element" ? `元素 ${value} 可见` : kind === "url" ? tab.page.url() : `元素 ${value} 不存在`;
    } catch {
      const snapshot = await this.options.sessions.snapshot(this.options.taskId, { allowBeforeObservation: true }).catch(() => null);
      actual = kind === "url" ? tab.page.url() : (snapshot?.content ?? "").slice(0, 300);
    }
    const assertion = { kind, expected: value, passed, ...(passed ? {} : { actual }) };
    session.assertions.push(assertion);
    this.pushStep({ tool: "browser_assert", kind, value });
    return {
      content: passed ? `断言通过：${assertionLabel(kind, value)}` : `断言失败：${assertionLabel(kind, value)}。当前页面：${actual.slice(0, 300)}`,
      isError: !passed,
      metadata: { browserAssertions: session.assertions }
    };
  }

  async requestTakeover(args: Record<string, unknown>): Promise<AgentToolResult> {
    const kind = stringValue(args.kind);
    const reason = stringValue(args.reason);
    if (!kind || !TAKEOVER_KINDS.has(kind as BrowserTakeoverKind)) {
      throw new BrowserError("BROWSER_TAKEOVER_KIND", "接管类型不正确");
    }
    if (!reason) throw new BrowserError("BROWSER_TAKEOVER_REASON", "需要说明为什么要接管");
    const descriptor = this.options.sessions.requestUserTakeover(this.options.taskId, kind as BrowserTakeoverKind, reason);
    this.pushStep({ tool: "browser_request_takeover", kind, reason });
    return {
      content: `需要你接管浏览器完成${takeoverLabel(kind as BrowserTakeoverKind)}：${reason}`,
      action: "ask_user",
      question: `浏览器需要你接管完成${takeoverLabel(kind as BrowserTakeoverKind)}。请在当前浏览器中完成操作，然后回到 Hearth 点击“继续 Agent”。`,
      metadata: { browserTakeover: true, browserTakeoverKind: kind, browserTakeoverReason: reason, browserControlEpoch: descriptor.controlEpoch }
    };
  }

  async recipe(args: Record<string, unknown>): Promise<AgentToolResult> {
    const action = stringValue(args.action);
    const name = stringValue(args.name);
    if (action === "list") {
      const recipes = listRecipes(this.options.recipesDir);
      return {
        content: recipes.length > 0 ? recipes.map((recipe) => `- ${recipe.name} (${recipe.domain})`).join("\n") : "还没有保存过网页配方。",
        metadata: { browserRecipes: recipes.map(({ name: recipeName, domain }) => ({ name: recipeName, domain })) }
      };
    }
    if (!name) throw new BrowserError("BROWSER_RECIPE_NAME", "需要配方名称");
    if (action === "save") {
      const session = await this.options.sessions.session(this.options.taskId);
      const active = this.options.sessions.activeTab(this.options.taskId);
      if (!active) throw new BrowserError("BROWSER_RECIPE_EMPTY", "当前任务没有网页流程可以保存。");
      let domain = "";
      try {
        domain = new URL(active.page.url()).hostname;
      } catch {
        domain = new URL(active.url).hostname;
      }
      const file = join(this.options.recipesDir, `${safeSlug(domain)}-${safeSlug(name)}.json`);
      mkdirSync(this.options.recipesDir, { recursive: true });
      writeFileSync(file, JSON.stringify({ name, domain, steps: session.steps, createdAt: new Date().toISOString() }, null, 2), "utf8");
      return { content: `已保存网页配方：${name}（${session.steps.length} 步）`, metadata: { browserRecipe: file } };
    }
    const recipe = findRecipe(this.options.recipesDir, name);
    if (!recipe) throw new BrowserError("BROWSER_RECIPE_MISSING", `找不到配方：${name}`);
    if (action === "delete") {
      rmSync(recipe.path, { force: true });
      return { content: `已删除网页配方：${recipe.name}` };
    }
    if (action !== "replay") throw new BrowserError("BROWSER_RECIPE_ACTION", "配方操作不正确");
    for (const step of recipe.steps) await this.replayStep(step);
    const snapshot = await this.options.sessions.snapshot(this.options.taskId);
    return {
      content: `已回放 ${recipe.steps.length} 步。\n\n${snapshot.content}`,
      metadata: this.snapshotMetadata(snapshot)
    };
  }

  private async afterAction(message: string, evidence: BrowserEvidenceRecord | null, includePage = true): Promise<AgentToolResult> {
    if (evidence) this.emitEvidence(evidence);
    if (!includePage) return { content: message };
    const snapshot = await this.options.sessions.snapshot(this.options.taskId, { allowBeforeObservation: true });
    if (evidence) this.emitEvidence(evidence);
    return {
      content: `${message}\n\n${snapshot.content}`,
      metadata: {
        ...this.snapshotMetadata(snapshot),
        ...(evidence ? { browserEvidence: relativeEvidence(evidence) } : {})
      }
    };
  }

  private snapshotMetadata(snapshot: BrowserSnapshot): Record<string, unknown> {
    const descriptor = this.options.sessions.describe(this.options.taskId);
    return {
      browserUrl: snapshot.url,
      browserPageDigest: snapshot.digest,
      browserCapturedAt: snapshot.capturedAt,
      browserTruncated: snapshot.truncated,
      browserControlState: descriptor?.controlState ?? "agent",
      browserControlEpoch: descriptor?.controlEpoch ?? null
    };
  }

  private async replayStep(step: BrowserRecipeStep): Promise<void> {
    const result = await (async (): Promise<AgentToolResult> => {
      switch (step.tool) {
        case "browser_open": return this.open({ url: step.url }, fakeContext());
        case "browser_click": return this.click({ ref: step.ref });
        case "browser_hover": return this.hover({ ref: step.ref });
        case "browser_type":
          if (step.text === "[REDACTED]") {
            return this.requestTakeover({ kind: "login", reason: `配方 ${stringValue(step.ref) ?? "输入步骤"} 需要重新输入凭据` });
          }
          return this.type({ ref: step.ref, text: step.text });
        case "browser_key": return this.key({ key: step.key });
        case "browser_wait": return this.wait({ kind: step.kind, value: step.value, ...(step.timeoutMs ? { timeoutSec: Number(step.timeoutMs) / 1_000 } : {}) });
        case "browser_submit": return this.submit({ ref: step.ref });
        case "browser_select": return this.select({ ref: step.ref, values: step.values });
        case "browser_drag": return this.drag({ startRef: step.startRef, endRef: step.endRef });
        case "browser_click_at": return this.clickAt({ x: step.x, y: step.y });
        case "browser_type_at":
          if (step.text === "[REDACTED]") {
            return this.requestTakeover({ kind: "complex_interaction", reason: "配方中的坐标输入包含敏感内容" });
          }
          return this.typeAt({ x: step.x, y: step.y, text: step.text });
        case "browser_scroll": return this.scroll({ deltaX: step.deltaX, deltaY: step.deltaY });
        case "browser_assert": return this.assert({ kind: step.kind, value: step.value });
        case "browser_request_takeover": return this.requestTakeover({ kind: step.kind, reason: step.reason });
        default: throw new BrowserError("BROWSER_RECIPE_STEP", `不支持的配方步骤：${step.tool}`);
      }
    })();
    if (result.action === "ask_user" || result.isError) {
      throw new BrowserError("BROWSER_RECIPE_INTERRUPTED", String(result.content));
    }
  }

  private pushStep(step: BrowserRecipeStep): void {
    const session = this.options.sessions.state(this.options.taskId);
    if (!session) return;
    session.steps.push(step);
    if (session.steps.length > 200) session.steps.splice(0, session.steps.length - 200);
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
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function elementRef(value: unknown): string {
  const ref = stringValue(value);
  if (!ref || !/^\d+:e\d+$/.test(ref)) {
    throw new BrowserError("BROWSER_ELEMENT_REF", "元素 ID 必须来自当前页面快照，例如 2:e8。请先 browser_read 刷新页面。");
  }
  return ref;
}

function finiteNumber(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
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
