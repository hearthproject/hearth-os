import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { BrowserError, type BrowserService } from "./browser-service.ts";
import type { BrowserPage } from "./browser-page.ts";
import { ManagedBrowserPage } from "./browser-page.ts";
import { ExtensionBrowserConnection, type ExtensionConnectionOptions, type ExtensionStatus } from "./browser-extension.ts";
import type { BrowserSnapshot } from "./browser-snapshot.ts";
import type { SecretBox } from "./secrets.ts";

export type BrowserBackendMode = "managed" | "extension";
export type BrowserControlState = "agent" | "awaiting_user" | "user" | "closed" | "unavailable";
export type BrowserTakeoverKind = "login" | "captcha" | "payment_confirmation" | "complex_interaction" | "other";

export interface BrowserTab {
  id: string;
  page: BrowserPage;
  title: string;
  url: string;
  createdAt: string;
}

export interface BrowserAssertion {
  kind: string;
  expected: string;
  passed: boolean;
  actual?: string;
}

export interface BrowserRecipeStep {
  tool: string;
  [key: string]: unknown;
}

export interface BrowserSessionState {
  taskId: string;
  backend: BrowserBackendMode;
  tabs: BrowserTab[];
  activeTabId: string | null;
  controlState: BrowserControlState;
  controlEpoch: number;
  takeoverKind: BrowserTakeoverKind | null;
  takeoverReason: string | null;
  requiresFreshObservation: boolean;
  lastUsedAt: number;
  assertions: BrowserAssertion[];
  steps: BrowserRecipeStep[];
  lastSnapshotDigest: string | null;
  lastObservedAt: string | null;
  lastSnapshot: BrowserSnapshot | null;
  unavailableReason: string | null;
  extension: ExtensionBrowserConnection | null;
}

export interface PersistedBrowserTab {
  id: string;
  url: string;
  title: string;
  createdAt: string;
}

export interface PersistedBrowserSession {
  version: 1;
  taskId: string;
  backend: BrowserBackendMode;
  tabs: PersistedBrowserTab[];
  activeTabId: string | null;
  controlState: BrowserControlState;
  controlEpoch: number;
  takeoverKind: BrowserTakeoverKind | null;
  takeoverReason: string | null;
  lastSnapshotDigest: string | null;
  lastObservedAt: string | null;
  updatedAt: string;
}

export interface BrowserSessionDescriptor {
  exists: boolean;
  backend: BrowserBackendMode | null;
  controlState: BrowserControlState;
  controlEpoch: number;
  takeoverKind: BrowserTakeoverKind | null;
  takeoverReason: string | null;
  requiresFreshObservation: boolean;
  tabs: Array<{ id: string; url: string; title: string; active: boolean }>;
  activeTabId: string | null;
  lastSnapshotDigest: string | null;
  lastObservedAt: string | null;
  unavailableReason: string | null;
}

export interface BrowserSessionManagerOptions {
  statePath?: string | undefined;
  extensionTokenPath?: string | undefined;
  extensionOutputDir?: string | undefined;
  extensionProfileDirName?: string | undefined;
  secretBox?: SecretBox | undefined;
  extensionConnector?: ((options: ExtensionConnectionOptions) => Promise<ExtensionBrowserConnection>) | undefined;
  managedPageFactory?: ((url?: string) => Promise<BrowserPage>) | undefined;
  now?: (() => number) | undefined;
}

interface SessionFile {
  version: 1;
  sessions: Record<string, PersistedBrowserSession>;
}

export class BrowserSessionManager {
  private readonly browser: BrowserService;
  private readonly sessions = new Map<string, BrowserSessionState>();
  private readonly statePath: string | null;
  private readonly extensionTokenPath: string;
  private readonly extensionOutputDir: string;
  private readonly extensionProfileDirName: string | undefined;
  private readonly secretBox: SecretBox | undefined;
  private readonly extensionConnector: (options: ExtensionConnectionOptions) => Promise<ExtensionBrowserConnection>;
  private readonly managedPageFactory: ((url?: string) => Promise<BrowserPage>) | undefined;
  private readonly now: () => number;

  constructor(browser: BrowserService, options: BrowserSessionManagerOptions = {}) {
    this.browser = browser;
    this.statePath = options.statePath ?? null;
    this.extensionTokenPath = options.extensionTokenPath ?? join(process.cwd(), ".hearth", "browser", "extension-token");
    this.extensionOutputDir = options.extensionOutputDir ?? join(process.cwd(), ".hearth", "browser", "mcp-output");
    this.extensionProfileDirName = options.extensionProfileDirName;
    this.secretBox = options.secretBox;
    if (this.secretBox) ExtensionBrowserConnection.migrateToken(this.extensionTokenPath, this.secretBox);
    this.extensionConnector = options.extensionConnector ?? ((input) => ExtensionBrowserConnection.connect(input));
    this.managedPageFactory = options.managedPageFactory;
    this.now = options.now ?? Date.now;
  }

  async session(taskId: string, options: { backend?: BrowserBackendMode | "auto" | undefined } = {}): Promise<BrowserSessionState> {
    const existing = this.sessions.get(taskId);
    if (existing) {
      existing.lastUsedAt = this.now();
      return existing;
    }
    const persisted = this.load()?.sessions[taskId] ?? null;
    const requested = options.backend ?? "auto";
    const backend = requested === "auto"
      ? persisted?.backend ?? (this.extensionStatus().paired ? "extension" : "managed")
      : requested;
    try {
      const session = backend === "extension"
        ? await this.openExtensionSession(taskId, persisted)
        : await this.openManagedSession(taskId, persisted);
      this.sessions.set(taskId, session);
      this.persist(session);
      return session;
    } catch (error) {
      if (backend === "extension" && requested === "auto") {
        const fallback = await this.openManagedSession(taskId, persisted ? { ...persisted, backend: "managed" } : null);
        fallback.unavailableReason = `Playwright Extension 不可用，已回退到受管 Chrome：${errorMessage(error)}`;
        this.sessions.set(taskId, fallback);
        this.persist(fallback);
        return fallback;
      }
      throw error;
    }
  }

  async connectExtension(taskId: string, token?: string, profileDirName?: string): Promise<ExtensionBrowserConnection> {
    const suppliedToken = token?.trim() || null;
    const existing = this.sessions.get(taskId) ?? null;
    const persisted = this.persisted(taskId);
    const urls = existing?.tabs.map((tab) => tab.url) ?? persisted?.tabs.map((tab) => tab.url) ?? [];
    const activeIndex = existing
      ? Math.max(0, existing.tabs.findIndex((tab) => tab.id === existing.activeTabId))
      : Math.max(0, persisted?.tabs.findIndex((tab) => tab.id === persisted.activeTabId) ?? 0);
    let extension: ExtensionBrowserConnection | null = null;
    let tabs: BrowserTab[];
    let activeTabId: string | null;
    try {
      extension = await this.extensionConnector(this.extensionOptions(taskId, suppliedToken ?? undefined, profileDirName));
      const restored = await this.restoreExtensionTabs(extension, urls, activeIndex);
      tabs = restored.tabs;
      activeTabId = restored.activeTabId;
      if (suppliedToken) ExtensionBrowserConnection.saveToken(this.extensionTokenPath, suppliedToken, this.secretBox);
    } catch (error) {
      await extension?.close().catch(() => undefined);
      throw error;
    }
    if (!extension) throw new BrowserError("BROWSER_EXTENSION_UNAVAILABLE", "Playwright Extension 没有建立连接");
    if (existing) await this.closeRuntime(existing, false);
    const previousState = existing?.controlState ?? persisted?.controlState;
    const controlState = previousState === "user" || previousState === "awaiting_user" ? previousState : "agent";
    const session: BrowserSessionState = {
      taskId,
      backend: "extension",
      tabs,
      activeTabId,
      controlState,
      controlEpoch: Math.max(existing?.controlEpoch ?? 0, persisted?.controlEpoch ?? 0) + 1,
      takeoverKind: existing?.takeoverKind ?? persisted?.takeoverKind ?? null,
      takeoverReason: existing?.takeoverReason ?? persisted?.takeoverReason ?? null,
      requiresFreshObservation: true,
      lastUsedAt: this.now(),
      assertions: existing?.assertions ?? [],
      steps: existing?.steps ?? [],
      lastSnapshotDigest: existing?.lastSnapshotDigest ?? persisted?.lastSnapshotDigest ?? null,
      lastObservedAt: existing?.lastObservedAt ?? persisted?.lastObservedAt ?? null,
      lastSnapshot: existing?.lastSnapshot ?? null,
      unavailableReason: null,
      extension
    };
    this.sessions.set(taskId, session);
    this.persist(session);
    return extension;
  }
  async createTab(taskId: string, url?: string): Promise<BrowserTab> {
    const session = await this.session(taskId);
    this.assertAgentControl(session, true);
    let page: BrowserPage;
    if (session.backend === "extension") {
      if (!session.extension) throw new BrowserError("BROWSER_EXTENSION_UNAVAILABLE", "Playwright Extension 会话已断开");
      page = await session.extension.createPage(url);
    } else {
      page = await this.managedPage(url);
    }
    const tab = this.tab(page, await page.title(), url ?? page.url());
    session.tabs.push(tab);
    session.activeTabId = tab.id;
    session.requiresFreshObservation = true;
    session.lastUsedAt = this.now();
    this.persist(session);
    return tab;
  }

  async activateTab(taskId: string, tabId: string): Promise<BrowserTab> {
    const session = await this.session(taskId);
    const tab = session.tabs.find((item) => item.id === tabId);
    if (!tab) throw new BrowserError("BROWSER_TAB_NOT_FOUND", `找不到标签页：${tabId}`);
    session.activeTabId = tab.id;
    session.lastUsedAt = this.now();
    await tab.page.bringToFront().catch(() => undefined);
    this.persist(session);
    return tab;
  }

  async closeTab(taskId: string, tabId: string): Promise<void> {
    const session = await this.session(taskId);
    this.assertAgentControl(session, true);
    const tab = session.tabs.find((item) => item.id === tabId);
    if (!tab) throw new BrowserError("BROWSER_TAB_NOT_FOUND", `找不到标签页：${tabId}`);
    session.tabs = session.tabs.filter((item) => item.id !== tabId);
    if (session.activeTabId === tabId) session.activeTabId = session.tabs[0]?.id ?? null;
    await tab.page.close().catch(() => undefined);
    session.lastUsedAt = this.now();
    this.persist(session);
  }

  requestUserTakeover(taskId: string, kind: BrowserTakeoverKind, reason: string): BrowserSessionDescriptor {
    const session = this.requireState(taskId);
    if (session.controlState === "agent") session.controlEpoch += 1;
    session.controlState = "awaiting_user";
    session.takeoverKind = kind;
    session.takeoverReason = reason;
    session.requiresFreshObservation = true;
    session.lastUsedAt = this.now();
    void this.activeTab(taskId)?.page.bringToFront().catch(() => undefined);
    this.persist(session);
    return this.describe(taskId)!;
  }

  beginUserTakeover(taskId: string, kind: BrowserTakeoverKind = "other", reason = "用户主动接管浏览器"): BrowserSessionDescriptor {
    const session = this.requireState(taskId);
    if (session.controlState !== "user") session.controlEpoch += 1;
    session.controlState = "user";
    session.takeoverKind = kind;
    session.takeoverReason = reason;
    session.requiresFreshObservation = true;
    session.lastUsedAt = this.now();
    void this.activeTab(taskId)?.page.bringToFront().catch(() => undefined);
    this.persist(session);
    return this.describe(taskId)!;
  }

  async releaseToAgent(taskId: string): Promise<{ session: BrowserSessionDescriptor; snapshot: BrowserSnapshot | null }> {
    const session = this.sessions.get(taskId) ?? await this.session(taskId).catch(() => null);
    if (!session) throw new BrowserError("BROWSER_SESSION_MISSING", "当前任务没有浏览器会话");
    if (session.controlState !== "user" && session.controlState !== "awaiting_user") {
      throw new BrowserError("BROWSER_RELEASE_NOT_ALLOWED", `浏览器当前状态为 ${session.controlState}，不能归还给 Agent`);
    }
    session.controlEpoch += 1;
    session.controlState = "agent";
    session.requiresFreshObservation = true;
    session.lastUsedAt = this.now();
    this.persist(session);
    let snapshot: BrowserSnapshot | null = null;
    try {
      snapshot = await this.snapshot(taskId, { allowBeforeObservation: true });
      session.requiresFreshObservation = false;
    } catch {
      // The user may have closed the page from Chrome. Keep the session and let
      // the Agent reopen/recover on its next observation.
    }
    return { session: this.describe(taskId)!, snapshot };
  }

  /** Compatibility aliases for older callers. */
  pause(taskId: string): boolean {
    if (!this.sessions.has(taskId) && !this.persisted(taskId)) return false;
    this.beginUserTakeover(taskId);
    return true;
  }

  resume(taskId: string): boolean {
    const session = this.sessions.get(taskId);
    if (!session) return false;
    if (session.controlState !== "user" && session.controlState !== "awaiting_user") return false;
    session.controlEpoch += 1;
    session.controlState = "agent";
    session.requiresFreshObservation = true;
    session.lastUsedAt = this.now();
    this.persist(session);
    return true;
  }

  async activePage(taskId: string, options: { allowObservation?: boolean } = {}): Promise<{ session: BrowserSessionState; tab: BrowserTab }> {
    const session = await this.session(taskId);
    this.assertAgentControl(session, Boolean(options.allowObservation));
    const tab = this.activeTab(taskId);
    if (!tab) throw new BrowserError("BROWSER_TAB_MISSING", "当前任务没有可用的浏览器标签页。");
    session.lastUsedAt = this.now();
    return { session, tab };
  }

  async snapshot(taskId: string, options: { allowBeforeObservation?: boolean } = {}): Promise<BrowserSnapshot> {
    const { session, tab } = await this.activePage(taskId, { allowObservation: options.allowBeforeObservation !== false });
    const { formatBrowserSnapshot } = await import("./browser-snapshot.ts");
    const snapshot = formatBrowserSnapshot(await tab.page.snapshot(session.controlEpoch));
    session.lastSnapshotDigest = snapshot.digest;
    session.lastObservedAt = snapshot.capturedAt;
    session.lastSnapshot = snapshot;
    session.requiresFreshObservation = false;
    tab.url = snapshot.url;
    tab.title = snapshot.title;
    session.lastUsedAt = this.now();
    this.persist(session);
    return snapshot;
  }

  recordSnapshot(taskId: string, snapshot: BrowserSnapshot): void {
    const session = this.sessions.get(taskId);
    if (!session) return;
    session.lastSnapshotDigest = snapshot.digest;
    session.lastObservedAt = snapshot.capturedAt;
    session.lastSnapshot = snapshot;
    session.requiresFreshObservation = false;
    const tab = this.activeTab(taskId);
    if (tab) {
      tab.url = snapshot.url;
      tab.title = snapshot.title;
    }
    this.persist(session);
  }

  has(taskId: string): boolean {
    return this.sessions.has(taskId) || Boolean(this.persisted(taskId));
  }

  state(taskId: string): BrowserSessionState | null {
    return this.sessions.get(taskId) ?? null;
  }

  activeTab(taskId: string): BrowserTab | null {
    const session = this.sessions.get(taskId);
    if (!session) return null;
    return session.tabs.find((item) => item.id === session.activeTabId) ?? session.tabs[0] ?? null;
  }

  latestSnapshot(taskId: string): BrowserSnapshot | null {
    return this.sessions.get(taskId)?.lastSnapshot ?? null;
  }

  describe(taskId: string): BrowserSessionDescriptor | null {
    const session = this.sessions.get(taskId);
    if (session) {
      return {
        exists: true,
        backend: session.backend,
        controlState: session.controlState,
        controlEpoch: session.controlEpoch,
        takeoverKind: session.takeoverKind,
        takeoverReason: session.takeoverReason,
        requiresFreshObservation: session.requiresFreshObservation,
        tabs: session.tabs.map((tab) => ({ id: tab.id, url: redactBrowserUrl(tab.page.url() || tab.url), title: redactBrowserUrl(tab.title), active: tab.id === session.activeTabId })),
        activeTabId: session.activeTabId,
        lastSnapshotDigest: session.lastSnapshotDigest,
        lastObservedAt: session.lastObservedAt,
        unavailableReason: session.unavailableReason
      };
    }
    const persisted = this.persisted(taskId);
    if (!persisted) return null;
    return {
      exists: true,
      backend: persisted.backend,
      controlState: persisted.controlState,
      controlEpoch: persisted.controlEpoch,
      takeoverKind: persisted.takeoverKind,
      takeoverReason: persisted.takeoverReason,
      requiresFreshObservation: true,
      tabs: persisted.tabs.map((tab) => ({ id: tab.id, url: redactBrowserUrl(tab.url), title: redactBrowserUrl(tab.title), active: tab.id === persisted.activeTabId })),
      activeTabId: persisted.activeTabId,
      lastSnapshotDigest: persisted.lastSnapshotDigest,
      lastObservedAt: persisted.lastObservedAt,
      unavailableReason: null
    };
  }

  extensionStatus(): ExtensionStatus {
    return ExtensionBrowserConnection.status(this.extensionTokenPath, this.secretBox);
  }

  async connectExtensionToken(taskId: string, token?: string, profileDirName?: string): Promise<BrowserSessionDescriptor> {
    await this.connectExtension(taskId, token, profileDirName);
    return this.describe(taskId)!;
  }

  async close(taskId: string): Promise<void> {
    const session = this.sessions.get(taskId);
    if (session) await this.closeRuntime(session, true);
    this.sessions.delete(taskId);
    const file = this.load();
    if (file?.sessions[taskId]) {
      delete file.sessions[taskId];
      this.save(file);
    }
  }

  async release(taskId: string): Promise<void> {
    await this.close(taskId);
  }

  async releaseAll(): Promise<void> {
    this.sessions.clear();
    await this.browser.close();
  }

  async stop(): Promise<void> {
    for (const session of this.sessions.values()) {
      await session.extension?.close().catch(() => undefined);
    }
    this.sessions.clear();
  }

  private async openManagedSession(taskId: string, persisted: PersistedBrowserSession | null): Promise<BrowserSessionState> {
    const urls = persisted?.tabs.map((tab) => tab.url) ?? [""];
    const tabs: BrowserTab[] = [];
    for (const url of urls) {
      const page = await this.managedPage(url);
      tabs.push(this.tab(page, await page.title(), page.url() || url));
    }
    const activeIndex = Math.max(0, persisted?.tabs.findIndex((tab) => tab.id === persisted.activeTabId) ?? 0);
    return {
      taskId,
      backend: "managed",
      tabs,
      activeTabId: tabs[activeIndex]?.id ?? tabs[0]?.id ?? null,
      controlState: persisted?.controlState === "user" ? "user" : persisted?.controlState === "awaiting_user" ? "awaiting_user" : "agent",
      controlEpoch: Math.max(1, persisted?.controlEpoch ?? 1),
      takeoverKind: persisted?.takeoverKind ?? null,
      takeoverReason: persisted?.takeoverReason ?? null,
      requiresFreshObservation: true,
      lastUsedAt: this.now(),
      assertions: [],
      steps: [],
      lastSnapshotDigest: persisted?.lastSnapshotDigest ?? null,
      lastObservedAt: persisted?.lastObservedAt ?? null,
      lastSnapshot: null,
      unavailableReason: null,
      extension: null
    };
  }

  private async openExtensionSession(taskId: string, persisted: PersistedBrowserSession | null): Promise<BrowserSessionState> {
    const extension = await this.extensionConnector(this.extensionOptions(taskId));
    try {
      const urls = persisted?.tabs.map((tab) => tab.url) ?? [""];
      const activeIndex = Math.max(0, persisted?.tabs.findIndex((tab) => tab.id === persisted.activeTabId) ?? 0);
      const restored = await this.restoreExtensionTabs(extension, urls, activeIndex);
      return {
        taskId,
        backend: "extension",
        tabs: restored.tabs,
        activeTabId: restored.activeTabId,
        controlState: persisted?.controlState === "user" ? "user" : persisted?.controlState === "awaiting_user" ? "awaiting_user" : "agent",
        controlEpoch: Math.max(1, persisted?.controlEpoch ?? 1),
        takeoverKind: persisted?.takeoverKind ?? null,
        takeoverReason: persisted?.takeoverReason ?? null,
        requiresFreshObservation: true,
        lastUsedAt: this.now(),
        assertions: [],
        steps: [],
        lastSnapshotDigest: persisted?.lastSnapshotDigest ?? null,
        lastObservedAt: persisted?.lastObservedAt ?? null,
        lastSnapshot: null,
        unavailableReason: null,
        extension
      };
    } catch (error) {
      await extension.close().catch(() => undefined);
      throw error;
    }
  }

  private async managedPage(url?: string): Promise<BrowserPage> {
    if (this.managedPageFactory) return this.managedPageFactory(url);
    const page = new ManagedBrowserPage(await (await this.browser.context()).newPage());
    if (url && url !== "about:blank") await page.goto(url, 60_000).catch(() => undefined);
    return page;
  }
  private async restoreExtensionTabs(
    extension: ExtensionBrowserConnection,
    urls: string[],
    activeIndex: number
  ): Promise<{ tabs: BrowserTab[]; activeTabId: string }> {
    const restored: Array<BrowserTab | undefined> = new Array(urls.length);
    const initial = await extension.attachInitialPage(urls[activeIndex] || undefined);
    const initialTab = this.tab(initial, await initial.title(), initial.url());
    restored[activeIndex] = initialTab;
    for (let index = 0; index < urls.length; index += 1) {
      if (index === activeIndex) continue;
      const page = await extension.createPage(urls[index]);
      restored[index] = this.tab(page, await page.title(), urls[index] || page.url());
    }
    return {
      tabs: restored.filter((tab): tab is BrowserTab => Boolean(tab)),
      activeTabId: initialTab.id
    };
  }

  private extensionOptions(taskId: string, token?: string, profileDirName?: string): ExtensionConnectionOptions {
    const selectedProfile = profileDirName?.trim() || this.extensionProfileDirName;
    return {
      taskId,
      tokenPath: this.extensionTokenPath,
      ...(this.secretBox ? { secretBox: this.secretBox } : {}),
      ...(token ? { token } : {}),
      outputDir: this.extensionOutputDir,
      ...(selectedProfile ? { profileDirName: selectedProfile } : {})
    };
  }

  private tab(page: BrowserPage, title: string, url: string): BrowserTab {
    return { id: `tab-${randomUUID()}`, page, title, url, createdAt: new Date(this.now()).toISOString() };
  }

  private requireState(taskId: string): BrowserSessionState {
    const session = this.sessions.get(taskId);
    if (!session) throw new BrowserError("BROWSER_SESSION_MISSING", "当前任务没有打开的浏览器");
    return session;
  }

  private sessionSync(taskId: string): BrowserSessionState | null {
    return this.sessions.get(taskId) ?? null;
  }

  private assertAgentControl(session: BrowserSessionState, allowObservation: boolean): void {
    if (session.controlState === "awaiting_user") {
      throw new BrowserError("BROWSER_TAKEOVER", `需要你接管浏览器完成${takeoverLabel(session.takeoverKind)}：${session.takeoverReason ?? "请完成当前页面操作"}`);
    }
    if (session.controlState === "user") {
      throw new BrowserError("BROWSER_TAKEOVER", "你正在接管浏览器，Agent 已暂停。完成后请点击“继续 Agent”。");
    }
    if (session.controlState !== "agent") {
      throw new BrowserError("BROWSER_UNAVAILABLE", session.unavailableReason ?? `浏览器状态不可用：${session.controlState}`);
    }
    if (session.requiresFreshObservation && !allowObservation) {
      throw new BrowserError("BROWSER_OBSERVATION_STALE", "浏览器控制权已经切换，必须先用 browser_read 重新观察页面，再执行操作。");
    }
  }

  private async closeRuntime(session: BrowserSessionState, deletePages: boolean): Promise<void> {
    if (deletePages) {
      await Promise.all(session.tabs.map((tab) => tab.page.close().catch(() => undefined)));
    }
    await session.extension?.close().catch(() => undefined);
  }

  private persisted(taskId: string): PersistedBrowserSession | null {
    return this.load()?.sessions[taskId] ?? null;
  }

  private persist(session: BrowserSessionState): void {
    if (!this.statePath) return;
    try {
      const file = this.load() ?? { version: 1 as const, sessions: {} };
      file.sessions[session.taskId] = {
        version: 1,
        taskId: session.taskId,
        backend: session.backend,
        tabs: session.tabs.map((tab) => ({ id: tab.id, url: redactBrowserUrl(tab.page.url() || tab.url), title: redactBrowserUrl(tab.title), createdAt: tab.createdAt })),
      activeTabId: session.activeTabId,
      controlState: session.controlState,
      controlEpoch: session.controlEpoch,
      takeoverKind: session.takeoverKind,
      takeoverReason: session.takeoverReason,
      lastSnapshotDigest: session.lastSnapshotDigest,
        lastObservedAt: session.lastObservedAt,
        updatedAt: new Date(this.now()).toISOString()
      };
      this.save(file);
    } catch (error) {
      console.warn("[browser] session metadata could not be persisted:", error instanceof Error ? error.message : String(error));
    }
  }

  private load(): SessionFile | null {
    if (!this.statePath || !existsSync(this.statePath)) return null;
    try {
      const raw = JSON.parse(readFileSync(this.statePath, "utf8")) as SessionFile;
      if (raw.version !== 1 || !raw.sessions || typeof raw.sessions !== "object") return null;
      return raw;
    } catch {
      return null;
    }
  }

  private save(file: SessionFile): void {
    if (!this.statePath) return;
    mkdirSync(dirname(this.statePath), { recursive: true });
    const temporary = `${this.statePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temporary, JSON.stringify(file, null, 2), "utf8");
    try {
      renameSync(temporary, this.statePath);
    } catch {
      rmSync(this.statePath, { force: true });
      renameSync(temporary, this.statePath);
    }
  }
}

const SENSITIVE_URL_PARAM = /^(?:code|token|access_token|refresh_token|id_token|secret|password|credential|session|sessionid|auth|signature|sig|state)$/i;

export function redactBrowserUrl(value: string): string {
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_URL_PARAM.test(key)) url.searchParams.set(key, "<redacted>");
    }
    if (url.hash.length > 1) {
      const fragment = url.hash.slice(1);
      const params = new URLSearchParams(fragment);
      let changed = false;
      for (const key of [...params.keys()]) {
        if (!SENSITIVE_URL_PARAM.test(key)) continue;
        params.set(key, "<redacted>");
        changed = true;
      }
      if (changed) url.hash = params.toString();
    }
    return url.toString();
  } catch {
    return redactSensitiveUrlText(value);
  }
}

function redactSensitiveUrlText(value: string): string {
  return value.replace(
    /([?&#;](?:code|token|access_token|refresh_token|id_token|secret|password|credential|session|sessionid|auth|signature|sig|state)=)([^&#\s]+)/gi,
    "$1<redacted>"
  );
}

export function takeoverLabel(kind: BrowserTakeoverKind | null): string {
  if (kind === "login") return "登录或验证码";
  if (kind === "captcha") return "验证码";
  if (kind === "payment_confirmation") return "支付确认";
  if (kind === "complex_interaction") return "复杂前端交互";
  return "当前网页操作";
}

/** Kept for source compatibility; browser assertions are now optional. */
export function browserFinishIssue(_state: BrowserSessionState | null | undefined): string | null {
  return null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
