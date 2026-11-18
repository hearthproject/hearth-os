import { app, BrowserWindow, dialog } from "electron";
import type { ChildProcess } from "node:child_process";
import { join } from "node:path";
import {
  buildServerLaunch,
  defaultServerPaths,
  resolveDesktopRoot,
  spawnServer,
  stopServer,
  waitForHealth,
  type DesktopMode,
  type ServerLaunch
} from "./server-process";

let server: ChildProcess | null = null;
let mainWindow: BrowserWindow | null = null;
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

async function start(): Promise<void> {
  const launch = resolveLaunch();
  server = spawnServer(launch);

  try {
    await waitForHealth(launch.baseUrl);
  } catch (error) {
    dialog.showErrorBox(
      "Hearth 启动失败",
      error instanceof Error ? error.message : String(error)
    );
    await shutdown();
    return;
  }

  mainWindow = createWindow(launch);
  try {
    await mainWindow.loadURL(launch.baseUrl);
  } catch (error) {
    dialog.showErrorBox(
      "Hearth 页面加载失败",
      error instanceof Error ? error.message : String(error)
    );
    await shutdown();
  }
}

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await stopServer(server);
  server = null;
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
