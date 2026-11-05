import { loadCodexProfile, describeCodexProfile } from "@hearth/codex-executor";
import { buildServer } from "./app.ts";
import { HOST, PORT } from "./config.ts";

const app = await buildServer({ logger: true, startScheduler: true });

try {
  const address = await app.listen({ host: HOST, port: PORT });
  const profile = loadCodexProfile();
  console.log(`Hearth 已启动：${address}`);
  console.log(`Codex 执行器：${describeCodexProfile(profile)}（${profile.authSource}）`);
  if (!profile.canRun) console.warn(`Codex 当前不可用：${profile.issues.join("；")}`);
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  app.log.info(`收到 ${signal}，正在关闭 Hearth`);
  await app.close();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
