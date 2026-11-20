import type { Page } from "playwright-core";
import { BrowserError, type BrowserService } from "./browser-service.ts";

export interface BrowserTab {
  id: string;
  page: Page;
  title: string;
  url: string;
  createdAt: string;
}

export interface BrowserSessionState {
  taskId: string;
  tabs: BrowserTab[];
  activeTabId: string | null;
  paused: boolean;
  lastUsedAt: number;
  assertions: Array<{ kind: string; expected: string; passed: boolean; actual?: string }>;
  steps: BrowserRecipeStep[];
  lastSnapshotDigest: string | null;
}

export type BrowserRecipeStep =
  | { tool: "browser_open"; url: string }
  | { tool: "browser_click"; ref: string; name?: string | undefined }
  | { tool: "browser_type"; ref: string; text: string; name?: string | undefined }
  | { tool: "browser_key"; key: string }
  | { tool: "browser_wait"; kind: "element" | "text"; value: string; timeoutMs?: number | undefined }
  | { tool: "browser_assert"; kind: "text" | "url" | "element" | "no-element"; value: string };

const MAX_SESSIONS = 4;
const MAX_TABS = 6;
const IDLE_MS = 10 * 60_000;

export class BrowserSessionManager {
  private readonly browser: BrowserService;
  private readonly sessions = new Map<string, BrowserSessionState>();
  private readonly idleTimer: NodeJS.Timeout;

  constructor(browser: BrowserService, options: { idleMs?: number } = {}) {
    this.browser = browser;
    const idleMs = options.idleMs ?? IDLE_MS;
    this.idleTimer = setInterval(() => {
      const now = Date.now();
      for (const [taskId, session] of this.sessions) {
        if (now - session.lastUsedAt < idleMs) continue;
        void this.release(taskId);
      }
    }, Math.min(60_000, Math.max(50, Math.floor(idleMs / 2))));
    this.idleTimer.unref?.();
  }

  async session(taskId: string): Promise<BrowserSessionState> {
    const existing = this.sessions.get(taskId);
    if (existing) {
      existing.lastUsedAt = Date.now();
      return existing;
    }
    if (this.sessions.size >= MAX_SESSIONS) {
      throw new BrowserError(
        "BROWSER_SESSION_LIMIT",
        `同时最多允许 ${MAX_SESSIONS} 个浏览器任务。请等待其他任务结束，或关闭它们的浏览器会话。`
      );
    }
    const context = await this.browser.context();
    const page = await context.newPage();
    const now = new Date().toISOString();
    const tab: BrowserTab = { id: "tab-1", page, title: "", url: page.url(), createdAt: now };
    const session: BrowserSessionState = {
      taskId,
      tabs: [tab],
      activeTabId: tab.id,
      paused: false,
      lastUsedAt: Date.now(),
      assertions: [],
      steps: [],
      lastSnapshotDigest: null
    };
    this.sessions.set(taskId, session);
    return session;
  }

  async activePage(taskId: string): Promise<{ session: BrowserSessionState; tab: BrowserTab }> {
    const session = await this.session(taskId);
    if (session.paused) {
      throw new BrowserError("BROWSER_TAKEOVER", "浏览器已暂停，等你接管。接管完成后请点击“继续”。");
    }
    const tab = session.tabs.find((item) => item.id === session.activeTabId) ?? session.tabs[0];
    if (!tab) throw new BrowserError("BROWSER_TAB_MISSING", "当前任务没有可用的浏览器标签页。");
    session.activeTabId = tab.id;
    session.lastUsedAt = Date.now();
    return { session, tab };
  }

  async createTab(taskId: string, url?: string): Promise<BrowserTab> {
    const session = await this.session(taskId);
    if (session.tabs.length >= MAX_TABS) {
      throw new BrowserError("BROWSER_TAB_LIMIT", `每个任务最多 ${MAX_TABS} 个标签页。`);
    }
    const context = await this.browser.context();
    const page = await context.newPage();
    if (url) await page.goto(url, { waitUntil: "domcontentloaded" });
    const tab: BrowserTab = {
      id: `tab-${session.tabs.length + 1}`,
      page,
      title: await page.title().catch(() => ""),
      url: page.url(),
      createdAt: new Date().toISOString()
    };
    session.tabs.push(tab);
    session.activeTabId = tab.id;
    session.lastUsedAt = Date.now();
    return tab;
  }

  async activateTab(taskId: string, tabId: string): Promise<BrowserTab> {
    const session = await this.session(taskId);
    const tab = session.tabs.find((item) => item.id === tabId);
    if (!tab) throw new BrowserError("BROWSER_TAB_NOT_FOUND", `找不到标签页：${tabId}`);
    session.activeTabId = tab.id;
    session.lastUsedAt = Date.now();
    await tab.page.bringToFront().catch(() => undefined);
    return tab;
  }

  async closeTab(taskId: string, tabId: string): Promise<void> {
    const session = await this.session(taskId);
    const tab = session.tabs.find((item) => item.id === tabId);
    if (!tab) throw new BrowserError("BROWSER_TAB_NOT_FOUND", `找不到标签页：${tabId}`);
    session.tabs = session.tabs.filter((item) => item.id !== tabId);
    if (session.activeTabId === tabId) session.activeTabId = session.tabs[0]?.id ?? null;
    await tab.page.close().catch(() => undefined);
    session.lastUsedAt = Date.now();
  }

  pause(taskId: string): boolean {
    const session = this.sessions.get(taskId);
    if (!session) return false;
    session.paused = true;
    session.lastUsedAt = Date.now();
    return true;
  }

  resume(taskId: string): boolean {
    const session = this.sessions.get(taskId);
    if (!session) return false;
    session.paused = false;
    session.lastUsedAt = Date.now();
    return true;
  }

  has(taskId: string): boolean {
    return this.sessions.has(taskId);
  }

  state(taskId: string): BrowserSessionState | null {
    return this.sessions.get(taskId) ?? null;
  }

  activeTab(taskId: string): BrowserTab | null {
    const session = this.sessions.get(taskId);
    if (!session) return null;
    return session.tabs.find((item) => item.id === session.activeTabId) ?? session.tabs[0] ?? null;
  }

  async release(taskId: string): Promise<void> {
    const session = this.sessions.get(taskId);
    if (!session) return;
    this.sessions.delete(taskId);
    await Promise.all(session.tabs.map((tab) => tab.page.close().catch(() => undefined)));
  }

  async releaseAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((taskId) => this.release(taskId)));
  }

  stop(): void {
    clearInterval(this.idleTimer);
  }
}
