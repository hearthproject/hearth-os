import { existsSync, rmSync, writeFileSync } from "node:fs";
import { relative, resolve, join } from "node:path";
import { HearthStore } from "@hearth/eventlog";
import { DATA_DIR, DB_PATH, WORKSPACE_DIR } from "../apps/server/src/config.ts";
import { planStoragePrune } from "../apps/server/src/storage-prune.ts";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const json = args.includes("--json");
const daysArg = args[args.indexOf("--days") + 1];
const days = args.includes("--days") && daysArg ? Number(daysArg) : 7;
if (!Number.isFinite(days) || days < 0) {
  console.error("--days 必须是非负数字");
  process.exit(2);
}
if (!existsSync(DB_PATH)) {
  console.error(`找不到数据库：${DB_PATH}`);
  process.exit(1);
}

const store = new HearthStore(DB_PATH);
try {
  const plan = planStoragePrune({ store, workspaceRoot: WORKSPACE_DIR, olderThanDays: days });
  const withinRoot = (path: string): boolean => {
    const rel = relative(WORKSPACE_DIR, resolve(path));
    return !rel.startsWith("..") && !rel.startsWith("/") && !rel.startsWith("\\");
  };
  if (json) {
    console.log(JSON.stringify({
      apply,
      ...plan,
      candidates: plan.candidates.map((candidate) => ({ ...candidate, path: relative(WORKSPACE_DIR, candidate.path) })),
      files: plan.files.map((file) => ({ ...file, path: relative(WORKSPACE_DIR, file.path) }))
    }, null, 2));
  } else {
    console.log(`${apply ? "回收" : "预演"}：${plan.candidates.length} 个旧 run 目录 + ${plan.files.length} 个无引用工具输出，${formatBytes(plan.totalBytes)}，保留期 ${plan.olderThanDays} 天`);
    for (const candidate of plan.candidates) console.log(`  - ${candidate.taskId} #${candidate.attempt} ${relative(WORKSPACE_DIR, candidate.path)} ${formatBytes(candidate.bytes)}`);
    for (const file of plan.files) console.log(`  - ${file.taskId} ${relative(WORKSPACE_DIR, file.path)} ${formatBytes(file.bytes)}`);
    if (plan.pinned.length > 0) console.log(`钉住 ${plan.pinned.length} 个运行（活跃、未结算、检查点引用或未过保留期）`);
  }
  if (apply) {
    let reclaimed = 0;
    const removed: Array<{ path: string; bytes: number }> = [];
    for (const candidate of plan.candidates) {
      if (!withinRoot(candidate.path)) throw new Error(`拒绝删除工作区外的路径：${candidate.path}`);
      rmSync(candidate.path, { recursive: true, force: true });
      reclaimed += candidate.bytes;
      removed.push({ path: relative(WORKSPACE_DIR, candidate.path), bytes: candidate.bytes });
    }
    for (const file of plan.files) {
      if (!withinRoot(file.path)) throw new Error(`拒绝删除工作区外的路径：${file.path}`);
      rmSync(file.path, { force: true });
      reclaimed += file.bytes;
      removed.push({ path: relative(WORKSPACE_DIR, file.path), bytes: file.bytes });
    }
    writeFileSync(join(DATA_DIR, "storage-prune.json"), `${JSON.stringify({
      at: new Date().toISOString(),
      olderThanDays: plan.olderThanDays,
      bytes: reclaimed,
      entries: removed
    }, null, 2)}\n`, "utf8");
    console.log(`已回收 ${formatBytes(reclaimed)}`);
  } else {
    console.log("这是预演；加 --apply 才会删除。");
  }
} finally {
  store.close();
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
