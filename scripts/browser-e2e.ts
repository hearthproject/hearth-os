import { createServer } from "node:http";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { tmpdir } from "node:os";
import { BrowserService } from "../apps/server/src/browser-service.ts";
import { BrowserSessionManager } from "../apps/server/src/browser-session.ts";
import { BrowserSettingsStore } from "../apps/server/src/browser-settings.ts";
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
  if (!path.startsWith(fixtureDir)) {
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
const settings = new BrowserSettingsStore(join(root, "settings.json"));
settings.update({ enabled: true, allowedDomains: ["127.0.0.1"], readOnlyDomains: [], highRiskDomains: [], maxSessions: 4 });
const sessions = new BrowserSessionManager(browser, { idleMs: 60_000 });
const evidence = new BrowserEvidenceStore(evidenceDir);
const taskId = "browser-fixture-task";
const tools = createBrowserTools({
  taskId,
  runId: "browser-fixture-run",
  sessions,
  evidence,
  settings: settings.get(),
  recipesDir,
  onEvent: () => undefined
});
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

function tool(name: string): AgentTool {
  const found = tools.find((item) => item.definition.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

async function call(name: string, args: Record<string, unknown>): Promise<AgentToolResult> {
  const result = await tool(name).execute(args, context);
  if (result.isError) throw new Error(`${name} failed: ${result.content}`);
  return result;
}

async function callRaw(name: string, args: Record<string, unknown>): Promise<AgentToolResult> {
  return tool(name).execute(args, context);
}

function refFor(content: string, label: string): string {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = content.match(new RegExp(`^\\s*-\\s+(e\\d+)\\s+[^\\n]*「${escaped}」`, "m"));
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
  check("open returns refs", /e\d+/.test(opened.content));

  const nameRef = refFor(opened.content, "姓名");
  const noteRef = refFor(opened.content, "备注");
  const uploadRef = refFor(opened.content, "上传附件");
  await call("browser_type", { ref: nameRef, text: "Hearth" });
  await call("browser_type", { ref: noteRef, text: "browser fixture e2e" });
  await call("browser_upload", { ref: uploadRef, path: "upload.txt" });

  const dangerous = await callRaw("browser_click", { ref: refFor(opened.content, "删除全部") });
  check("dangerous click is rejected", Boolean(dangerous.isError));
  check("dangerous click has code", dangerous.content.includes("BROWSER_DANGEROUS_CLICK"));

  const beforeSubmit = await call("browser_read", {});
  await call("browser_assert", { kind: "text", value: "浏览器测试站" });
  await call("browser_recipe", { action: "save", name: "fixture-flow" });
  const recipes = await call("browser_recipe", { action: "list" });
  check("recipe saved", recipes.content.includes("fixture-flow"));

  await call("browser_submit", { ref: refFor(beforeSubmit.content, "提交"), note: "fixture submit" });
  const success = await call("browser_read", {});
  check("submit reaches success", success.content.includes("提交成功"));
  await call("browser_assert", { kind: "url", value: "/success.html" });
  await call("browser_assert", { kind: "text", value: "提交成功" });

  const downloaded = await call("browser_download", { ref: refFor(success.content, "下载报告"), fileName: "report.txt" });
  const downloadedPath = String(downloaded.metadata?.browserDownload ?? "");
  const downloadedText = readFileSync(downloadedPath, "utf8");
  check("download writes report", downloadedText.includes("hearth-browser-fixture-report"));

  const newTab = await call("browser_tabs", { action: "new" });
  const tabId = String(newTab.metadata?.browserTabId ?? "");
  await call("browser_open", { url: `${base}/second.html` });
  const tabs = await call("browser_tabs", { action: "list" });
  check("two tabs are open", (tabs.content.match(/tab-\d+/g) ?? []).length >= 2);
  await call("browser_assert", { kind: "text", value: "第二页" });
  await call("browser_tabs", { action: "close", tabId });

  sessions.pause(taskId);
  const paused = await callRaw("browser_read", {});
  check("pause blocks tools", Boolean(paused.isError));
  check("pause reports takeover", paused.content.includes("BROWSER_TAKEOVER"));
  sessions.resume(taskId);
  await call("browser_read", {});

  const finished = await call("finish_task", { summary: "fixture browser flow complete", outputs: [] });
  check("finish requires a passing assertion", finished.action === "finish");

  const evidenceFiles = readdirSync(join(evidenceDir, taskId)).filter((name) => name.endsWith(".png") || name.endsWith(".json"));
  check("evidence files exist", evidenceFiles.length >= 6);

  console.log(JSON.stringify({ ok: true, checks, evidenceFiles: evidenceFiles.length, downloaded: downloadedPath, tabId }, null, 2));
} finally {
  await sessions.releaseAll().catch(() => undefined);
  sessions.stop();
  await browser.close().catch(() => undefined);
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // Chrome can briefly hold a profile lock on Windows; the temp folder is not
    // part of the assertion set.
  }
}
