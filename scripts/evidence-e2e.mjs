#!/usr/bin/env node
/**
 * Cross-repo evidence E2E:
 *   mock OpenAI-compatible SSE provider
 *   -> real Hearth OS scheduler run (write_file + finish_task)
 *   -> Hearth Eval reads the run over HTTP (manifest / exchanges / cost / verify / replay)
 *
 * Usage: node scripts/evidence-e2e.mjs
 * Exit code 0 only when every assertion passes.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir, networkInterfaces } from "node:os";
import { fileURLToPath } from "node:url";

function lanAddress() {
  const candidates = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const item of list ?? []) {
      if (item.family === "IPv4" && !item.internal) candidates.push(item.address);
    }
  }
  return candidates.find((address) => address.startsWith("10.")) ?? candidates[0] ?? "127.0.0.1";
}
const MOCK_HOST = process.env.E2E_MOCK_HOST ?? "::";
const MODEL_HOST = process.env.E2E_MODEL_HOST ?? "[::ffff:127.0.0.1]";

const OS_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const EVAL_ROOT = resolve(process.env.HEARTH_EVAL_REPO ?? "D:/App/hearth-eval");
const STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const ROOT = join(tmpdir(), `hearth-evidence-e2e-${STAMP}`);
const OS_DATA = join(ROOT, ".hearth");
const EVAL_DATA = join(ROOT, "eval-data");
const EVAL_ARTIFACTS = join(ROOT, "eval-artifacts");
const MOCK_PORT = Number(process.env.E2E_MOCK_PORT ?? 4339);
const OS_PORT = Number(process.env.E2E_OS_PORT ?? 4337);
const EVAL_PORT = Number(process.env.E2E_EVAL_PORT ?? 4338);
const OS_URL = `http://127.0.0.1:${OS_PORT}`;
const EVAL_URL = `http://127.0.0.1:${EVAL_PORT}`;

mkdirSync(OS_DATA, { recursive: true });
mkdirSync(EVAL_DATA, { recursive: true });
mkdirSync(EVAL_ARTIFACTS, { recursive: true });

const dataFile = join(OS_DATA, "model-settings.json");
writeFileSync(dataFile, JSON.stringify({
  providerId: "mock",
  providerName: "Mock Provider",
  protocol: "openai-chat",
  baseUrl: `http://${MODEL_HOST}:${MOCK_PORT}/v1`,
  model: "mock-model",
  contextWindowTokens: 32_000,
  maxOutputTokens: 4096,
  reasoningEffort: "off",
  apiKey: "e2e-key",
  updatedAt: new Date().toISOString()
}, null, 2));

writeFileSync(join(OS_DATA, "pricing.json"), JSON.stringify({
  rows: [{
    providerId: "mock",
    modelPattern: "mock-model",
    inputPerMTok: 1,
    cachedInputPerMTok: 0.5,
    cacheWritePerMTok: 1,
    outputPerMTok: 2,
    reasoningPerMTok: 2
  }]
}, null, 2));

const logs = [];
function log(line) {
  logs.push(line);
  if (process.env.E2E_VERBOSE) process.stdout.write(`${line}\n`);
}

let callCounter = 0;
function startMockProvider() {
  const server = createServer((request, response) => {
    if (request.method !== "POST" || !request.url?.includes("/chat/completions")) {
      response.writeHead(404).end("not found");
      return;
    }
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      let payload = {};
      try { payload = JSON.parse(body); } catch { /* ignore */ }
      const messages = Array.isArray(payload.messages) ? payload.messages : [];
      const toolMessages = messages.filter((message) => message.role === "tool");
      if (process.env.E2E_VERBOSE) {
        log(`mock request: ${messages.length} messages, roles=${messages.map((message) => message.role).slice(-4).join(",")} last=${JSON.stringify(messages.at(-1)).slice(0, 300)}`);
      }
      const calledTools = new Set();
      for (const message of messages) {
        for (const call of message.tool_calls ?? []) {
          if (typeof call?.function?.name === "string") calledTools.add(call.function.name);
        }
      }
      const wroteFile = calledTools.has("write_file");
      const submittedPlan = calledTools.has("submit_plan");
      const updatedTodos = calledTools.has("todo_write");
      const finished = toolMessages.some((message) => String(message.content).includes("完成") && String(message.content).includes("summary"));
      const stepTitles = ["理解任务目标与输入", "执行主要工作并写入交付物", "核对结果并收尾"];
      let toolCall;
      if (!submittedPlan) {
        toolCall = {
          index: 0,
          id: `call_plan_${++callCounter}`,
          type: "function",
          function: { name: "submit_plan", arguments: JSON.stringify({ title: "E2E 报告计划", steps: stepTitles.map((title) => ({ title })) }) }
        };
      } else if (!wroteFile) {
        const outputDirLine = messages
          .map((message) => String(message.content ?? ""))
          .join("\n")
          .match(/输出目录：\s*\n([^\n]+)/)?.[1]?.trim();
        const runSegment = outputDirLine ? outputDirLine.split(/[\\/]/).filter(Boolean).at(-1) : "unknown";
        const relativePath = `out/${runSegment}/report.md`;
        toolCall = {
          index: 0,
          id: `call_write_${++callCounter}`,
          type: "function",
          function: { name: "write_file", arguments: JSON.stringify({ path: relativePath, content: "# E2E 报告\n\n关键结论：证据链路通过。\n" }) }
        };
      } else if (!updatedTodos) {
        toolCall = {
          index: 0,
          id: `call_todo_${++callCounter}`,
          type: "function",
          function: {
            name: "todo_write",
            arguments: JSON.stringify({
              todos: stepTitles.map((content, index) => ({ id: `t${index + 1}`, content, status: "completed" }))
            })
          }
        };
      } else if (!finished) {
        toolCall = {
          index: 0,
          id: `call_finish_${++callCounter}`,
          type: "function",
          function: { name: "finish_task", arguments: JSON.stringify({ summary: "E2E 报告已写入 report.md", outputs: ["report.md"] }) }
        };
      } else {
        toolCall = null;
      }
      if (!toolCall) {
        const finalChunk = {
          id: "chatcmpl-e2e",
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: "mock-model",
          choices: [{ index: 0, delta: { role: "assistant", content: "已完成。" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1300, completion_tokens: 20, total_tokens: 1320 }
        };
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        response.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
        response.write("data: [DONE]\n\n");
        response.end();
        log("mock: responded final content");
        return;
      }
      const chunk = {
        id: "chatcmpl-e2e",
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: "mock-model",
        choices: [{ index: 0, delta: { role: "assistant", content: null, tool_calls: [toolCall] }, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 1200, completion_tokens: 80, total_tokens: 1280 }
      };
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      response.write(`data: ${JSON.stringify(chunk)}\n\n`);
      response.write("data: [DONE]\n\n");
      response.end();
      log(`mock: responded ${toolCall.function.name} (toolMessages=${toolMessages.length})`);
    });
  });
  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(MOCK_PORT, MOCK_HOST, () => resolvePromise(server));
  });
}

function spawnServer(name, cwd, args, env) {
  const child = spawn(process.platform === "win32" ? "npx.cmd" : "npx", args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    shell: process.platform === "win32"
  });
  child.stdout.on("data", (chunk) => { if (process.env.E2E_VERBOSE) log(`${name}: ${chunk.toString().trim()}`); });
  child.stderr.on("data", (chunk) => log(`${name}! ${chunk.toString().trim()}`));
  child.on("exit", (code) => log(`${name}: exited ${code}`));
  return child;
}

async function waitFor(url, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch { /* retry */ }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error(`timeout waiting for ${url}\n${logs.slice(-80).join("\n")}`);
}

async function jsonFetch(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
  if (!response.ok) {
    throw new Error(`${init?.method ?? "GET"} ${url} -> ${response.status}: ${text.slice(0, 500)}`);
  }
  return payload;
}

async function waitForTask(taskId, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await jsonFetch(`${OS_URL}/api/tasks/${taskId}`);
    const status = last.task?.status ?? last.status;
    if (["completed", "failed", "cancelled", "waiting_approval", "waiting_budget"].includes(status)) return last;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error(`task ${taskId} did not finish: ${JSON.stringify(last).slice(0, 800)}`);
}

const checks = [];
function check(name, condition, detail) {
  checks.push({ name, ok: Boolean(condition) });
  if (!condition) throw new Error(`assertion failed: ${name} :: ${String(JSON.stringify(detail ?? null)).slice(0, 800)}`);
}

function stopChild(child) {
  if (!child) return;
  if (typeof child.listen === "function") {
    child.close();
    return;
  }
  if (process.platform === "win32" && child.pid) {
    try {
      spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } catch {
      child.kill();
    }
    return;
  }
  child.kill();
}

let mock;
let os;
let evalServer;
try {
  mock = await startMockProvider();
  log(`mock provider on ${MOCK_PORT}`);
  os = spawnServer("os", OS_ROOT, ["tsx", "apps/server/src/index.ts"], {
    HEARTH_ROOT: ROOT,
    HEARTH_DATA_DIR: OS_DATA,
    HEARTH_PORT: String(OS_PORT),
    HEARTH_PRICING_FILE: join(OS_DATA, "pricing.json"),
    HEARTH_HARNESS_VARIANT: "baseline"
  });
  await waitFor(`${OS_URL}/api/health`, 120_000);

  const profile = await jsonFetch(`${OS_URL}/api/model-profiles`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "E2E Mock",
      providerId: "mock",
      providerName: "Mock Provider",
      protocol: "openai-chat",
      baseUrl: `http://${MODEL_HOST}:${MOCK_PORT}/v1`,
      model: "mock-model",
      contextWindowTokens: 32_000,
      maxOutputTokens: 4096,
      apiKey: "e2e-key"
    })
  });
  const profileId = profile.profile?.id ?? profile.id;
  check("model profile created", typeof profileId === "string", profile);
  const binding = await jsonFetch(`${OS_URL}/api/executors/native/model-binding`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ profileId })
  });
  check("native executor bound", binding.health?.canRun === true, binding.health);

  evalServer = spawnServer("eval", EVAL_ROOT, ["tsx", "apps/eval-server/src/index.ts"], {
    HEARTH_EVAL_PORT: String(EVAL_PORT),
    HEARTH_EVAL_DATA_DIR: EVAL_DATA,
    HEARTH_EVAL_ARTIFACT_ROOT: EVAL_ARTIFACTS,
    HEARTH_URL: OS_URL
  });
  await waitFor(`${EVAL_URL}/api/evidence/health`, 90_000);

  const created = await jsonFetch(`${OS_URL}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: "E2E 证据链路",
      goal: "在工作区编写 report.md，写明关键结论，然后调用 finish_task 完成。",
      executorId: "native",
      taskKind: "workspace",
      expectedOutputs: ["report.md"]
    })
  });
  const taskId = created.id ?? created.task?.id;
  check("task created", typeof taskId === "string" && taskId.length > 0, created);

  const finished = await waitForTask(taskId);
  const task = finished.task ?? finished;
  check("task completed", task.status === "completed", task.status);

  const runId = task.currentRunId ?? task.latestRunId ?? task.runId ?? finished.runId ?? finished.latestRun?.id;
  check("run id present", typeof runId === "string", { runId, keys: Object.keys(task) });

  // OS contract surface
  const manifest = await jsonFetch(`${OS_URL}/api/evidence/runs/${runId}/manifest`);
  check("OS manifest present", manifest.manifest?.runId === runId, manifest.manifest?.runId);
  check("OS manifest fingerprint valid", manifest.fingerprintValid === true, manifest.manifest?.compatibilityFingerprint);
  check("OS completeness is honest", manifest.manifest?.completeness?.status === "complete"
    || (manifest.manifest?.completeness?.status === "incomplete_provenance" && manifest.manifest?.completeness?.missing?.length > 0),
    manifest.manifest?.completeness);

  const exchanges = await jsonFetch(`${OS_URL}/api/evidence/runs/${runId}/exchanges`);
  check("OS exchanges recorded", Array.isArray(exchanges.exchanges) && exchanges.exchanges.length >= 3, exchanges.exchanges?.length);

  const evidence = await jsonFetch(`${OS_URL}/api/evidence/tasks/${taskId}/evidence`);
  check("OS task evidence", evidence.manifests?.some((item) => item.runId === runId), evidence.manifests?.map((item) => item.runId));

  const graph = await jsonFetch(`${OS_URL}/api/evidence/tasks/${taskId}/graph`);
  check("OS artifact graph", Array.isArray(graph.nodes) && graph.nodes.length > 0, graph.nodes?.length);

  const cost = await jsonFetch(`${OS_URL}/api/cost/tasks/${taskId}`);
  check("OS cost priced", Array.isArray(cost.entries) && cost.entries.length === 1 && cost.entries[0].usd > 0, cost.entries);

  const verify = await jsonFetch(`${OS_URL}/api/evidence/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      taskId,
      runId,
      spec: {
        schemaVersion: 1,
        id: "spec:e2e",
        title: "report.md 存在且包含关键结论",
        mode: "production",
        units: [
          { id: "exists", type: "file_exists", path: "report.md" },
          { id: "text", type: "text_contains", path: "report.md", contains: ["关键结论"] }
        ],
        aggregate: { mode: "all" }
      }
    })
  });
  check("OS verification passed", verify.result?.verdict === "pass", verify.result);

  const replay = await jsonFetch(`${OS_URL}/api/replay/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cassetteId: `cassette:${runId}`, mode: "strict_replay", timeoutMs: 60_000 })
  });
  check("OS strict replay matched", replay.report?.matched === true, replay.report);
  check("OS replay avoided live calls", replay.report?.providerCalls === 0 && replay.report?.toolExecutions === 0, replay.report);

  const fork = await jsonFetch(`${OS_URL}/api/runs/${runId}/fork`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ label: "e2e-fork", timeoutMs: 60_000 })
  });
  check("OS checkpoint fork created", typeof fork.forkRunId === "string" && fork.report?.origin === "checkpoint_fork", { forkRunId: fork.forkRunId, origin: fork.report?.origin, status: fork.report?.termination?.candidate?.status });
  check("OS fork has reproduction command", typeof fork.report?.reproductionCommand === "string" && fork.report.reproductionCommand.length > 0, fork.report?.reproductionCommand?.slice(0, 160));

  const selfCompare = await jsonFetch(`${OS_URL}/api/evidence/compare?left=${runId}&right=${runId}`);
  check("OS manifest self-compare is identical", selfCompare.same === true, selfCompare.components?.filter((item) => item.status !== "same"));

  const pricing = await jsonFetch(`${OS_URL}/api/evidence/pricing`);
  check("OS pricing snapshot exists", typeof pricing.id === "string" && Array.isArray(pricing.rows) && pricing.rows.length > 0, { id: pricing.id, rows: pricing.rows?.length });

  const preflight = await jsonFetch(`${OS_URL}/api/evidence/policy/preflight`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ taskId, actions: [{ tool: "write_file", paths: ["out/report.md"] }, { tool: "shell", effect: "destructive" }] })
  });
  check("OS policy preflight explains decisions", Array.isArray(preflight.actions) && preflight.actions.length === 2 &&
    preflight.actions.every((item) => typeof item.result?.reason === "string" && typeof item.result?.effectiveDecision === "string"), preflight.actions);

  const variants = await jsonFetch(`${OS_URL}/api/evidence/variants`);
  check("OS harness variants documented", Array.isArray(variants.variants) && variants.variants.length >= 3, variants.variants?.map((item) => item.id));

  // Eval read-only client + routes
  const evalManifest = await jsonFetch(`${EVAL_URL}/api/evidence/runs/${runId}/manifest`);
  check("Eval manifest matches OS", evalManifest.compatibilityFingerprint === manifest.manifest?.compatibilityFingerprint, evalManifest.compatibilityFingerprint);

  const evalBundle = await jsonFetch(`${EVAL_URL}/api/evidence/runs/${runId}/bundle?taskId=${taskId}`);
  check("Eval bundle exchanges", evalBundle.exchanges?.length === exchanges.exchanges.length, evalBundle.exchanges?.length);
  const evalCost = await jsonFetch(`${EVAL_URL}/api/evidence/cost/tasks/${taskId}`);
  const freshCost = await jsonFetch(`${OS_URL}/api/cost/tasks/${taskId}`);
  check("Eval cost matches OS", evalCost.entries?.length === freshCost.entries.length && evalCost.entries[0]?.usd === freshCost.entries[0]?.usd, { evalEntries: evalCost.entries?.length, osEntries: freshCost.entries?.length });

  const evalReplay = await jsonFetch(`${EVAL_URL}/api/evidence/replay`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ runId, mode: "strict_replay", timeoutMs: 60_000 })
  });
  check("Eval strict replay matched", evalReplay.report?.matched === true && evalReplay.strict === true, evalReplay.report);

  const evalSpec = await jsonFetch(`${EVAL_URL}/api/evidence/cases/CAL-01/verification`);
  check("Eval case verification spec compiled", evalSpec.spec?.schemaVersion === 1 && evalSpec.spec?.mode === "eval" && evalSpec.spec?.units?.length > 0, { id: evalSpec.spec?.id, units: evalSpec.spec?.units?.length });

  const evalVerifyCase = await jsonFetch(`${EVAL_URL}/api/evidence/verify-case`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ caseId: "CAL-01", workspaceRoot: OS_URL, preferOs: false })
  });
  check("Eval verify-case executes shared verifier", typeof evalVerifyCase.specDigest === "string" && evalVerifyCase.source === "local" &&
    typeof evalVerifyCase.result?.verdict === "string", { digest: evalVerifyCase.specDigest, source: evalVerifyCase.source, verdict: evalVerifyCase.result?.verdict });

  const policyLeft = {
    schemaVersion: 1, id: "e2e-left", version: "1", mode: "enforce",
    defaults: { decision: "ask" },
    rules: [{ id: "allow-work", priority: 60, match: { tools: ["write_file"], pathPatterns: ["work/**"] }, decision: "allow", reason: "workspace_write" }],
    approval: { mode: "ask", teamMode: false, recoveryPolicy: "manual", retryPolicy: "none" }
  };
  const policyRight = { ...policyLeft, id: "e2e-right", defaults: { decision: "deny" } };
  const policyCompare = await jsonFetch(`${EVAL_URL}/api/evidence/policy/compare`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ taskId, left: policyLeft, right: policyRight, actions: [{ tool: "write_file", paths: ["outside/a.md"] }] })
  });
  check("Eval policy compare forwards to OS", policyCompare.actions === 1 && Array.isArray(policyCompare.changed) && policyCompare.changed.length === 1, policyCompare);

  const gate = await jsonFetch(`${EVAL_URL}/api/evidence/regression-gate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      baseline: { experimentId: "exp:baseline", totalRuns: 10, passed: 8, passRate: 0.8, costPerVerifiedCompletion: 0.1, p95LatencyMs: 1000, safetyBlockers: 0, unexpectedNondeterminism: 0, failedCaseIds: [], manifestChangedComponents: [] },
      candidate: { experimentId: "exp:candidate", totalRuns: 10, passed: 8, passRate: 0.8, costPerVerifiedCompletion: 0.1, p95LatencyMs: 1000, safetyBlockers: 0, unexpectedNondeterminism: 0, failedCaseIds: [], manifestChangedComponents: [] }
    })
  });
  check("Eval regression gate passes stable candidate", gate.verdict === "pass" && gate.blockers?.length === 0, gate);

  const stable = await jsonFetch(`${EVAL_URL}/api/evidence/stable-subset`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      cases: [{ caseKey: "CAL-01" }, { caseKey: "CODE-01" }],
      history: [{ caseKey: "CAL-01", passed: true }, { caseKey: "CAL-01", passed: true }, { caseKey: "CAL-01", passed: true },
        { caseKey: "CODE-01", passed: true }, { caseKey: "CODE-01", passed: false }, { caseKey: "CODE-01", passed: true }]
    })
  });
  check("Eval stable subset filters flaky cases", stable.stable?.some((item) => item.caseKey === "CAL-01") === true && stable.flaky?.some((item) => item.caseKey === "CODE-01") === true, stable);

  const unknownCompare = await jsonFetch(`${EVAL_URL}/api/evidence/experiments/compare?left=x&right=y`).catch((error) => error);
  check("Eval experiment compare rejects unknown ids", unknownCompare instanceof Error && /404/.test(String(unknownCompare.message)), String(unknownCompare).slice(0, 120));

  const unknownVariant = await jsonFetch(`${EVAL_URL}/api/evidence/variants/compare?left=x&right=y`).catch((error) => error);
  check("Eval variant compare rejects unknown ids", unknownVariant instanceof Error && /404/.test(String(unknownVariant.message)), String(unknownVariant).slice(0, 120));

  const corpus = await jsonFetch(`${EVAL_URL}/api/evidence/policy/corpus`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ taskId })
  });
  check("Eval policy corpus all pass", corpus.failed === 0 && corpus.unavailable === 0, { failed: corpus.failed, unavailable: corpus.unavailable, blockers: corpus.safetyBlockers });

  const actual = await jsonFetch(`${EVAL_URL}/api/evidence/policy/${taskId}/actual`).catch(() => null);
  // OS policy view is the authority; Eval deliberately does not implement a second policy engine.
  const osActual = await jsonFetch(`${OS_URL}/api/evidence/policy/${taskId}/actual`);
  check("OS policy actual recorded", osActual.found === true, osActual);

  const compiled = await jsonFetch(`${EVAL_URL}/api/evidence/failure-cases/compile`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      runId,
      taskId,
      title: "E2E 失败转 Case 样例",
      goal: "编写 report.md",
      expectedOutputs: ["report.md"],
      primaryCause: "验证未通过：缺少关键结论"
    })
  });
  check("Eval failure case compiled", compiled.manifest?.id && compiled.contract?.state === "pending", compiled.contract);

  const advanced = await jsonFetch(`${EVAL_URL}/api/evidence/failure-cases/${encodeURIComponent(compiled.manifest.id)}/advance`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ stage: "baseline", experimentId: "exp:e2e", runId, verdict: "failed" })
  });
  check("Eval failure case advanced", advanced.contract?.state === "baseline_failed", advanced.contract);

  const casesList = await jsonFetch(`${EVAL_URL}/api/evidence/failure-cases`);
  const caseDetail = await jsonFetch(`${EVAL_URL}/api/evidence/failure-cases/${encodeURIComponent(compiled.manifest.id)}`);
  check("Eval failure case readable", Array.isArray(casesList.cases) && caseDetail.payload?.manifest?.id === compiled.manifest.id, { list: casesList.cases?.length, state: caseDetail.state });

  const stats = await jsonFetch(`${EVAL_URL}/api/evidence/experiments/does-not-exist/stats`).catch((error) => error);
  check("Eval unknown experiment handled", stats instanceof Error && /404/.test(stats.message), String(stats).slice(0, 200));

  const report = {
    ok: checks.every((item) => item.ok),
    root: ROOT,
    taskId,
    runId,
    checks: checks.map((item) => ({ name: item.name, ok: item.ok }))
  };
  writeFileSync(join(ROOT, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.ok ? 0 : 1;
} catch (error) {
  console.error(`E2E FAILED: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  console.error(`artifacts: ${ROOT}`);
  writeFileSync(join(ROOT, "report.json"), JSON.stringify({ ok: false, error: String(error), checks, logs }, null, 2));
  process.exitCode = 1;
} finally {
  for (const child of [evalServer, os, mock]) stopChild(child);
  setTimeout(() => process.exit(process.exitCode ?? 1), 1500);
}
