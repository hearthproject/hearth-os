import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { HearthStore } from "../packages/eventlog/src/index.ts";
import { computeDogfood, renderDogfoodMarkdown } from "../apps/server/src/dogfood.ts";

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

const dbPath = resolve(arg("db") ?? ".hearth/hearth.sqlite");
const days = Number(arg("days") ?? "7");
const projectId = arg("project") ?? null;
const out = resolve(arg("out") ?? `reports/dogfood-${new Date().toISOString().slice(0, 10)}.md`);
const asJson = process.argv.includes("--json");

const store = new HearthStore(dbPath);
try {
  const report = computeDogfood(store, { days, projectId });
  if (asJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, renderDogfoodMarkdown(report), "utf8");
    console.log(`Dogfood report: ${out}`);
    console.log(`Tasks ${report.totals.tasks}, completed ${report.totals.completed}, failed ${report.totals.failed}, success ${report.totals.successRate ?? "n/a"}`);
  }
} finally {
  store.db.close();
}
