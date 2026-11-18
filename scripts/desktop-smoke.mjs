import { existsSync, rmSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { _electron as electron } from "playwright";

const root = path.resolve(process.env.HEARTH_SMOKE_ROOT || ".");
const executablePath = path.resolve(
  process.env.HEARTH_SMOKE_EXE || path.join(root, "release", "win-unpacked", "Hearth.exe")
);
const dataRoot = path.resolve(process.env.HEARTH_SMOKE_DATA || root);
const tempData = dataRoot !== root;
const keep = process.env.HEARTH_SMOKE_KEEP === "1";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function portFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, "127.0.0.1");
  });
}

if (!existsSync(executablePath)) {
  throw new Error(`找不到桌面应用：${executablePath}，先运行 npm run desktop:build:dir`);
}

if (!keep && tempData) rmSync(dataRoot, { recursive: true, force: true });

const env = {
  ...process.env,
  HEARTH_ROOT: dataRoot,
  HEARTH_DESKTOP_SELF_CHECK: "1",
  HEARTH_ENV_SKIP_INTRO: "1"
};

const app = await electron.launch({
  executablePath,
  args: [],
  env,
  timeout: 30_000
});

try {
  const page = await app.firstWindow({ timeout: 30_000 });
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(() => window.hearthDesktop?.isDesktop === true, { timeout: 10_000 });

  const checks = await page.evaluate(async () => {
    const health = await (await fetch("/api/health")).json();
    const conversations = await (await fetch("/api/conversations")).json();
    return {
      title: document.title,
      desktop: window.hearthDesktop?.isDesktop === true,
      platform: window.hearthDesktop?.platform ?? null,
      sw: "serviceWorker" in navigator ? (await navigator.serviceWorker.getRegistrations()).length : 0,
      healthStatus: health.status,
      conversationCount: conversations.conversations?.length ?? 0
    };
  });

  assert(checks.title.includes("Hearth"), `页面标题不正确：${checks.title}`);
  assert(checks.desktop, "preload 未注入 window.hearthDesktop");
  assert(checks.platform === "win32", `平台不正确：${checks.platform}`);
  assert(checks.sw === 0, `桌面模式仍有 ${checks.sw} 个 Service Worker`);
  assert(checks.healthStatus === "ok", `健康检查状态异常：${checks.healthStatus}`);
  assert(checks.conversationCount >= 1, "没有读到现有会话");

  console.log(`smoke ok ${JSON.stringify(checks)}`);

  await app.evaluate(({ app }) => app.quit());
  await app.waitForEvent("close", null, { timeout: 15_000 }).catch(() => {});
} finally {
  await app.close().catch(() => {});
}

let released = false;
for (let i = 0; i < 20; i += 1) {
  if (await portFree(4317)) {
    released = true;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}
assert(released, "退出后 4317 仍被占用");

if (!keep && tempData) rmSync(dataRoot, { recursive: true, force: true });
console.log("smoke cleanup ok");
