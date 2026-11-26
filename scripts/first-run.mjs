#!/usr/bin/env node
/**
 * Hearth 首次运行验证（first-run）。
 *
 * 目的：用你自己的 provider/key，跑一次“改文件 → 跑测试 → 出结果”的最小真实任务，
 * 确认模型、工具循环、测试与产物链路真的通，而不是只看单测。
 *
 * 两种模式：
 *   默认（真实）：调用正在运行的本地服务的 POST /api/onboarding/verify，
 *                 由服务用当前执行器绑定的模型跑真实任务。
 *   --fake（离线自检）：不联网、不需要模型、不需要服务，确定性地在临时目录里
 *                 复现同一套“写 answer.txt → node check.mjs”流程，用来验证
 *                 本脚本自身的输出与退出码。它不能证明你的模型可用。
 *
 * 用法：
 *   node scripts/first-run.mjs [--base-url http://127.0.0.1:4317] [--fake] [--help]
 *   npm run first:run            # 真实模式
 *   npm run first:run -- --fake  # 离线自检
 *
 * 退出码：0 通过；1 任务失败；2 环境/配置问题（服务未启动、模型未配置等）。
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULT_BASE_URL = "http://127.0.0.1:4317";

function parseArgs(argv) {
  const options = { baseUrl: process.env.HEARTH_BASE_URL ?? DEFAULT_BASE_URL, fake: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--fake") options.fake = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--base-url") {
      const value = argv[i + 1];
      if (value && !value.startsWith("--")) {
        options.baseUrl = value;
        i += 1;
      } else {
        console.error("--base-url 需要一个值");
        options.help = true;
      }
    } else if (arg.startsWith("--base-url=")) options.baseUrl = arg.slice("--base-url=".length);
    else {
      console.error(`未知参数：${arg}`);
      options.help = true;
    }
  }
  return options;
}

function printHelp() {
  console.log(`Hearth 首次运行验证

用法:
  node scripts/first-run.mjs [options]

选项:
  --base-url <url>   本地服务地址（默认 ${DEFAULT_BASE_URL}，可用 HEARTH_BASE_URL 覆盖）
  --fake             离线自检：不联网、不需要模型，验证脚本自身
  -h, --help         显示本帮助

退出码:
  0  通过
  1  任务失败
  2  环境/配置问题（服务未启动、模型未配置等）`);
}

function printChecks(checks) {
  for (const check of checks) {
    const mark = check.passed ? "PASS" : "FAIL";
    const detail = check.detail ? ` (${check.detail})` : "";
    console.log(`  [${mark}] ${check.name}${detail}`);
  }
}

async function runReal(options) {
  const base = options.baseUrl.replace(/\/+$/, "");
  let ready;
  try {
    ready = await fetch(`${base}/api/ready`, { signal: AbortSignal.timeout(5000) });
  } catch {
    console.error(`无法连接本地服务：${base}`);
    console.error("请先启动服务端（npm start 或 npm run dev），再运行本脚本。");
    return 2;
  }
  if (!ready.ok) {
    console.error(`服务已启动但 /api/ready 返回 ${ready.status}`);
    return 2;
  }

  let response;
  try {
    response = await fetch(`${base}/api/onboarding/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(120_000)
    });
  } catch {
    console.error("调用 /api/onboarding/verify 失败（超时或连接中断）。");
    return 2;
  }

  if (response.status === 409) {
    const body = await response.json().catch(() => ({}));
    console.error(`当前执行器尚无可用的模型：${body.message ?? "先为执行器绑定模型，再跑首次示例。"}`);
    console.error("请在 设置 → 模型 创建模型档案并绑定到执行器，然后重试。");
    return 2;
  }
  if (!response.ok) {
    console.error(`服务返回 ${response.status}`);
    console.error((await response.text().catch(() => "")).slice(0, 500));
    return 2;
  }

  const { verification } = await response.json();
  console.log("首次运行验证（真实模型）");
  console.log(`结果：${verification.status}`);
  printChecks(verification.checks ?? []);
  if (verification.filesChanged?.length) {
    console.log(`改动文件：${verification.filesChanged.join(", ")}`);
  }
  if (verification.summary) console.log(`说明：${verification.summary}`);
  if (verification.ok) {
    console.log("完成：模型已经跑通一次真实的读写与测试。");
    return 0;
  }
  return 1;
}

function runFake() {
  const root = mkdtempSync(join(tmpdir(), "hearth-first-run-"));
  const checkSource =
    "import { readFileSync } from 'node:fs';\n" +
    "const value = readFileSync('answer.txt', 'utf8').trim();\n" +
    "if (value !== 'hearth') { console.error('answer.txt must contain hearth'); process.exit(1); }\n" +
    "console.log('first task passed');\n";
  try {
    writeFileSync(join(root, "hello.txt"), "hello\n", "utf8");
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "hearth-first-task", private: true, scripts: { test: "node check.mjs" } }, null, 2), "utf8");
    writeFileSync(join(root, "check.mjs"), checkSource, "utf8");

    const before = readdirSync(root).sort();
    // 模拟模型动作：读取 hello.txt，写出 answer.txt = hearth。
    const hello = readFileSync(join(root, "hello.txt"), "utf8");
    writeFileSync(join(root, "answer.txt"), "hearth\n", "utf8");
    const after = readdirSync(root).sort();

    const test = spawnSync(process.execPath, ["check.mjs"], { cwd: root, encoding: "utf8" });
    const testPassed = test.status === 0;

    console.log("首次运行验证（离线自检 --fake，不涉及真实模型）");
    console.log("改动：");
    console.log(`  before: ${before.join(", ")}`);
    console.log(`  after : ${after.join(", ")}`);
    console.log(`  + answer.txt = ${JSON.stringify(hello.trim() === "hello" ? "hearth" : "?")}（源自 hello.txt=${JSON.stringify(hello.trim())}）`);
    console.log(`  npm test -> ${testPassed ? "first task passed" : `exit ${test.status}: ${(test.stderr || test.stdout || "").trim()}`}`);

    const checks = [
      { name: "answer.txt 内容正确", passed: true, detail: "hearth" },
      { name: "真实测试通过", passed: testPassed, detail: testPassed ? "check.mjs 退出码 0" : `退出码 ${test.status}` }
    ];
    printChecks(checks);
    if (checks.every((c) => c.passed)) {
      console.log("完成：脚本与任务链路自检通过（这不代表你的模型可用，真实模型请用默认模式）。");
      return 0;
    }
    return 1;
  } finally {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // Windows 可能短暂占用临时文件，忽略。
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return 0;
  }
  if (options.fake) return runFake();
  return runReal(options);
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  });
