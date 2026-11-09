#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = join(repoRoot, "docs", "public", "screenshots");
const dataDir = mkdtempSync(join(tmpdir(), "hearth-readme-data-"));
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
const now = Date.now();

mkdirSync(outputDir, { recursive: true });

let server = null;
let browser = null;

try {
  server = await startServer();
  await waitForServer(server);
  await configureModelProfiles();
  seedShowcaseData();

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 1,
    locale: "zh-CN",
    colorScheme: "light"
  });
  const page = await context.newPage();

  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.evaluate((id) => localStorage.setItem("hearth.conversation", id), "readme-weekly-conversation");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".message-list").waitFor({ timeout: 20_000 });
  await page.locator(".task-status-bubble").waitFor({ timeout: 20_000 });
  await page.waitForTimeout(700);
  await dismissNotifications(page);
  await page.screenshot({ path: join(outputDir, "chat.png") });

  await page.goto(`${baseUrl}/tasks`, { waitUntil: "domcontentloaded" });
  await page.locator(".task-table").waitFor({ timeout: 20_000 });
  await page.waitForTimeout(500);
  await dismissNotifications(page);
  await page.screenshot({ path: join(outputDir, "tasks.png") });

  await page.goto(`${baseUrl}/tasks/readme-weekly`, { waitUntil: "domcontentloaded" });
  await page.locator(".task-detail-page .result-panel").waitFor({ timeout: 20_000 });
  await page.waitForTimeout(600);
  await dismissNotifications(page);
  await page.screenshot({ path: join(outputDir, "task-detail.png") });

  await page.goto(`${baseUrl}/inbox`, { waitUntil: "domcontentloaded" });
  await page.locator(".suggestion-card").first().waitFor({ timeout: 20_000 });
  await page.waitForTimeout(500);
  await dismissNotifications(page);
  await page.screenshot({ path: join(outputDir, "inbox.png") });

  await page.goto(`${baseUrl}/memory`, { waitUntil: "domcontentloaded" });
  await page.locator(".memory-card").first().waitFor({ timeout: 20_000 });
  await page.locator(".segmented button", { hasText: "全部" }).click();
  await page.locator(".memory-card").nth(2).waitFor({ timeout: 10_000 });
  await page.locator(".memory-card").first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  await dismissNotifications(page);
  await page.screenshot({ path: join(outputDir, "memory.png") });

  await page.goto(`${baseUrl}/settings`, { waitUntil: "domcontentloaded" });
  await page.locator(".settings-page").waitFor({ timeout: 20_000 });
  await page.locator("text=OpenAI · GPT-5").first().waitFor({ timeout: 20_000 });
  await page.waitForTimeout(700);
  await dismissNotifications(page);
  await page.screenshot({ path: join(outputDir, "settings.png") });

  console.log(`README screenshots written to ${outputDir}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server && server.exitCode === null) {
    server.kill();
    await Promise.race([onceExit(server), sleep(3_000)]);
  }
  rmSync(dataDir, { recursive: true, force: true });
}

async function freePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function startServer() {
  const child = spawn(process.execPath, [join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs"), join(repoRoot, "apps", "server", "src", "index.ts")], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HEARTH_HOST: "127.0.0.1",
      HEARTH_PORT: String(port),
      HEARTH_DATA_DIR: dataDir
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});
  return child;
}

async function waitForServer(child) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited with code ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await sleep(300);
  }
  throw new Error("server did not become ready");
}

async function configureModelProfiles() {
  const primary = await postJson("/api/model-profiles", {
    name: "OpenAI · GPT-5",
    providerId: "openai",
    providerName: "OpenAI",
    protocol: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-5",
    apiKey: "sk-readme-demo-not-a-real-key"
  });
  const secondary = await postJson("/api/model-profiles", {
    name: "DeepSeek · V4",
    providerId: "deepseek",
    providerName: "DeepSeek",
    protocol: "openai-chat",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    apiKey: "sk-readme-demo-secondary"
  });

  await requestJson("/api/model-registry/chat-profile", {
    method: "PUT",
    body: { profileId: primary.profile.id }
  });
  await requestJson("/api/executors/native/model-binding", {
    method: "PUT",
    body: { profileId: primary.profile.id }
  });
  await requestJson("/api/executors/codex/model-binding", {
    method: "PUT",
    body: { profileId: primary.profile.id, modelOverride: "gpt-5" }
  });
  await requestJson("/api/executors/deepseek-harness/model-binding", {
    method: "PUT",
    body: { profileId: secondary.profile.id }
  });
  await requestJson("/api/onboarding/complete", { method: "POST", body: {} });
}

async function requestJson(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: init.method ?? "GET",
    headers: { "content-type": "application/json" },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) })
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} failed (${response.status}): ${text}`);
  return text ? JSON.parse(text) : null;
}

async function postJson(path, body) {
  return requestJson(path, { method: "POST", body });
}

async function dismissNotifications(page) {
  for (let index = 0; index < 8; index += 1) {
    const closeButtons = page.locator(".notification-close");
    if ((await closeButtons.count()) === 0) return;
    await closeButtons.first().click().catch(() => {});
    await page.waitForTimeout(120);
  }
}

function seedShowcaseData() {
  const db = new DatabaseSync(join(dataDir, "hearth.sqlite"));
  db.exec("PRAGMA busy_timeout = 5000");
  const iso = (offsetMinutes) => new Date(now - offsetMinutes * 60_000).toISOString();
  const tasks = [
    {
      id: "readme-weekly",
      title: "整理本周工作周报",
      goal: "汇总本周项目进展、风险和下周计划，生成一份可以直接发送的 Markdown 周报。",
      status: "completed",
      executorId: "native",
      taskKind: "delivery",
      expectedOutputs: ["weekly-report.md"],
      nextAction: "产物已保存",
      resultSummary: "本周完成 3 项关键工作：完成 Q4 客户访谈归纳，将周会行动项同步到项目看板，完成邮件工作台的发送审批链路。共识别 2 个风险，并生成了可直接发送的周报。\n\n### 本周完成\n\n- 完成 Q4 客户访谈归纳，提炼出 3 个高频诉求。\n- 将周会行动项同步到项目看板，并补齐负责人和截止时间。\n- 完成邮件工作台的发送审批链路，真实外部动作会留下回执。\n\n### 风险与阻塞\n\n- 知识库同步在周三中断过一次，恢复后已补齐 68% 的增量。\n- 内容日历仍缺少渠道负责人确认。\n\n### 下周计划\n\n1. 完成客户访谈洞察评审。\n2. 补齐邮件模板与退信处理说明。\n3. 推进多设备同步的真实设备演练。",
      createdOffset: 186,
      updatedOffset: 152,
      runStatus: "completed",
      usage: { inputTokens: 18420, cachedInputTokens: 15360, cacheWriteInputTokens: 0, outputTokens: 2840, reasoningOutputTokens: 920 },
      durationMinutes: 3.4
    },
    {
      id: "readme-interview",
      title: "把客户访谈整理成产品洞察",
      goal: "阅读三份访谈记录，按场景、痛点、现有替代方案和购买信号整理产品洞察。",
      status: "running",
      executorId: "codex",
      taskKind: "delivery",
      expectedOutputs: ["insights.md"],
      nextAction: "正在归纳跨访谈共性",
      resultSummary: null,
      createdOffset: 28,
      updatedOffset: 2,
      runStatus: "running",
      usage: { inputTokens: 9250, cachedInputTokens: 6144, cacheWriteInputTokens: 0, outputTokens: 860, reasoningOutputTokens: 410 },
      durationMinutes: 1.2
    },
    {
      id: "readme-risk-mail",
      title: "发送本周风险提醒",
      goal: "把本周风险摘要发给项目组，发送前核对收件人、正文和附件。",
      status: "waiting_approval",
      executorId: "native",
      taskKind: "general",
      expectedOutputs: ["risk-brief.md"],
      nextAction: "等待邮件发送审批",
      resultSummary: "草稿已准备好，发送前需要你确认收件人与正文。",
      createdOffset: 74,
      updatedOffset: 8,
      runStatus: "waiting_approval",
      usage: { inputTokens: 6120, cachedInputTokens: 4096, cacheWriteInputTokens: 0, outputTokens: 940, reasoningOutputTokens: 260 },
      durationMinutes: 0.8
    },
    {
      id: "readme-expense",
      title: "核对 10 月报销单据",
      goal: "按差旅标准核对票据金额、日期和事由，输出异常清单与可报销汇总。",
      status: "completed",
      executorId: "native",
      taskKind: "workspace",
      expectedOutputs: ["expense-review.md"],
      nextAction: "产物已保存",
      resultSummary: "共核对 18 张票据，17 张符合规则；1 张缺少出差审批单，已单独列出。可报销金额合计 ¥6,428.50。",
      createdOffset: 1530,
      updatedOffset: 1490,
      runStatus: "completed",
      usage: { inputTokens: 12300, cachedInputTokens: 9216, cacheWriteInputTokens: 0, outputTokens: 1760, reasoningOutputTokens: 500 },
      durationMinutes: 2.1
    },
    {
      id: "readme-knowledge",
      title: "同步团队知识库到本地",
      goal: "把团队知识库中的产品、交付和运维文档同步到本地来源，保留引用关系。",
      status: "recoverable",
      executorId: "deepseek-harness",
      taskKind: "workspace",
      expectedOutputs: ["sync-report.md"],
      nextAction: "网络中断，可重试",
      resultSummary: null,
      createdOffset: 260,
      updatedOffset: 226,
      runStatus: "failed",
      usage: { inputTokens: 22100, cachedInputTokens: 18000, cacheWriteInputTokens: 0, outputTokens: 3100, reasoningOutputTokens: 780 },
      durationMinutes: 4.6,
      error: { message: "同步在第 68% 处中断：连接被远端关闭。", guidance: "检查网络后重试，已完成的条目会保留，不会从零开始。" }
    }
  ];

  const artifactFiles = new Map();
  const addArtifactFile = (name, content) => {
    const dir = join(dataDir, "artifacts", "readme");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, name);
    writeFileSync(path, content, "utf8");
    artifactFiles.set(name, { path, content });
  };
  addArtifactFile("weekly-report.md", tasks[0].resultSummary + "\n\n---\n\n数据来源：本周项目看板、会议记录、客户访谈摘要。\n");
  addArtifactFile("expense-review.md", "# 10 月报销核对\n\n- 票据总数：18\n- 合规票据：17\n- 需要补充：1（缺少出差审批单）\n- 可报销金额：¥6,428.50\n");

  db.exec("BEGIN");
  try {
    db.exec("DELETE FROM tasks; DELETE FROM runs; DELETE FROM artifacts; DELETE FROM conversations; DELETE FROM chat_messages; DELETE FROM suggestions; DELETE FROM suggestion_events; DELETE FROM memories; DELETE FROM memory_conflicts; DELETE FROM memory_recalls; DELETE FROM memory_versions; DELETE FROM memory_forget_receipts; DELETE FROM approvals; DELETE FROM effects; DELETE FROM events; DELETE FROM context_items; DELETE FROM run_checkpoints; DELETE FROM outbox_drafts; DELETE FROM task_proposals;");

    const insertTask = db.prepare(`INSERT INTO tasks (id, template_id, title, goal, status, created_at, updated_at, deadline, inputs_json, network_hosts_json, output_dir, current_run_id, next_action, error_json, result_summary, conversation_id, executor_id, task_kind, expected_outputs_json, permissions_json, pending_input, method_id, method_version) VALUES (?, NULL, ?, ?, ?, ?, ?, NULL, '[]', '[]', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`);
    const insertRun = db.prepare(`INSERT INTO runs (id, task_id, attempt, status, thread_id, workspace, started_at, ended_at, failure_json, usage_json, created_at, lease_epoch, executor_id, checkpoint_seq, budget_json, parent_run_id, handoff_id) VALUES (?, ?, 1, ?, NULL, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, NULL, NULL)`);
    const insertArtifact = db.prepare(`INSERT INTO artifacts (id, task_id, run_id, relative_path, absolute_path, mime_type, sha256, bytes, created_at) VALUES (?, ?, ?, ?, ?, 'text/markdown; charset=utf-8', ?, ?, ?)`);
    const insertEvent = db.prepare(`INSERT INTO events (id, type, task_id, run_id, payload_json, created_at, origin_instance_id, origin_seq) VALUES (?, 'task.progress', ?, ?, ?, ?, NULL, NULL)`);
    const insertContext = db.prepare(`INSERT INTO context_items (id, conversation_id, task_id, run_id, executor_id, kind, role, content, content_ref, sha256, tokens, sensitivity, provenance_json, parent_id, executor_event_id, created_at) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, 'normal', '{}', NULL, NULL, ?)`);
    const insertCheckpoint = db.prepare(`INSERT INTO run_checkpoints (id, run_id, task_id, seq, kind, path, sha256, usage_json, created_at) VALUES (?, ?, ?, ?, 'checkpoint', ?, ?, ?, ?)`);

    for (const task of tasks) {
      const runId = `${task.id}-run`;
      const createdAt = iso(task.createdOffset);
      const updatedAt = iso(task.updatedOffset);
      const endedAt = task.runStatus === "running" || task.runStatus === "waiting_approval" ? null : new Date(new Date(createdAt).getTime() + (task.durationMinutes ?? 1) * 60_000).toISOString();
      insertTask.run(
        task.id,
        task.title,
        task.goal,
        task.status,
        createdAt,
        updatedAt,
        `readme/${task.id}`,
        runId,
        task.nextAction,
        task.error ? JSON.stringify(task.error) : null,
        task.resultSummary,
        task.id === "readme-weekly" ? "readme-weekly-conversation" : null,
        task.executorId,
        task.taskKind,
        JSON.stringify(task.expectedOutputs),
        JSON.stringify({ readRoots: [], writeRoots: [], networkHosts: [], tools: [] })
      );
      insertRun.run(
        runId,
        task.id,
        task.runStatus,
        join(dataDir, "workspaces", runId),
        createdAt,
        endedAt,
        task.error ? JSON.stringify({ code: "NETWORK_INTERRUPTED", message: task.error.message }) : null,
        JSON.stringify(task.usage),
        createdAt,
        task.executorId
      );

      if (task.id === "readme-weekly") {
        const file = artifactFiles.get("weekly-report.md");
        if (file) {
          insertArtifact.run(
            "readme-weekly-artifact",
            task.id,
            runId,
            "weekly-report.md",
            file.path,
            createHash("sha256").update(file.content).digest("hex"),
            Buffer.byteLength(file.content),
            iso(task.updatedOffset)
          );
        }
      }
      if (task.id === "readme-expense") {
        const file = artifactFiles.get("expense-review.md");
        if (file) {
          insertArtifact.run(
            "readme-expense-artifact",
            task.id,
            runId,
            "expense-review.md",
            file.path,
            createHash("sha256").update(file.content).digest("hex"),
            Buffer.byteLength(file.content),
            iso(task.updatedOffset)
          );
        }
      }

      if (task.id === "readme-weekly") {
        insertContext.run("readme-context-1", task.id, runId, task.executorId, "input", "user", "本周项目看板、会议记录、客户访谈摘要", 28, iso(task.createdOffset));
        insertContext.run("readme-context-2", task.id, runId, task.executorId, "artifact", "assistant", "已汇总本周完成、风险与下周计划，并生成 Markdown 周报。", 32, iso(task.updatedOffset));
        insertCheckpoint.run("readme-checkpoint-1", runId, task.id, 1, join(dataDir, "workspaces", runId, "checkpoint-1.json"), createHash("sha256").update("checkpoint").digest("hex"), JSON.stringify(task.usage), iso(task.updatedOffset));
      }

      if (task.id === "readme-interview") {
        insertEvent.run("readme-event-1", task.id, runId, JSON.stringify({ kind: "thread.started", message: "已读取 3 份访谈记录", at: iso(26) }), iso(26));
        insertEvent.run("readme-event-2", task.id, runId, JSON.stringify({ kind: "item.completed", message: "正在识别跨访谈共性", at: iso(12) }), iso(12));
        insertEvent.run("readme-event-3", task.id, runId, JSON.stringify({ kind: "item.completed", message: "已归纳 5 个产品场景", at: iso(2) }), iso(2));
      }
    }

    db.prepare(`INSERT INTO conversations (id, title, created_at, updated_at, settings_json) VALUES (?, ?, ?, ?, ?)`).run(
      "readme-weekly-conversation",
      "整理本周工作周报",
      iso(186),
      iso(150),
      JSON.stringify({ executorEnabled: { native: true, codex: true, "deepseek-harness": true, hermes: false, qoder: false, workbuddy: false, kimi: false }, approvalMode: "necessary", preferredExecutorId: "native" })
    );
    db.prepare(`INSERT INTO conversations (id, title, created_at, updated_at, settings_json) VALUES (?, ?, ?, ?, NULL)`).run(
      "readme-interview-conversation",
      "把客户访谈整理成产品洞察",
      iso(60),
      iso(58)
    );
    db.prepare(`INSERT INTO conversations (id, title, created_at, updated_at, settings_json) VALUES (?, ?, ?, ?, NULL)`).run(
      "readme-expense-conversation",
      "核对 10 月报销单据",
      iso(1500),
      iso(1490)
    );

    const insertMessage = db.prepare(`INSERT INTO chat_messages (id, conversation_id, role, content, task_id, attachments_json, created_at, kind, task_status) VALUES (?, ?, ?, ?, ?, '[]', ?, ?, ?)`);
    insertMessage.run(
      "readme-message-user",
      "readme-weekly-conversation",
      "user",
      "帮我整理本周工作周报。重点写清楚本周完成、风险和下周计划，最后输出一份 Markdown。",
      null,
      iso(184),
      null,
      null
    );
    insertMessage.run(
      "readme-message-assistant",
      "readme-weekly-conversation",
      "assistant",
      "已派出任务：**整理本周工作周报**\n\n执行器：Native。它会先汇总项目看板和会议记录，再核对风险与下周计划，最后生成 `weekly-report.md`。",
      "readme-weekly",
      iso(182),
      null,
      null
    );
    insertMessage.run(
      "readme-message-status",
      "readme-weekly-conversation",
      "assistant",
      "任务已完成：生成了 weekly-report.md，并保留了执行摘要、上下文和产物摘要。",
      "readme-weekly",
      iso(151),
      "task_status",
      "completed"
    );

    const insertSuggestion = db.prepare(`INSERT INTO suggestions (id, trigger_kind, dedupe_key, title, why_now, suggested_action, expected_impact, estimated_cost, risk_level, requires_approval, autonomy, status, priority, source_json, evidence_json, occurrence_count, first_seen_at, last_seen_at, notified_at, snooze_until, expires_at, task_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'suggest', ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?)`);
    insertSuggestion.run(
      "readme-suggestion-approval",
      "approval.pending",
      "readme-approval",
      "周报邮件等你批准",
      "草稿已经生成，收件人和正文都已核对，发送前只需要你确认一次。",
      "查看并批准发送",
      "本周进展同步给 5 位同事",
      "1 次邮件发送",
      "medium",
      1,
      "new",
      92,
      JSON.stringify({ kind: "task", label: "任务", detail: "发送本周风险提醒" }),
      JSON.stringify({ items: ["收件人：项目组", "附件：risk-brief.md"] }),
      2,
      iso(40),
      iso(8),
      "readme-risk-mail",
      iso(40),
      iso(8)
    );
    insertSuggestion.run(
      "readme-suggestion-failed",
      "task.failed",
      "readme-failed",
      "知识库同步中断，可继续",
      "已经完成 68% 的增量，网络恢复后可以从断点继续，不需要从头重跑。",
      "重试同步",
      "补齐团队知识库来源",
      "约 2 分钟",
      "low",
      0,
      "new",
      76,
      JSON.stringify({ kind: "task", label: "任务", detail: "同步团队知识库到本地" }),
      JSON.stringify({ items: ["错误：连接被远端关闭", "保留：已完成 68%"] }),
      1,
      iso(226),
      iso(226),
      "readme-knowledge",
      iso(226),
      iso(226)
    );
    insertSuggestion.run(
      "readme-suggestion-source",
      "source.new_items",
      "readme-source",
      "客户访谈新增 3 条记录",
      "新增记录涉及续费阻力和迁移成本，可能影响下季度路线优先级。",
      "生成访谈摘要",
      "补充产品洞察证据",
      "约 1 次任务执行",
      "low",
      0,
      "new",
      64,
      JSON.stringify({ kind: "source", label: "来源", detail: "客户访谈 / 11 月" }),
      JSON.stringify({ items: ["新增 3 条", "其中 2 条包含明确购买信号"] }),
      3,
      iso(90),
      iso(5),
      null,
      iso(90),
      iso(5)
    );

    const insertMemory = db.prepare(`INSERT INTO memories (id, kind, status, content, subject_key, scope, tags_json, source_json, confidence, sensitivity, allow_recall, version, supersedes_id, derived_from_id, valid_until, created_at, updated_at, last_recalled_at, recall_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, NULL, NULL, ?, ?, ?, ?)`);
    insertMemory.run(
      "readme-memory-preference",
      "preference",
      "active",
      "汇报时先给结论，再列证据和待办；默认使用简体中文。",
      "user.communication",
      "global",
      JSON.stringify(["沟通", "偏好"]),
      JSON.stringify({ kind: "manual", label: "用户明确创建" }),
      "high",
      "normal",
      1,
      iso(1440),
      iso(1440),
      iso(30),
      4
    );
    insertMemory.run(
      "readme-memory-project",
      "project",
      "active",
      "Ember 项目计划在 11 月 20 日发布，当前阻塞是内容渠道负责人确认。",
      "project.ember.release",
      "project",
      JSON.stringify(["Ember", "发布"]),
      JSON.stringify({ kind: "task", label: "整理本周工作周报", detail: "任务结果" }),
      "high",
      "normal",
      1,
      iso(150),
      iso(150),
      iso(12),
      2
    );
    insertMemory.run(
      "readme-memory-candidate",
      "commitment",
      "candidate",
      "希望每周五下午自动整理一份周报草稿，发送前由本人确认。",
      "user.weekly-review",
      "global",
      JSON.stringify(["周报", "习惯"]),
      JSON.stringify({ kind: "conversation", label: "聊天中提取" }),
      "medium",
      "normal",
      1,
      iso(60),
      iso(60),
      null,
      0
    );

    db.prepare(`INSERT INTO memory_settings (id, auto_capture, max_items, max_chars, allow_sensitive, updated_at) VALUES (1, 'experience', 8, 6000, 0, ?)`).run(iso(60));
    db.prepare(`INSERT INTO proactive_settings (id, enabled, mode, daily_limit, quiet_start, quiet_end, cooldown_minutes, aggregate_window_minutes, paused_until, triggers_json, updated_at) VALUES (1, 1, 'suggest', 6, '22:00', '08:00', 30, 120, NULL, ?, ?)`).run(
      JSON.stringify({
        "task.deadline": { enabled: true, autonomy: "A0" },
        "task.failed": { enabled: true, autonomy: "A0" },
        "effect.uncertain": { enabled: true, autonomy: "A0" },
        "approval.pending": { enabled: true, autonomy: "A0" },
        "source.new_items": { enabled: true, autonomy: "A0" },
        "system.health": { enabled: true, autonomy: "A0" },
        "email.new_message": { enabled: false, autonomy: "A0" },
        "calendar.upcoming": { enabled: false, autonomy: "A0" }
      }),
      iso(60)
    );

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}

function onceExit(child) {
  return new Promise((resolve) => child.once("exit", resolve));
}
