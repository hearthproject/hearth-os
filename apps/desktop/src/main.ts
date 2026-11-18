import { app, BrowserWindow, dialog } from "electron";
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

let supervisor: ServerSupervisor | null = null;
let mainWindow: BrowserWindow | null = null;
let logs: DesktopLogs | null = null;
let shuttingDown = false;

function resolveLaunch(root: string, dataDir: string): ServerLaunch {
  const mode: DesktopMode = app.isPackaged ? "prod" : "dev";

  return buildServerLaunch({
    mode,
    root,
    dataDir,
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

  const selection = await chooseDataRoot();
  if (!selection) {
    logMain("data root selection cancelled");
    await shutdown();
    return;
  }

  logMain(`data root=${selection.root} data=${selection.dataDir}`);
  writeDesktopConfig(resolveDesktopConfigPath(), selection.root);

  const launch = resolveLaunch(selection.root, selection.dataDir);
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
