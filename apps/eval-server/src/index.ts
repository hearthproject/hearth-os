import { loadCaseCatalog } from "@hearth/eval-core/node";
import { buildEvalApp } from "./app.ts";
import {
  ARTIFACT_ROOT,
  CASES_DIR,
  DATA_DIR,
  DB_PATH,
  EVAL_VERSION,
  HEARTH_URL,
  HOST,
  PORT,
  REPO_ROOT,
  WEB_DIST
} from "./config.ts";
import { HearthClient } from "./hearth-client.ts";
import { EvalRunner } from "./runner.ts";
import { EvalStore } from "./store.ts";

async function main(): Promise<void> {
  const loaded = loadCaseCatalog(REPO_ROOT, CASES_DIR);
  if (loaded.issues.length > 0) {
    for (const issue of loaded.issues) {
      console.error(`[eval] catalog ${issue.caseId || "catalog"}: ${issue.path}: ${issue.message}`);
    }
    throw new Error(`Case catalog validation failed with ${loaded.issues.length} issue(s)`);
  }
  if (loaded.cases.length === 0) throw new Error(`No evaluation cases found in ${CASES_DIR}`);

  const store = new EvalStore(DB_PATH);
  store.syncCases(loaded.cases);
  const recovered = store.recoverInterrupted();

  const catalog = new Map(loaded.cases.map((loadedCase) => [loadedCase.manifest.id, loadedCase]));
  const client = new HearthClient({ baseUrl: HEARTH_URL });
  const runner = new EvalRunner({
    store,
    client,
    catalog,
    repoRoot: REPO_ROOT,
    artifactRoot: ARTIFACT_ROOT,
    evalVersion: EVAL_VERSION
  });

  const app = await buildEvalApp({
    store,
    runner,
    client,
    catalog,
    catalogIssues: loaded.issues.length,
    repoRoot: REPO_ROOT,
    artifactRoot: ARTIFACT_ROOT,
    dataDir: DATA_DIR,
    evalVersion: EVAL_VERSION,
    webDist: WEB_DIST,
    logger: true
  });

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, "shutting down hearth eval");
    await app.close();
    store.close();
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ host: HOST, port: PORT });
  app.log.info({
    url: `http://${HOST}:${PORT}`,
    hearthUrl: HEARTH_URL,
    cases: loaded.cases.length,
    recoveredRuns: recovered,
    dataDir: DATA_DIR,
    artifactRoot: ARTIFACT_ROOT,
    web: WEB_DIST
  }, "hearth eval ready");
}

main().catch((error) => {
  console.error("[eval] failed to start", error);
  process.exitCode = 1;
});
