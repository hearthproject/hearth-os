#!/usr/bin/env node
import assert from "node:assert/strict";
import { execSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const artifactsDir = mkdtempSync(join(tmpdir(), "hearth-e2e-artifacts-"));
const dataRoot = mkdtempSync(join(tmpdir(), "hearth-e2e-root-"));
const dataDir = join(dataRoot, ".hearth");
mkdirSync(dataDir, { recursive: true });
const keep = process.env.HEARTH_E2E_KEEP === "1";
const headed = process.env.HEARTH_E2E_HEADED === "1";
let server = null;
let browser = null;
let failed = 0;
let passed = 0;
let serverLog = "";

function log(message) {
  console.log(message);
}

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function waitForServer(baseUrl, child) {
  const deadline = Date.now() + 60_000;
  let lastError = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited with code ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return await response.json();
    } catch (error) {
      lastError = error;
    }
    await sleep(500);
  }
  throw new Error(`server did not become ready: ${lastError instanceof Error ? lastError.message : "timeout"}`);
}

async function api(baseUrl, path, init = {}) {
  const headers = {
    ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
    ...(init.headers ?? {})
  };
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
  const text = await response.text();
  let body = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // Keep raw text for diagnostics.
  }
  return { status: response.status, body, text };
}

function screenshotName(name) {
  return name.replace(/[^a-z0-9\u4e00-\u9fff]+/gi, "-").replace(/^-|-$/g, "") || "failure";
}

function skipTest(name, reason) {
  log(`  skip - ${name} (${reason})`);
}

async function runTest(page, name, fn) {
  try {
    if (server && server.exitCode !== null) throw new Error(`server exited before test (code ${server.exitCode})`);
    await fn();
    passed += 1;
    log(`  ok - ${name}`);
  } catch (error) {
    failed += 1;
    log(`  FAIL - ${name}`);
    log(`    ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    try {
      const file = join(artifactsDir, `${screenshotName(name)}.png`);
      await page.screenshot({ path: file, fullPage: true });
      log(`    screenshot: ${file}`);
    } catch {
      // Ignore screenshot failures.
    }
  }
}

async function waitForComposerReady(page) {
  const composer = page.locator('textarea[aria-label="消息"]');
  await composer.waitFor({ state: "visible", timeout: 15_000 });
  await page.locator(".composer-send").waitFor({ state: "attached", timeout: 15_000 });
}

async function openNewChat(page, baseUrl) {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.evaluate(() => localStorage.removeItem("hearth.conversation"));
  await page.reload({ waitUntil: "networkidle" });
  await page.locator(".message-list").waitFor({ timeout: 15_000 });
  await waitForComposerReady(page);
}

async function newChat(page, baseUrl) {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.locator(".new-chat-button").click();
  await page.locator(".message-list").waitFor({ timeout: 15_000 });
  await waitForComposerReady(page);
}

async function sendMessage(page, text) {
  const composer = page.locator('textarea[aria-label="消息"]');
  await composer.fill(text);
  await page.locator(".composer-send").click();
}

async function waitForAssistantDone(page, timeout = 180_000) {
  await page.locator(".assistant-bubble:not(.streaming)").last().waitFor({ timeout });
  await page.waitForFunction(() => {
    const bubbles = [...document.querySelectorAll(".assistant-bubble:not(.streaming)")];
    return bubbles.some((bubble) => (bubble.textContent ?? "").trim().length > 0);
  }, null, { timeout });
  const error = page.locator(".composer-error");
  if (await error.count()) {
    const text = await error.first().innerText();
    if (text.trim()) throw new Error(`chat reported an error: ${text.trim()}`);
  }
}

async function waitForInlineRun(page, timeout = 60_000) {
  await page.locator(".inline-run").last().waitFor({ timeout });
  await page.locator(".inline-run-headline").last().waitFor({ timeout });
}

async function conversationTasks(baseUrl, page) {
  const conversationId = await page.evaluate(() => localStorage.getItem("hearth.conversation"));
  assert.ok(conversationId, "conversation id should be stored");
  const detail = await api(baseUrl, `/api/conversations/${encodeURIComponent(conversationId)}`);
  assert.equal(detail.status, 200, detail.text);
  return detail.body.tasks;
}

async function cancelTask(baseUrl, taskId) {
  await api(baseUrl, `/api/tasks/${encodeURIComponent(taskId)}/cancel`, { method: "POST" }).catch(() => undefined);
}

async function main() {
  if (process.env.HEARTH_E2E_SKIP_BUILD !== "1") {
    log("Building web app...");
    execSync("npm run build", { cwd: repoRoot, stdio: "inherit" });
  } else if (!existsSync(join(repoRoot, "apps/web/dist/index.html"))) {
    throw new Error("apps/web/dist is missing; run npm run build or unset HEARTH_E2E_SKIP_BUILD");
  }

  const modelSource = process.env.HEARTH_E2E_MODEL_SETTINGS ?? join(repoRoot, ".hearth", "model-settings.json");
  const modelFilePresent = process.env.HEARTH_E2E_OFFLINE !== "1" && existsSync(modelSource);
  if (modelFilePresent) {
    copyFileSync(modelSource, join(dataDir, "model-settings.json"));
    log("Live model settings copied into the isolated data directory.");
  } else {
    log("No live model settings found; live chat tests will be skipped.");
  }

  const port = Number(process.env.HEARTH_E2E_PORT ?? await freePort());
  const baseUrl = `http://127.0.0.1:${port}`;
  const serverEnv = {
    ...process.env,
    HEARTH_ROOT: dataRoot,
    HEARTH_WEB_DIST: join(repoRoot, "apps", "web", "dist"),
    HEARTH_HOST: "127.0.0.1",
    HEARTH_PORT: String(port),
    HEARTH_EXECUTOR_DETECT: "off"
  };
  delete serverEnv.HEARTH_DATA_DIR;
  server = spawn(process.execPath, [join(repoRoot, "node_modules/tsx/dist/cli.mjs"), join(repoRoot, "apps/server/src/index.ts")], {
    cwd: repoRoot,
    env: serverEnv,
    stdio: ["ignore", "pipe", "pipe"]
  });
  server.stdout.on("data", (chunk) => { serverLog += chunk.toString(); });
  server.stderr.on("data", (chunk) => { serverLog += chunk.toString(); });
  server.on("exit", (code, signal) => { serverLog += `\n[server exited code=${code} signal=${signal}]\n`; });

  const health = await waitForServer(baseUrl, server);
  const live = Boolean(health.chatModel?.configured);
  const startupExecutors = await api(baseUrl, "/api/executors");
  const startupDefaults = await api(baseUrl, "/api/conversation-defaults");
  const canCreateTasks = startupExecutors.status === 200 && startupDefaults.status === 200
    && startupExecutors.body.executors.some(
      (executor) => executor.health.canRun && startupDefaults.body.settings.executorEnabled[executor.id]
    );
  log(`Server ready at ${baseUrl}; live chat ${live ? "enabled" : "disabled"}; task scenarios ${live && canCreateTasks ? "enabled" : "skipped"}.`);

  browser = await chromium.launch({ headless: !headed });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "zh-CN" });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      const location = message.location();
      consoleErrors.push(location.url ? `${message.text()} @ ${location.url}` : message.text());
    }
  });
  page.on("pageerror", (error) => consoleErrors.push(error.message));

  log("Running E2E scenarios...");

  if (!live) {
    await runTest(page, "shows first-run setup and can skip into chat", async () => {
      const reset = await api(baseUrl, "/api/onboarding/reset", { method: "POST" });
      assert.equal(reset.status, 200, reset.text);
      await page.goto(baseUrl, { waitUntil: "networkidle" });
      await page.waitForURL("**/welcome", { timeout: 15_000 });
      await page.locator(".wizard-card").waitFor({ timeout: 15_000 });
      await page.getByRole("button", { name: "暂时跳过" }).click();
      await page.locator(".message-list").waitFor({ timeout: 15_000 });
    });
  } else {
    skipTest("first-run setup wizard", "live model settings already satisfy onboarding");
  }
  await api(baseUrl, "/api/onboarding/complete", {
    method: "POST",
    body: JSON.stringify({ skipped: true })
  });

  await runTest(page, "boots the chat shell without page errors", async () => {
    await openNewChat(page, baseUrl);
    assert.match(await page.title(), /Hearth/);
    assert.equal(await page.locator(".message-list").count(), 1, "chat canvas should render");
    assert.ok(await page.locator('textarea[aria-label="消息"]').isVisible(), "composer should be ready");
    assert.equal(await page.locator(".composer-send").count(), 1, "send control should exist");
    assert.equal(await page.locator(".composer-executor select").count(), 1, "executor select should live in the composer");
    assert.equal(await page.locator(".composer-options-trigger").count(), 0, "the retired options panel must stay gone");
  });

  await runTest(page, "opens and closes the model popover", async () => {
    await openNewChat(page, baseUrl);
    const trigger = page.locator(".composer-model");
    await trigger.click();
    await page.locator(".composer-model-popover").waitFor({ timeout: 15_000 });
    assert.equal(await trigger.getAttribute("aria-expanded"), "true");
    assert.equal(await page.locator('.composer-model-popover input[aria-label="选择推理强度"]').count(), 1, "reasoning slider should be inside the popover");
    assert.equal(await page.locator(".model-context-usage").count(), 1, "context usage should be visible");
    await page.locator(".composer-model-backdrop").click();
    await page.locator(".composer-model-popover").waitFor({ state: "hidden", timeout: 15_000 });
    assert.equal(await trigger.getAttribute("aria-expanded"), "false");
  });

  await runTest(page, "shows a connection warning only when something is unavailable", async () => {
    const executors = await api(baseUrl, "/api/executors");
    assert.equal(executors.status, 200, executors.text);
    const defaults = await api(baseUrl, "/api/conversation-defaults");
    assert.equal(defaults.status, 200, defaults.text);
    const healthResponse = await api(baseUrl, "/api/health");
    assert.equal(healthResponse.status, 200, healthResponse.text);
    const anyReadyEnabled = executors.body.executors.some(
      (executor) => executor.health.canRun && defaults.body.settings.executorEnabled[executor.id]
    );
    const modelReady = Boolean(healthResponse.body.chatModel?.configured);
    const degraded = !modelReady || !anyReadyEnabled;
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.waitForFunction(
      (expected) => Boolean(document.querySelector('[data-connection-state="degraded"]')) === expected,
      degraded,
      { timeout: 15_000 }
    );
    if (degraded) {
      const text = await page.locator('[data-connection-state="degraded"]').innerText();
      assert.match(text, modelReady ? /执行器不可用/ : /聊天模型未配置/);
    } else {
      assert.equal(await page.locator('[data-connection-state="degraded"]').count(), 0);
    }
    if (!modelReady) {
      const notice = await page.locator(".chat-notice.warn").first().innerText();
      assert.match(notice, /首次设置/, "the offline notice should explain the setup path");
      assert.match(notice, /可用的执行器/, "the notice must not promise execution the composer blocks");
    }
  });

  await runTest(page, "keeps primary destinations and discloses the rest", async () => {
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    const nav = page.locator(".nav").first();
    for (const label of ["聊天", "资料库", "Context"]) {
      assert.equal(await nav.getByRole("link", { name: label, exact: true }).count(), 1, `${label} should be a primary link`);
    }
    assert.equal(await page.getByRole("link", { name: "设置", exact: true }).count(), 1, "settings should stay reachable");
    if (await page.locator("#nav-more").count() === 0) {
      await page.locator(".nav-more-toggle").click();
    }
    await page.locator("#nav-more").waitFor({ timeout: 15_000 });
    for (const label of ["邮件", "定时任务", "连接"]) {
      assert.equal(await page.locator("#nav-more").getByRole("link", { name: label, exact: true }).count(), 1, `${label} should be a secondary link`);
    }

    await page.keyboard.press("Control+k");
    await page.locator(".command-dialog").waitFor({ timeout: 15_000 });
    for (const label of ["聊天", "资料库", "Context", "邮件", "定时任务", "连接", "设置"]) {
      assert.equal(await page.locator(".command-group").getByRole("button", { name: label, exact: true }).count(), 1, `${label} should be searchable`);
    }
    await page.keyboard.press("Escape");
    await page.locator(".command-dialog").waitFor({ state: "hidden", timeout: 15_000 });

    for (const legacy of ["/inbox", "/tasks", "/tasks/missing"]) {
      await page.goto(`${baseUrl}${legacy}`, { waitUntil: "networkidle" });
      assert.equal(new URL(page.url()).pathname, "/", `${legacy} should redirect to the chat surface`);
      await page.locator(".chat-main").waitFor({ timeout: 15_000 });
    }
    for (const legacy of ["/knowledge", "/memory"]) {
      await page.goto(`${baseUrl}${legacy}`, { waitUntil: "networkidle" });
      assert.equal(new URL(page.url()).pathname, "/library", `${legacy} should redirect to the library`);
      await page.locator(".library-page").waitFor({ timeout: 15_000 });
    }
    await page.goto(`${baseUrl}/dossier`, { waitUntil: "networkidle" });
    assert.equal(new URL(page.url()).pathname, "/settings", "/dossier should redirect into settings");
    assert.equal(new URL(page.url()).searchParams.get("tab"), "dossier");
  });

  await runTest(page, "renders the Context page", async () => {
    const memory = await api(baseUrl, "/api/memory");
    assert.equal(memory.status, 200, memory.text);
    await page.goto(`${baseUrl}/context`, { waitUntil: "networkidle" });
    await page.locator(".context-page").waitFor({ timeout: 15_000 });
    assert.equal((await page.locator(".context-page .page-head h1").innerText()).trim(), "Context");
  });

  await runTest(page, "renders the library browser and its category roots", async () => {
    const tree = await api(baseUrl, "/api/library/tree?depth=1");
    assert.equal(tree.status, 200, tree.text);
    await page.goto(`${baseUrl}/library`, { waitUntil: "networkidle" });
    await page.locator(".library-page").waitFor({ timeout: 15_000 });
    assert.equal(await page.locator(".library-layout").count(), 1);
    const pane = page.locator(".library-pane.library-browser");
    assert.ok(await pane.isVisible(), "the browser pane should be visible");
    for (const root of ["记忆", "资料", "技能", "项目"]) {
      assert.match(await pane.innerText(), new RegExp(root), `the tree should expose the ${root} root`);
    }
    assert.ok(!/任务/.test(await pane.innerText()), "task nodes stay out of the library surface");
    assert.equal((await page.locator(".library-total").innerText()).trim(), "还没有资料");
  });

  await runTest(page, "lists and deletes a schedule from the schedules page", async () => {
    const created = await api(baseUrl, "/api/schedules", {
      method: "POST",
      body: JSON.stringify({ name: "E2E 定时计划", prompt: "检查工作区并汇报", cron: "0 9 * * *" })
    });
    assert.equal(created.status, 201, created.text);
    await page.goto(`${baseUrl}/schedules`, { waitUntil: "networkidle" });
    await page.locator(".schedules-page").waitFor({ timeout: 15_000 });
    const card = page.locator(".schedule-card").filter({ hasText: "E2E 定时计划" });
    await card.waitFor({ timeout: 15_000 });
    assert.equal(await page.locator(".empty-panel").count(), 0, "a created schedule should replace the empty state");
    assert.equal(await card.locator(".schedule-state-dot.online").count(), 1, "enabled schedules should look online");
    page.once("dialog", (dialog) => void dialog.accept());
    await card.getByRole("button", { name: "删除" }).click();
    await card.waitFor({ state: "detached", timeout: 15_000 });
    const remaining = await api(baseUrl, "/api/schedules");
    assert.equal(remaining.body.schedules.length, 0);
  });

  await runTest(page, "returns empty task turns and a safe rewind error", async () => {
    const created = await api(baseUrl, "/api/tasks", {
      method: "POST",
      body: JSON.stringify({
        title: "E2E turns",
        goal: "验证逐轮接口的空状态与错误",
        executorId: "native",
        taskKind: "general",
        expectedOutputs: ["result.md"]
      })
    });
    assert.equal(created.status, 201, created.text);
    const taskId = created.body.id;
    const turns = await api(baseUrl, `/api/tasks/${encodeURIComponent(taskId)}/turns`);
    assert.equal(turns.status, 200, turns.text);
    assert.deepEqual(turns.body.turns, []);
    const rewind = await api(baseUrl, `/api/tasks/${encodeURIComponent(taskId)}/rewind`, {
      method: "POST",
      body: JSON.stringify({ runId: "missing-run", turn: 1 })
    });
    assert.equal(rewind.status, 404, rewind.text);
    assert.equal(rewind.body.error, "RUN_NOT_FOUND");
    await cancelTask(baseUrl, taskId);
  });

  if (!health.chatModel?.configured) {
    await runTest(page, "reports a missing chat model before the first real task", async () => {
      const verify = await api(baseUrl, "/api/onboarding/verify", { method: "POST" });
      assert.equal(verify.status, 409, verify.text);
      assert.equal(verify.body.error, "CHAT_MODEL_MISSING");
    });
  } else {
    skipTest("missing chat model first-task guard", "live model settings are configured");
  }

  await runTest(page, "ignores Enter while the IME is composing", async () => {
    await newChat(page, baseUrl);
    const composer = page.locator('textarea[aria-label="消息"]');
    await composer.fill("你好");
    await composer.evaluate((element) => {
      element.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        bubbles: true,
        cancelable: true,
        isComposing: true
      }));
    });
    await sleep(500);
    assert.equal(await composer.inputValue(), "你好");
    assert.equal(await page.locator(".message-bubble").count(), 0);
    await composer.fill("");
  });

  if (live) {
    await runTest(page, "streams a live model reply and persists it after reload", async () => {
      await newChat(page, baseUrl);
      await sendMessage(page, "你好，请用一句话介绍你自己。");
      await waitForAssistantDone(page);
      assert.equal(await page.locator(".inline-run").count(), 0, "a greeting should not create a task");
      const text = await page.locator(".assistant-bubble:not(.streaming)").last().innerText();
      assert.ok(text.trim().length > 0);
      await page.reload({ waitUntil: "networkidle" });
      await page.locator(".assistant-bubble:not(.streaming)").last().waitFor({ timeout: 20_000 });
      assert.ok((await page.locator(".message-bubble").count()) >= 2);
    });

    await runTest(page, "keeps a method question out of the task executor", async () => {
      await newChat(page, baseUrl);
      await sendMessage(page, "怎么测试这个函数？");
      await waitForAssistantDone(page);
      assert.equal(await page.locator(".inline-run").count(), 0, "method questions must stay in chat");
    });
  } else {
    skipTest("live model reply", "no chat model configured");
    skipTest("method question stays in chat", "no chat model configured");
  }

  if (live && canCreateTasks) {
    await runTest(page, "creates an inline run, shows its trail, and cancels it", async () => {
      await newChat(page, baseUrl);
      await sendMessage(page, "帮我生成本周工作周报，并保存为 weekly.md");
      await waitForInlineRun(page);
      const tasks = await conversationTasks(baseUrl, page);
      assert.ok(tasks.length >= 1, "conversation should contain a task");
      const task = tasks.at(-1);
      const headline = await page.locator(".inline-run-headline").last().innerText();
      assert.ok(headline.trim().length > 0, "the inline run should show a status headline");
      await page.locator(".inline-run-head").last().click();
      assert.equal(await page.locator(".inline-run").last().getAttribute("class"), `inline-run ${task.status}`);
      await cancelTask(baseUrl, task.id);
    });

    await runTest(page, "turns an attachment-only message into a task", async () => {
      await newChat(page, baseUrl);
      await page.locator('input[type="file"]').setInputFiles({
        name: "notes.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("E2E attachment body")
      });
      await page.locator(".attachment-chip").waitFor({ timeout: 15_000 });
      await page.locator(".composer-send").click();
      await waitForInlineRun(page);
      assert.equal(await page.locator(".composer-error").count(), 0, "attachment-only messages must not ask for a chat model");
      const tasks = await conversationTasks(baseUrl, page);
      assert.ok(tasks.length >= 1);
      await cancelTask(baseUrl, tasks.at(-1).id);
    });
  } else {
    skipTest("inline run creation and attachment routing", "live model or task executor is unavailable");
  }

  await runTest(page, "switches and deletes conversations, and recovers a stale selection", async () => {
    const first = await api(baseUrl, "/api/conversations", {
      method: "POST",
      body: JSON.stringify({ title: "E2E 对话 A" })
    });
    const second = await api(baseUrl, "/api/conversations", {
      method: "POST",
      body: JSON.stringify({ title: "E2E 对话 B" })
    });
    assert.equal(first.status, 201, first.text);
    assert.equal(second.status, 201, second.text);
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.reload({ waitUntil: "networkidle" });
    const itemA = page.locator(".conversation-row").filter({ hasText: "E2E 对话 A" });
    const itemB = page.locator(".conversation-row").filter({ hasText: "E2E 对话 B" });
    await itemA.waitFor({ timeout: 15_000 });
    await itemA.locator(".conversation-select").click();
    await page.waitForFunction(() => document.querySelector(".chat-header h1")?.textContent === "E2E 对话 A");
    await itemB.locator(".conversation-select").click();
    await page.waitForFunction(() => document.querySelector(".chat-header h1")?.textContent === "E2E 对话 B");
    page.once("dialog", (dialog) => void dialog.accept());
    await itemB.locator(".conversation-delete").click();
    await itemB.waitFor({ state: "detached", timeout: 15_000 });

    await page.evaluate(() => localStorage.setItem("hearth.conversation", "missing-conversation-id"));
    await page.reload({ waitUntil: "networkidle" });
    await page.locator(".message-list").waitFor({ timeout: 15_000 });
    await page.waitForFunction(() => localStorage.getItem("hearth.conversation") === null);
    await page.locator(".composer-error").waitFor({ timeout: 15_000 });
    assert.match(await page.locator(".composer-error").innerText(), /失效/);
  });

  await runTest(page, "saves the preferred executor without forcing an approval mode", async () => {
    await page.goto(`${baseUrl}/settings`, { waitUntil: "networkidle" });
    await page.locator(".settings-tabs").waitFor();
    await page.locator("summary").filter({ hasText: "执行器管理" }).click();
    await page.locator(".executor-card").first().waitFor({ timeout: 15_000 });
    await page.locator("label").filter({ hasText: "全局优先执行器" }).locator("select").selectOption("native");
    await page.getByRole("button", { name: "保存执行器设置" }).click();
    await page.locator(".settings-notice.ok").waitFor({ timeout: 15_000 });
    assert.match(await page.locator(".settings-notice.ok").innerText(), /已保存/);

    const saved = await api(baseUrl, "/api/executor-settings");
    assert.equal(saved.body.settings.preferredExecutorId, "native");

    await page.reload({ waitUntil: "networkidle" });
    await page.locator("summary").filter({ hasText: "执行器管理" }).click();
    await page.locator(".executor-card").first().waitFor({ timeout: 15_000 });
    assert.equal(await page.locator("label").filter({ hasText: "全局优先执行器" }).locator("select").inputValue(), "native");
  });

  await runTest(page, "uses the global preferred executor for a new chat", async () => {
    await newChat(page, baseUrl);
    assert.equal(await page.locator('select[aria-label="选择执行器"]').inputValue(), "native");
    const defaults = await api(baseUrl, "/api/conversation-defaults");
    assert.equal(defaults.body.settings.preferredExecutorId, "native");
  });

  await runTest(page, "masks and clears model keys and clears a deleted chat profile", async () => {
    const registryBefore = await api(baseUrl, "/api/model-registry");
    const originalChat = registryBefore.body.chatProfileId;
    const created = await api(baseUrl, "/api/model-profiles", {
      method: "POST",
      body: JSON.stringify({
        name: "E2E 临时档案",
        providerId: "custom",
        providerName: "E2E",
        protocol: "openai-chat",
        baseUrl: "https://e2e.example.com/v1",
        model: "e2e-model",
        apiKey: "sk-e2e-secret-123456"
      })
    });
    assert.equal(created.status, 201, created.text);
    const profileId = created.body.profile.id;
    assert.equal(created.body.profile.hasApiKey, true);

    await page.goto(`${baseUrl}/settings`, { waitUntil: "networkidle" });
    await page.locator(".settings-tab").filter({ has: page.locator("strong", { hasText: /^模型$/ }) }).click();
    const card = page.locator(".model-card").filter({ hasText: "E2E 临时档案" });
    await card.waitFor({ timeout: 15_000 });
    const cardText = await card.innerText();
    assert.ok(!cardText.includes("sk-e2e-secret-123456"), "the raw key must never reach the UI");
    assert.match(cardText, /sk-e/);

    const cleared = await api(baseUrl, `/api/model-profiles/${encodeURIComponent(profileId)}`, {
      method: "PATCH",
      body: JSON.stringify({ apiKey: "" })
    });
    assert.equal(cleared.status, 200, cleared.text);
    assert.equal(cleared.body.profile.hasApiKey, false);
    await page.reload({ waitUntil: "networkidle" });
    await page.locator(".settings-tab").filter({ has: page.locator("strong", { hasText: /^模型$/ }) }).click();
    await page.locator(".model-card").filter({ hasText: "E2E 临时档案" }).waitFor({ timeout: 15_000 });
    assert.match(await page.locator(".model-card").filter({ hasText: "E2E 临时档案" }).innerText(), /未设置/);

    const selected = await api(baseUrl, "/api/model-registry/chat-profile", {
      method: "PUT",
      body: JSON.stringify({ profileId })
    });
    assert.equal(selected.status, 200, selected.text);
    const deleted = await api(baseUrl, `/api/model-profiles/${encodeURIComponent(profileId)}`, { method: "DELETE" });
    assert.equal(deleted.status, 204, deleted.text);
    const registryAfter = await api(baseUrl, "/api/model-registry");
    assert.equal(registryAfter.body.chatProfileId, null);

    if (originalChat) {
      const restored = await api(baseUrl, "/api/model-registry/chat-profile", {
        method: "PUT",
        body: JSON.stringify({ profileId: originalChat })
      });
      assert.equal(restored.status, 200, restored.text);
    }
  });

  await runTest(page, "rejects local model endpoints with a client error", async () => {
    const response = await api(baseUrl, "/api/model-settings", {
      method: "PUT",
      body: JSON.stringify({
        providerName: "Local",
        baseUrl: "http://127.0.0.1:11434/v1",
        model: "qwen"
      })
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error, "LOCAL_MODEL_NOT_MANAGED");
  });

  await runTest(page, "persists the DeepSeek Harness executor and retires task deep links", async () => {
    const created = await api(baseUrl, "/api/tasks", {
      method: "POST",
      body: JSON.stringify({
        title: "E2E DSH 标签",
        goal: "仅用于验证任务详情标签",
        executorId: "deepseek-harness",
        taskKind: "general",
        expectedOutputs: ["result.md"]
      })
    });
    assert.equal(created.status, 201, created.text);
    const taskId = created.body.id;
    const detail = await api(baseUrl, `/api/tasks/${encodeURIComponent(taskId)}`);
    assert.equal(detail.status, 200, detail.text);
    assert.equal(detail.body.task.executorId, "deepseek-harness");

    await page.goto(`${baseUrl}/tasks/${encodeURIComponent(taskId)}`, { waitUntil: "networkidle" });
    assert.equal(new URL(page.url()).pathname, "/", "task detail must redirect to the chat surface");
    await page.locator(".chat-main").waitFor({ timeout: 15_000 });
    await cancelTask(baseUrl, taskId);
  });

  await runTest(page, "fits narrow viewports without horizontal overflow", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.locator(".chat-main").waitFor();
    const overflow = await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth);
    assert.ok(overflow <= 1, `page overflows by ${overflow}px`);
    await page.goto(`${baseUrl}/settings`, { waitUntil: "networkidle" });
    const settingsOverflow = await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth);
    assert.ok(settingsOverflow <= 1, `settings overflows by ${settingsOverflow}px`);
    await page.setViewportSize({ width: 1280, height: 900 });
  });

  await runTest(page, "records no unexpected browser console errors", async () => {
    const offlineExpected = [
      /503 .*\/api\/tasks\/[^/]+\/overview/, // overview needs a chat model; offline mode intentionally has none
      /503 .*\/api\/tasks\/[^/]+$/ // task reads can race the host gate during teardown
    ];
    const unexpected = consoleErrors.filter((text) => {
      if (/Failed to load resource.*404/i.test(text) || /CONVERSATION_NOT_FOUND/.test(text)) return false;
      if (!live && offlineExpected.some((pattern) => pattern.test(text))) return false;
      return true;
    });
    assert.deepEqual(unexpected, []);
  });

  log(`\nE2E result: ${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    log(`Failure artifacts: ${artifactsDir}`);
    if (serverLog.trim()) log(`\nServer log tail:\n${serverLog.slice(-8_000)}`);
    process.exitCode = 1;
  }
  if (failed === 0 && !keep) rmSync(artifactsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

try {
  await main();
} catch (error) {
  failed += 1;
  console.error("E2E harness failed:", error instanceof Error ? error.stack ?? error.message : error);
  if (serverLog.trim()) console.error(`\nServer log tail:\n${serverLog.slice(-8_000)}`);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => undefined);
  if (server) {
    server.kill();
    await Promise.race([
      new Promise((resolve) => server.once("exit", resolve)),
      sleep(5_000)
    ]);
    if (server.exitCode === null) server.kill("SIGKILL");
  }
  if (!keep) {
    rmSync(dataRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } else {
    console.log(`Kept data directory: ${dataDir}`);
  }
}
