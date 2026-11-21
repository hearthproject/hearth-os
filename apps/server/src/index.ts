import { loadCodexProfile, describeCodexProfile } from "@hearth/codex-executor";
import { buildServer } from "./app.ts";
import { assertRootLayout, DATA_DIR, HOST, PORT } from "./config.ts";
import { acquireDataDirLock } from "./data-lock.ts";

assertRootLayout({ requireWeb: process.env.HEARTH_DESKTOP === "1" });

const bootStartedAt = performance.now();
const dataLock = acquireDataDirLock(DATA_DIR, PORT);

const app = await buildServer({ logger: true, startScheduler: true, startMailSync: true })
  .catch((error: unknown) => {
    dataLock.release();
    throw error;
  });
const buildMs = Math.round(performance.now() - bootStartedAt);

try {
  const address = await app.listen({ host: HOST, port: PORT });
  void app.feishu.start(address).catch((error: unknown) => {
    console.error("飞书长连接启动失败：", error instanceof Error ? error.message : String(error));
  });
  const profile = loadCodexProfile();
  console.log(`Hearth 已启动：${address}（组装 ${buildMs}ms / 监听 ${Math.round(performance.now() - bootStartedAt)}ms）`);
  console.log(`Codex 执行器：${describeCodexProfile(profile)}（${profile.authSource}）`);
  if (!profile.canRun) console.warn(`Codex 当前不可用：${profile.issues.join("；")}`);
} catch (error) {
  app.log.error(error);
  dataLock.release();
  process.exitCode = 1;
}

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  app.log.info(`收到 ${signal}，正在关闭 Hearth`);
  try {
    await app.close();
  } finally {
    dataLock.release();
  }
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
