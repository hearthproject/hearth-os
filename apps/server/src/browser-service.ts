import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BrowserContext } from "playwright-core";

export interface BrowserLauncher {
  launchPersistentContext(profileDir: string, options: Record<string, unknown>): Promise<BrowserContext>;
}

export type BrowserBackend = "chrome" | "edge" | "chromium";

export interface BrowserServiceOptions {
  profileDir: string;
  headless?: boolean;
  launcher?: BrowserLauncher | undefined;
  executablePath?: string | null | undefined;
  backend?: BrowserBackend | undefined;
}

export interface BrowserStatus {
  running: boolean;
  backend: BrowserBackend | null;
  profileDir: string;
  executablePath: string | null;
  startedAt: string | null;
  pages: number;
  lastError: string | null;
}

export class BrowserError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "BrowserError";
    this.code = code;
  }
}

/**
 * Owns one persistent Chrome profile for Hearth. The profile is deliberately
 * separate from the user's daily Chrome profile: Chrome 136+ refuses remote
 * debugging on the default profile, and Hearth must never read cookies from the
 * daily browser without an explicit bridge.
 */
export class BrowserService {
  private readonly profileDir: string;
  private readonly headless: boolean;
  private readonly launcher: BrowserLauncher | undefined;
  private readonly configuredExecutable: string | null;
  private readonly configuredBackend: BrowserBackend | null;
  private browserContext: BrowserContext | null = null;
  private launchTask: Promise<BrowserContext> | null = null;
  private backend: BrowserBackend | null = null;
  private executablePath: string | null = null;
  private startedAt: string | null = null;
  private lastError: string | null = null;

  constructor(options: BrowserServiceOptions) {
    this.profileDir = options.profileDir;
    this.headless = options.headless ?? false;
    this.launcher = options.launcher;
    this.configuredExecutable = options.executablePath ?? null;
    this.configuredBackend = options.backend ?? null;
  }

  async context(): Promise<BrowserContext> {
    if (this.browserContext) return this.browserContext;
    if (this.launchTask) return this.launchTask;
    this.launchTask = this.launch().finally(() => {
      this.launchTask = null;
    });
    return this.launchTask;
  }

  async status(): Promise<BrowserStatus> {
    let pages = 0;
    if (this.browserContext) {
      try {
        pages = this.browserContext.pages().length;
      } catch {
        pages = 0;
      }
    }
    return {
      running: Boolean(this.browserContext),
      backend: this.backend,
      profileDir: this.profileDir,
      executablePath: this.executablePath,
      startedAt: this.startedAt,
      pages,
      lastError: this.lastError
    };
  }

  async close(): Promise<void> {
    const context = this.browserContext;
    this.browserContext = null;
    this.startedAt = null;
    if (context) await context.close().catch(() => undefined);
  }

  private async launch(): Promise<BrowserContext> {
    mkdirSync(this.profileDir, { recursive: true });
    const detected = this.detect();
    this.backend = this.configuredBackend ?? detected.backend;
    this.executablePath = this.configuredExecutable ?? detected.executablePath;
    const playwright = await loadPlaywright();
    const options: Record<string, unknown> = {
      headless: this.headless,
      viewport: null,
      locale: "zh-CN",
      args: ["--start-maximized", "--disable-blink-features=AutomationControlled"]
    };
    if (this.executablePath) options.executablePath = this.executablePath;
    else if (this.backend === "chrome" || this.backend === "edge") options.channel = this.backend;

    try {
      const launcher = this.launcher ?? {
        launchPersistentContext: (profileDir: string, launchOptions: Record<string, unknown>) =>
          playwright.chromium.launchPersistentContext(profileDir, launchOptions)
      };
      const context = await launcher.launchPersistentContext(this.profileDir, options);
      this.browserContext = context;
      this.startedAt = new Date().toISOString();
      this.lastError = null;
      return context;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      throw new BrowserError(
        "BROWSER_LAUNCH_FAILED",
        `无法启动浏览器：${this.lastError}。请安装 Chrome/Edge，或设置 HEARTH_BROWSER 指向可执行文件。`
      );
    }
  }

  private detect(): { backend: BrowserBackend; executablePath: string | null } {
    const requested = process.env.HEARTH_BROWSER?.trim();
    if (requested && requested !== "0" && requested !== "1" && existsSync(requested)) {
      return { backend: "chromium", executablePath: requested };
    }
    const candidates: Array<{ backend: BrowserBackend; paths: string[] }> = process.platform === "win32"
      ? [
          {
            backend: "chrome",
            paths: [
              join(process.env.ProgramFiles ?? "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
              join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
              join(process.env.LOCALAPPDATA ?? homedir(), "Google", "Chrome", "Application", "chrome.exe")
            ]
          },
          {
            backend: "edge",
            paths: [
              join(process.env.ProgramFiles ?? "C:\\Program Files", "Microsoft", "Edge", "Application", "msedge.exe"),
              join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe")
            ]
          }
        ]
      : process.platform === "darwin"
        ? [
            { backend: "chrome", paths: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"] },
            { backend: "edge", paths: ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"] }
          ]
        : [
            { backend: "chrome", paths: ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"] },
            { backend: "chromium", paths: ["/usr/bin/chromium", "/usr/bin/chromium-browser"] }
          ];
    for (const candidate of candidates) {
      const executablePath = candidate.paths.find((path) => existsSync(path));
      if (executablePath) return { backend: candidate.backend, executablePath };
    }
    // Fall back to Playwright's channel lookup; it produces a clear launch error
    // when Chrome is not installed instead of silently launching an unmanaged build.
    return { backend: this.configuredBackend ?? "chrome", executablePath: null };
  }
}

async function loadPlaywright(): Promise<typeof import("playwright-core")> {
  try {
    return await import("playwright-core");
  } catch {
    throw new BrowserError("BROWSER_ENGINE_MISSING", "浏览器引擎未安装：缺少 playwright-core。请重新运行 npm install。");
  }
}
