import { app, BrowserWindow, dialog } from "electron";
import { join } from "node:path";
import { createDesktopLogs, type DesktopLogs } from "./logs";
import {
  buildServerLaunch,
  defaultServerPaths,
  resolveDesktopRoot,
  ServerSupervisor,
  type DesktopMode,
  type ServerLaunch
} from "./server-process";

let supervisor: ServerSupervisor | null = null;
let mainWindow: BrowserWindow | null = null;
let logs: DesktopLogs | null = null;
let shuttingDown = false;

function resolveLaunch(): ServerLaunch {
  const mode: DesktopMode = app.isPackaged ? "prod" : "dev";
  const root = process.env.HEARTH_ROOT ?? resolveDesktopRoot(__dirname);
  const paths = defaultServerPaths(root);

  return buildServerLaunch({
    mode,
    root,
    dataDir: paths.dataDir,
    webDist: app.isPackaged ? join(process.resourcesPath, "web") : paths.webDist,
    resourcesPath: process.resourcesPath
  });
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
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: false,
      spellcheck: false
    }
  });

  window.once("ready-to-show", () => {
    window.show();
  });

  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });

  return window;
}

function logMain(message: string): void {
  logs?.main.write(`[main] ${message}`);
}

async function start(): Promise<void> {
  logs = createDesktopLogs();
  logMain("desktop shell starting");

  const launch = resolveLaunch();
  logMain(`mode=${app.isPackaged ? "prod" : "dev"} root=${launch.env.HEARTH_ROOT}`);

  supervisor = new ServerSupervisor({
    launch,
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
  }
}

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logMain("desktop shell shutting down");
  await supervisor?.stop();
  supervisor = null;
  app.quit();
}

app.whenReady().then(start).catch(async (error: unknown) => {
  dialog.showErrorBox("Hearth 启动失败", error instanceof Error ? error.message : String(error));
  await shutdown();
});

app.on("window-all-closed", () => {
  void shutdown();
});

app.on("before-quit", (event) => {
  if (shuttingDown) return;
  event.preventDefault();
  void shutdown();
});
