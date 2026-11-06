#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HELPER_VERSION = "0.1.0";
const DEFAULT_SERVER = "http://127.0.0.1:4317";
const DEFAULT_APPS = ["notepad"];
const CAPABILITIES = ["observe", "desktop.control", "ui.automation"];
const HERE = dirname(fileURLToPath(import.meta.url));
const POWERSHELL_SCRIPT = join(HERE, "windows.ps1");

class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

class NativeActionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "NativeActionError";
    this.code = code;
  }
}

function usage() {
  return [
    "Hearth Windows 桌面助手",
    "",
    "npm run helper:windows -- [选项]",
    "",
    "--apps notepad,calculator  允许观察和操作的应用进程（逗号分隔）",
    "--server http://127.0.0.1:4317  仅允许本机 Hearth 地址",
    "--name Workstation         在设备列表中显示的名称",
    "--config <path>            覆盖本地配置文件位置",
    "--pair                     忽略已有设备身份并重新发起配对",
    "--help                     显示这段说明"
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    apps: null,
    server: null,
    name: hostname() || "Windows workstation",
    configPath: null,
    forcePair: false,
    help: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      index += 1;
      const value = argv[index];
      if (!value) throw new Error(`${argument} 缺少值`);
      return value;
    };
    if (argument === "--apps") options.apps = parseApps(next());
    else if (argument === "--server") options.server = normalizeServer(next());
    else if (argument === "--name") options.name = next().trim();
    else if (argument === "--config") options.configPath = next();
    else if (argument === "--pair") options.forcePair = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`未知参数：${argument}`);
  }
  if (options.apps && options.apps.length === 0) throw new Error("--apps 至少需要一个应用");
  if (!options.name) throw new Error("--name 不能为空");
  return options;
}

function parseApps(value) {
  return value.split(/[,，;\s]+/).map((item) => item.trim().toLowerCase()).filter(Boolean);
}

function normalizeServer(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("--server 必须是完整 URL，例如 http://127.0.0.1:4317");
  }
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)) {
    throw new Error("桌面助手只允许连接本机 Hearth 服务");
  }
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new Error("--server 只能包含本机地址和端口");
  }
  return url.origin;
}

function defaultConfigPath() {
  const root = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
  return join(root, "Hearth", "desktop-helper.json");
}

function loadConfig(path) {
  if (!existsSync(path)) return null;
  let value;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`无法读取配置文件 ${path}；删除它或使用 --pair 重新配对`);
  }
  if (
    !value || value.version !== 1 || typeof value.deviceId !== "string" ||
    typeof value.deviceToken !== "string" || value.deviceToken.length < 32 || typeof value.server !== "string"
  ) {
    throw new Error(`配置文件 ${path} 不完整；删除它或使用 --pair 重新配对`);
  }
  return value;
}

function saveConfig(path, config) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
}

function removeConfig(path) {
  try {
    rmSync(path, { force: true });
  } catch {}
}

function createClient(baseUrl, deviceToken = null) {
  async function request(path, options = {}) {
    const headers = { accept: "application/json", ...(options.headers || {}) };
    if (deviceToken) headers.authorization = `Bearer ${deviceToken}`;
    if (options.body !== undefined) headers["content-type"] = "application/json";
    let response;
    try {
      response = await fetch(new URL(path, baseUrl), {
        method: options.method || "GET",
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(30_000)
      });
    } catch (error) {
      throw new ApiError(`无法连接 Hearth：${error instanceof Error ? error.message : String(error)}`, 0, "NETWORK_ERROR");
    }
    const text = await response.text();
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        throw new ApiError(`Hearth 返回了无法解析的响应（HTTP ${response.status}）`, response.status, "INVALID_RESPONSE");
      }
    }
    if (!response.ok) {
      const code = typeof body?.error === "string" ? body.error : "HTTP_ERROR";
      const message = typeof body?.message === "string" ? body.message : `HTTP ${response.status}`;
      throw new ApiError(message, response.status, code);
    }
    return body;
  }
  return { request };
}

function runWindowsHelper(mode, input = null) {
  if (process.platform !== "win32") throw new Error("Windows 桌面助手只能在 Windows 上运行");
  const powershell = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  if (!existsSync(powershell)) throw new Error("没有找到 Windows PowerShell 5.1");
  const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", POWERSHELL_SCRIPT, "-Mode", mode];
  if (input !== null) {
    args.push("-InputBase64", Buffer.from(JSON.stringify(input), "utf8").toString("base64"));
  }
  const result = spawnSync(powershell, args, {
    encoding: "utf8",
    maxBuffer: 12 * 1024 * 1024,
    timeout: 20_000,
    windowsHide: true
  });
  if (result.error) throw new Error(`Windows 执行层启动失败：${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`Windows 执行层退出码 ${result.status}：${(result.stderr || result.stdout || "").trim()}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout.replace(/^\uFEFF/, "").trim());
  } catch {
    throw new Error(`Windows 执行层返回了无效结果：${result.stdout.slice(0, 300)}`);
  }
  if (parsed.ok === false) throw new NativeActionError(parsed.code || "HELPER_ERROR", parsed.error || "Windows 执行失败");
  return parsed;
}

async function pairDevice(options, configPath, server) {
  const deviceToken = randomBytes(32).toString("base64url");
  const client = createClient(server);
  const started = await client.request("/api/device-pairings", {
    method: "POST",
    body: {
      name: options.name,
      version: HELPER_VERSION,
      deviceToken,
      apps: options.apps || DEFAULT_APPS,
      capabilities: CAPABILITIES
    }
  });
  if (!started?.request?.id || !started?.secret) throw new Error("Hearth 没有返回配对请求");
  console.log(`配对码：${started.request.code}`);
  console.log(`请在 Hearth 的“设备”页面批准 ${options.name}；请求 5 分钟内有效。`);
  while (Date.now() < Date.parse(started.request.expiresAt)) {
    const status = await client.request(`/api/device-pairings/${encodeURIComponent(started.request.id)}`, {
      headers: { "x-pairing-secret": started.secret }
    });
    if (status?.request?.status === "redeemed" && status.device) {
      const config = {
        version: 1,
        server,
        deviceId: status.device.id,
        deviceToken,
        deviceName: status.device.name,
        pairedAt: new Date().toISOString()
      };
      saveConfig(configPath, config);
      console.log(`已配对：${status.device.name}（${status.device.id}）`);
      return config;
    }
    if (["rejected", "expired"].includes(status?.request?.status)) {
      throw new Error(`配对请求已${status.request.status === "rejected" ? "拒绝" : "过期"}`);
    }
    await sleep(1_000);
  }
  throw new Error("配对请求已过期，请重新运行助手");
}

async function connect(options, configPath) {
  let existing = null;
  try {
    existing = loadConfig(configPath);
  } catch (error) {
    if (!options.forcePair) throw error;
  }
  const existingServer = existing ? normalizeServer(existing.server) : null;
  const server = options.server || existingServer || DEFAULT_SERVER;
  if (existing && options.server && options.server !== existingServer && !options.forcePair) {
    throw new Error(`已有设备身份绑定到 ${existingServer}。改用 --pair 连接新的服务`);
  }
  if (!existing || options.forcePair) return await pairDevice(options, configPath, server);
  const client = createClient(server, existing.deviceToken);
  try {
    await client.request("/api/device/state");
    return existing;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      removeConfig(configPath);
      throw new Error("设备令牌已失效或设备已撤销，本地身份已清除；请重新运行助手配对");
    }
    throw error;
  }
}

function commandSession(state, command) {
  return state?.sessions?.find((view) => view?.session?.id === command.sessionId)?.session || null;
}

function assertActionStillAllowed(state, command) {
  const session = commandSession(state, command);
  if (!session) throw new NativeActionError("SESSION_NOT_FOUND", "桌面会话不存在");
  if (session.status !== "active") throw new NativeActionError("SESSION_NOT_ACTIVE", "桌面会话已不在自动控制状态");
  if (session.controlEpoch !== command.controlEpoch) throw new NativeActionError("CONTROL_EPOCH_CHANGED", "桌面控制代次已经变化");
}

async function uploadObservation(client, sessionId, options = {}) {
  const targetApp = typeof options.targetApp === "string" && options.targetApp ? options.targetApp : null;
  const observation = runWindowsHelper("observe", targetApp
    ? { expectedApp: targetApp, focusTarget: true }
    : {});
  const body = {
    sessionId,
    jpegBase64: observation.jpegBase64,
    width: observation.width,
    height: observation.height,
    activeApp: observation.activeApp,
    windowTitle: observation.windowTitle || ""
  };
  if (options.commandId) body.commandId = options.commandId;
  if (targetApp) body.targetApp = targetApp;
  return await client.request("/api/device/observations", { method: "POST", body });
}

async function failCommand(client, command, error) {
  const message = error instanceof Error ? error.message : String(error);
  try {
    await client.request(`/api/device/commands/${encodeURIComponent(command.id)}/result`, {
      method: "POST",
      body: { status: "failed", error: message.slice(0, 1000) }
    });
  } catch (resultError) {
    if (!(resultError instanceof ApiError && [409, 404].includes(resultError.status))) throw resultError;
  }
  console.error(`命令失败：${message}`);
}

async function processCommand(client, command) {
  if (command.kind === "observe") {
    const targetApp = typeof command.payload?.targetApp === "string" ? command.payload.targetApp : null;
    try {
      const frame = await uploadObservation(client, command.sessionId, { commandId: command.id, targetApp });
      console.log(`已观察 ${frame.activeApp} ${frame.width}×${frame.height}（${frame.windowTitle || "未命名窗口"}）`);
    } catch (error) {
      await failCommand(client, command, error);
    }
    return;
  }

  const expectedApp = typeof command.payload?.expectedApp === "string" ? command.payload.expectedApp : null;
  try {
    const state = await client.request("/api/device/state");
    assertActionStillAllowed(state, command);
    console.log(`执行 ${command.kind}：${command.sessionId}`);
    const result = runWindowsHelper("action", {
      ...command.payload,
      kind: command.kind,
      ...(expectedApp ? { focusTarget: true } : {})
    });
    await client.request(`/api/device/commands/${encodeURIComponent(command.id)}/result`, {
      method: "POST",
      body: { status: "succeeded", result: result.result || {} }
    });
    console.log(`已完成 ${command.kind}`);
  } catch (error) {
    await failCommand(client, command, error);
    return;
  }

  try {
    const state = await client.request("/api/device/state");
    assertActionStillAllowed(state, command);
    const targetApp = command.kind === "focus" && typeof command.payload?.app === "string"
      ? command.payload.app
      : expectedApp;
    const frame = await uploadObservation(client, command.sessionId, { targetApp });
    console.log(`动作后观察 ${frame.activeApp} ${frame.width}×${frame.height}`);
  } catch (error) {
    console.warn(`动作已完成，但后续观察失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function runLoop(config) {
  const client = createClient(config.server, config.deviceToken);
  let lastHeartbeat = 0;
  let lastOnline = null;
  let running = true;
  process.once("SIGINT", () => {
    running = false;
    console.log("\n正在停止桌面助手。");
  });
  console.log(`桌面助手已连接 ${config.server}；保持此窗口打开，Ctrl+C 停止。`);
  while (running) {
    try {
      if (Date.now() - lastHeartbeat >= 10_000) {
        const state = await client.request("/api/device/heartbeat", { method: "POST" });
        lastHeartbeat = Date.now();
        const online = state?.device?.online === true;
        if (online !== lastOnline) {
          console.log(online ? "设备在线。" : "设备尚未在线。");
          lastOnline = online;
        }
      }
      const next = await client.request("/api/device/commands/next");
      if (next?.command) {
        await processCommand(client, next.command);
        continue;
      }
      await sleep(1_000);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) throw error;
      console.error(`连接异常：${error instanceof Error ? error.message : String(error)}`);
      await sleep(2_000);
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (process.platform !== "win32") throw new Error("这个助手只支持 Windows 10/11");
  const configPath = options.configPath || defaultConfigPath();
  const doctor = runWindowsHelper("doctor");
  if (!doctor.ok) throw new Error(`Windows 执行层不可用：${doctor.captureError || doctor.uiaError || "未知错误"}`);
  console.log(`执行层：截图 ${doctor.capture ? "可用" : "不可用"} · UI Automation ${doctor.uia ? "可用" : "不可用"}`);
  const config = await connect(options, configPath);
  await runLoop(config);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
