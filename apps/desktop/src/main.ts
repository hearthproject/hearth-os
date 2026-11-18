import { app, BrowserWindow, dialog, session, shell, type Tray } from "electron";
import { join } from "node:path";
import {
  candidateFor,
  configCandidate,
  existingCandidate,
  freshCandidate,
  resolveDesktopConfigPath,
  writeDesktopConfig,
  type DataRootCandidate
} from "./data-root";
import { createDesktopLogs, type DesktopLogs } from "./logs";
import {
  buildServerLaunch,
  ServerSupervisor,
  type DesktopMode,
  type ServerLaunch
} from "./server-process";
import { createTray } from "./tray";

const singleInstance = app.requestSingleInstanceLock();

let supervisor: ServerSupervisor | null = null;
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let logs: DesktopLogs | null = null;
let dataDir: string | null = null;
let shuttingDown = false;
let allowedOrigin = "http://127.0.0.1:4317";

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "media-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'"
].join("; ");

function isAllowedNavigation(url: string): boolean {
  return url === allowedOrigin || url.startsWith(`${allowedOrigin}/`);
}

function openExternalIfHttp(url: string): void {
  if (url.startsWith("http://") || url.startsWith("https://")) {
    void shell.openExternal(url);
  }
}

async function configureSession(): Promise<void> {
  await session.defaultSession.clearStorageData({
    storages: ["serviceworkers", "cachestorage"]
  });

  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [CONTENT_SECURITY_POLICY]
      }
    });
  });
}

function resolveLaunch(root: string, selectedDataDir: string): ServerLaunch {
  const mode: DesktopMode = app.isPackaged ? "prod" : "dev";

  return buildServerLaunch({
    mode,
    root,
    dataDir: selectedDataDir,
    webDist: app.isPackaged ? join(process.resourcesPath, "web") : join(root, "apps", "web", "dist"),
    resourcesPath: process.resourcesPath
  });
}

async function chooseDataRoot(): Promise<DataRootCandidate | null> {
  const envRoot = process.env.HEARTH_ROOT;
  if (envRoot) return candidateFor(envRoot);

  const configPath = resolveDesktopConfigPath();
  const saved = configCandidate(configPath);
  if (saved?.hasDatabase) {
    return saved;
  }

  const existing = existingCandidate();
  const fresh = freshCandidate();
  const defaultId = existing.hasDatabase ? 0 : 1;

  const message = dialog.showMessageBoxSync({
    type: "question",
    title: "选择 Hearth 数据目录",
    message: existing.hasDatabase ? "检测到现有 Hearth 数据" : "没有检测到现有 Hearth 数据库",
    detail: [
      saved ? `之前选择的数据目录没有找到 hearth.sqlite：${saved.dataDir}` : "",
      `现有数据：${existing.dataDir}${existing.hasDatabase ? "（推荐）" : "（尚未初始化）"}`,
      `新数据目录：${fresh.dataDir}`
    ].filter(Boolean).join("\n\n"),
    buttons: [
      existing.hasDatabase ? "使用现有数据（推荐）" : "使用现有目录",
      "新建数据目录",
      "退出"
    ],
    defaultId,
    cancelId: 2,
    noLink: true
  });

  if (message === 2) return null;

  const chosen = message === 0 ? existing : fresh;
  writeDesktopConfig(configPath, chosen.root);
  return chosen;
}

function createWindow(launch: ServerLaunch): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: "#0b0d10",
    title: "Hearth",
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: false,
      spellcheck: false,
      devTools: !app.isPackaged
    }
  });

  window.once("ready-to-show", () => {
    window.show();
  });

  window.on("close", (event) => {
    if (shuttingDown) return;
    event.preventDefault();
    window.hide();
    logMain("window hidden to tray");
  });

  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });

  return window;
}

function showMainWindow(): void {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function resolveTrayIcon(root: string): string {
  return app.isPackaged
    ? join(process.resourcesPath, "tray.png")
    : join(root, "docs", "public", "brand", "hearth-os-logo.png");
}

function logMain(message: string): void {
  logs?.main.write(`[main] ${message}`);
}

async function start(): Promise<void> {
  logs = createDesktopLogs();
  app.setAppUserModelId("ai.hearth.os");
  logMain("desktop shell starting");

  const selection = await chooseDataRoot();
  if (!selection) {
    logMain("data root selection cancelled");
    await shutdown();
    return;
  }

  dataDir = selection.dataDir;
  logMain(`data root=${selection.root} data=${selection.dataDir}`);
  writeDesktopConfig(resolveDesktopConfigPath(), selection.root);

  const launch = resolveLaunch(selection.root, selection.dataDir);
  allowedOrigin = new URL(launch.baseUrl).origin;
  await configureSession();
  logMain(`mode=${app.isPackaged ? "prod" : "dev"} port=${new URL(launch.baseUrl).port}`);

  supervisor = new ServerSupervisor({
    launch,
    dataDir: selection.dataDir,
    onLog: (stream, text) => {
      logs?.server.write(`[${stream}] ${text.trimEnd()}`);
    },
    onRestart: (attempt, delayMs) => {
      logMain(`server restart attempt=${attempt} delay=${delayMs}ms`);
    },
    onFatal: (message) => {
      logMain(message);
      dialog.showErrorBox("Hearth 服务端停止", message);
    }
  });

  try {
    await supervisor.start();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logMain(`startup failed: ${message}`);
    dialog.showErrorBox("Hearth 启动失败", message);
    await shutdown();
    return;
  }

  mainWindow = createWindow(launch);
  try {
    await mainWindow.loadURL(launch.baseUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logMain(`load failed: ${message}`);
    dialog.showErrorBox("Hearth 页面加载失败", message);
    await shutdown();
    return;
  }

  if (process.env.HEARTH_DESKTOP_SELF_CHECK === "1") {
    const result = await mainWindow.webContents.executeJavaScript(
      `(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        return {
          desktop: window.hearthDesktop?.isDesktop === true,
          platform: window.hearthDesktop?.platform ?? null,
          sw: "serviceWorker" in navigator
            ? (await navigator.serviceWorker.getRegistrations()).length
            : 0
        };
      })()`
    );
    logMain(`self-check ${JSON.stringify(result)}`);
  }

  tray = createTray(resolveTrayIcon(selection.root), {
    open: showMainWindow,
    openDataDir: () => {
      if (dataDir) void shell.openPath(dataDir);
    },
    openLogs: () => {
      if (logs) void shell.openPath(logs.dir);
    },
    quit: () => void shutdown()
  });
  logMain("tray created");

  const autoQuitMs = Number(process.env.HEARTH_DESKTOP_AUTO_QUIT_MS ?? 0);
  if (Number.isFinite(autoQuitMs) && autoQuitMs > 0) {
    logMain(`auto quit scheduled in ${autoQuitMs}ms`);
    setTimeout(() => void shutdown(), autoQuitMs);
  }
}

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logMain("desktop shell shutting down");
  tray?.destroy();
  tray = null;
  await supervisor?.stop();
  supervisor = null;
  app.quit();
}

if (!singleInstance) {
  app.quit();
} else {
  app.on("second-instance", () => {
    showMainWindow();
  });

  app.on("web-contents-created", (_event, contents) => {
    contents.on("will-navigate", (event, url) => {
      if (isAllowedNavigation(url)) return;
      event.preventDefault();
      openExternalIfHttp(url);
    });

    contents.setWindowOpenHandler(({ url }) => {
      openExternalIfHttp(url);
      return { action: "deny" };
    });

    contents.on("will-attach-webview", (event) => {
      event.preventDefault();
    });
  });

  app.whenReady().then(start).catch(async (error: unknown) => {
    dialog.showErrorBox("Hearth 启动失败", error instanceof Error ? error.message : String(error));
    await shutdown();
  });

  app.on("activate", () => {
    showMainWindow();
  });

  app.on("window-all-closed", () => {
    // Keep the server and tray alive; quit happens from the tray menu.
  });

  app.on("before-quit", (event) => {
    if (shuttingDown) return;
    event.preventDefault();
    void shutdown();
  });
}
