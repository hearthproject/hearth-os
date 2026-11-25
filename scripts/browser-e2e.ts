import { createServer } from "node:http";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { extname, join, normalize, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { BrowserService } from "../apps/server/src/browser-service.ts";
import { BrowserSessionManager } from "../apps/server/src/browser-session.ts";
import { BrowserEvidenceStore } from "../apps/server/src/browser-evidence.ts";
import { createBrowserTools } from "../apps/server/src/browser-tools.ts";
import type { AgentTool, AgentToolContext, AgentToolResult } from "../packages/agent-runtime/src/types.ts";

const fixtureDir = resolve("e2e/browser-fixture");
const root = join(tmpdir(), `hearth-browser-e2e-${Date.now()}`);
const workspace = join(root, "workspace");
const outDir = join(root, "out");
const profileDir = join(root, "profile");
const evidenceDir = join(root, "evidence");
const recipesDir = join(root, "recipes");
const statePath = join(root, "sessions.json");
mkdirSync(workspace, { recursive: true });
mkdirSync(outDir, { recursive: true });
writeFileSync(join(workspace, "upload.txt"), "hearth upload payload\n", "utf8");

const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};
const server = createServer((request, response) => {
  const raw = (request.url ?? "/").split("?")[0] ?? "/";
  const file = raw === "/" ? "index.html" : raw.replace(/^\//, "");
  const path = normalize(join(fixtureDir, file));
  const rel = relative(fixtureDir, path);
  if (rel.startsWith("..")) {
    response.writeHead(403).end("forbidden");
    return;
  }
  try {
    const body = readFileSync(path);
    response.writeHead(200, { "content-type": mime[extname(path)] ?? "application/octet-stream" }).end(body);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found");
  }
});
await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
const address = server.address();
if (!address || typeof address === "string") throw new Error("fixture server did not bind");
const base = `http://127.0.0.1:${address.port}`;

const browser = new BrowserService({ profileDir, headless: true });
const sessions = new BrowserSessionManager(browser, { statePath });
const evidence = new BrowserEvidenceStore(evidenceDir);
const taskId = "browser-fixture-task";
const makeTools = (runId: string): AgentTool[] => createBrowserTools({
  taskId,
  runId,
  sessions,
  evidence,
  recipesDir,
  onEvent: () => undefined
});
let tools = makeTools("browser-fixture-run-1");
const context: AgentToolContext = {
  workspaceRoot: workspace,
  outDir,
  permissions: {
    readRoots: [workspace],
    writeRoots: [workspace],
    networkHosts: ["127.0.0.1"],
    tools: [],
    approvalMode: "workspace",
    sandboxMode: "workspace-write"
  },
  signal: new AbortController().signal
};

function tool(name: string, toolkit = tools): AgentTool {
  const found = toolkit.find((item) => item.definition.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

async function callWith(toolkit: AgentTool[], name: string, args: Record<string, unknown>): Promise<AgentToolResult> {
  const result = await tool(name, toolkit).execute(args, context);
  if (result.isError) throw new Error(`${name} failed: ${result.content}`);
  return result;
}

async function callRawWith(toolkit: AgentTool[], name: string, args: Record<string, unknown>): Promise<AgentToolResult> {
  return tool(name, toolkit).execute(args, context);
}

async function call(name: string, args: Record<string, unknown>): Promise<AgentToolResult> {
  return callWith(tools, name, args);
}

async function callRaw(name: string, args: Record<string, unknown>): Promise<AgentToolResult> {
  return callRawWith(tools, name, args);
}

function refFor(content: string, label: string): string {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = content.match(new RegExp(`^\\s*-\\s+(\\d+:e\\d+)\\s+[^\\n]*「${escaped}」`, "m"));
  if (!match?.[1]) throw new Error(`cannot find element ref for ${label}`);
  return match[1];
}

const checks: string[] = [];
function check(name: string, condition: boolean): void {
  if (!condition) throw new Error(`check failed: ${name}`);
  checks.push(name);
}

try {
  const opened = await call("browser_open", { url: `${base}/` });
  check("open returns title", opened.content.includes("浏览器测试站"));
  check("open returns epoch-scoped refs", /\d+:e\d+/.test(opened.content));

  const nameRef = refFor(opened.content, "姓名");
  const noteRef = refFor(opened.content, "备注");
  const uploadRef = refFor(opened.content, "上传附件");
  await call("browser_type", { ref: nameRef, text: "Hearth" });
  await call("browser_type", { ref: noteRef, text: "browser fixture e2e" });
  await call("browser_upload", { ref: uploadRef, path: "upload.txt" });

  const dangerous = await call("browser_click", { ref: refFor(opened.content, "删除全部") });
  check("authorized destructive-looking click executes", dangerous.content.includes("已删除"));

  await call("browser_assert", { kind: "text", value: "已删除" });
  await call("browser_recipe", { action: "save", name: "fixture-flow" });
  const recipes = await call("browser_recipe", { action: "list" });
  check("recipe saved", recipes.content.includes("fixture-flow"));

  const beforeSubmit = await call("browser_read", {});
  await call("browser_submit", { ref: refFor(beforeSubmit.content, "提交"), note: "fixture submit" });
  const success = await call("browser_read", {});
  check("submit reaches success", success.content.includes("提交成功"));
  await call("browser_assert", { kind: "url", value: "/success.html" });
  const failedAssertion = await callRaw("browser_assert", {
    kind: "element",
    value: `${success.metadata?.browserControlEpoch}:e999`,
    timeoutSec: 1
  });
  check("failed assertion is reported without blocking completion", Boolean(failedAssertion.isError));
  await call("browser_assert", { kind: "text", value: "提交成功" });

  const downloaded = await call("browser_download", { ref: refFor(success.content, "下载报告"), fileName: "report.txt" });
  const downloadedPath = String(downloaded.metadata?.browserDownload ?? "");
  const downloadedText = readFileSync(downloadedPath, "utf8");
  check("download writes report", downloadedText.includes("hearth-browser-fixture-report"));

  for (let index = 0; index < 6; index += 1) await call("browser_tabs", { action: "new" });
  const tabs = await call("browser_tabs", { action: "list" });
  check("more than six tabs are supported", (tabs.metadata?.browserTabs as unknown[] | undefined)?.length === 7);

  const advanced = await call("browser_open", { url: `${base}/advanced.html` });
  const usernameRef = refFor(advanced.content, "账号");
  const passwordRef = refFor(advanced.content, "密码");
  await call("browser_type", { ref: usernameRef, text: "hearth-user" });
  await call("browser_type", { ref: passwordRef, text: "fixture-secret-password" });
  const loginForm = await call("browser_read", {});
  check("password field is writable", loginForm.content.includes("账号"));
  check("password value is absent from snapshots", !loginForm.content.includes("fixture-secret-password"));
  const submittedLogin = await call("browser_submit", { ref: refFor(loginForm.content, "登录"), note: "ordinary login form" });
  check("ordinary login form submits", submittedLogin.content.includes("登录表单已提交"));

  await call("browser_hover", { ref: refFor(submittedLogin.content, "登录") });
  const selected = await call("browser_select", { ref: refFor(submittedLogin.content, "背景颜色"), values: ["blue"] });
  check("select changes a dropdown", selected.content.includes("选择成功 blue"));

  const shadow = await call("browser_click", { ref: refFor(selected.content, "Shadow 按钮") });
  check("open shadow DOM button is clickable", shadow.content.includes("Shadow 点击成功"));

  const dragged = await call("browser_drag", {
    startRef: refFor(shadow.content, "拖拽源"),
    endRef: refFor(shadow.content, "放置区")
  });
  check("drag and drop works", dragged.content.includes("拖拽成功 source"));

  const rawSnapshot = await sessions.snapshot(taskId);
  const canvas = rawSnapshot.elements.find((item) => item.name === "绘制区域");
  if (!canvas) throw new Error("canvas element was not captured");
  const canvasClick = await call("browser_click_at", {
    x: canvas.bbox.x + 24,
    y: canvas.bbox.y + 24
  });
  check("canvas coordinate click works", canvasClick.content.includes("画布点击成功"));

  const frame = await call("browser_click", { ref: refFor(canvasClick.content, "Frame 按钮") });
  check("iframe element is clickable", frame.content.includes("Frame 按钮点击成功"));
  await call("browser_scroll", { deltaX: 0, deltaY: 120 });

  await call("browser_recipe", { action: "save", name: "advanced-login-flow" });
  const recipeFiles = readdirSync(recipesDir).filter((name) => name.endsWith(".json"));
  const advancedRecipe = recipeFiles
    .map((name) => readFileSync(join(recipesDir, name), "utf8"))
    .find((text) => text.includes("advanced-login-flow")) ?? "";
  check("password is redacted from saved recipes", advancedRecipe.includes("[REDACTED]") && !advancedRecipe.includes("fixture-secret-password"));

  const beforeTakeover = await call("browser_read", {});
  const staleRef = refFor(beforeTakeover.content, "Frame 按钮");
  const takeover = await call("browser_request_takeover", {
    kind: "login",
    reason: "fixture requires manual verification"
  });
  check("takeover request asks the user", takeover.action === "ask_user" && takeover.content.includes("接管"));
  const blocked = await callRaw("browser_read", {});
  check("takeover blocks browser tools", Boolean(blocked.isError) && blocked.content.includes("BROWSER_TAKEOVER"));

  sessions.beginUserTakeover(taskId, "login", "fixture user takeover");
  const released = await sessions.releaseToAgent(taskId);
  check("takeover can be released to the agent", released.session?.controlState === "agent");
  check("release returns a fresh snapshot", Boolean(released.snapshot?.content.includes("高级浏览器交互")));
  const resumed = await call("browser_read", {});
  const resumedEpoch = resumed.metadata?.browserControlEpoch;
  check("refs move to the new control epoch", resumed.content.includes(`${resumedEpoch}:e`));
  const staleClick = await callRaw("browser_click", { ref: staleRef });
  check("refs from before takeover are stale", Boolean(staleClick.isError) && /BROWSER_ELEMENT_MISSING|BROWSER_ELEMENT_REF/.test(staleClick.content));

  const runTwo = makeTools("browser-fixture-run-2");
  const resumedAcrossRun = await callWith(runTwo, "browser_read", {});
  check("browser session survives across runs", resumedAcrossRun.content.includes("高级浏览器交互"));

  for (let index = 0; index < 5; index += 1) await sessions.session(`parallel-task-${index}`);
  check("more than four browser sessions are supported", Array.from({ length: 5 }, (_, index) => sessions.describe(`parallel-task-${index}`)?.exists).every(Boolean));

  const persisted = JSON.parse(readFileSync(statePath, "utf8")) as { sessions?: Record<string, unknown> };
  check("session metadata is persisted", Boolean(persisted.sessions?.[taskId]));
  check("browser toolset registers no finish_task", tools.every((item) => item.definition.name !== "finish_task"));

  const assertions = sessions.state(taskId)!.assertions;
  check("flow records a passing assertion", assertions.some((item) => item.passed));
  check("flow records a failed assertion", assertions.some((item) => !item.passed));

  const evidenceFiles = readdirSync(join(evidenceDir, taskId)).filter((name) => name.endsWith(".png") || name.endsWith(".json"));
  check("evidence files exist", evidenceFiles.length >= 6);

  console.log(JSON.stringify({ ok: true, checks, evidenceFiles: evidenceFiles.length, downloaded: downloadedPath, tabs: 7 }, null, 2));
} finally {
  await sessions.releaseAll().catch(() => undefined);
  await sessions.stop();
  await browser.close().catch(() => undefined);
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // Chrome can briefly hold a profile lock on Windows; the temp folder is not
    // part of the assertion set.
  }
}
