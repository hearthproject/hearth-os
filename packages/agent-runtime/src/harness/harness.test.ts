import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyEdit, findEditMatch, normalizeFile, restoreFile } from "./edit-match.ts";
import { findOmissionPlaceholder, omissionPlaceholderError } from "./omission.ts";
import { createAgentState, recordFileModified, recordFileRead, requireReadBeforeWrite } from "./file-state.ts";
import { codingFinishIssue } from "./verification.ts";
import { compactAgentMessagesWithSummary } from "../compaction.ts";
import { searchFiles } from "./search.ts";
import { todoReadTool, todoWriteTool, todoReminder } from "./todo.ts";
import { commandPolicyIssue } from "./command-policy.ts";
import { codingPromptSections, codingSystemPrompt } from "./prompt.ts";
import { redactSecrets } from "./tool-output.ts";
import { detectProjectProfile } from "./project-profile.ts";
import { environmentBlock } from "./environment.ts";
import { runShellSession, startShellSession, shellOutput, killShellSession } from "./shell-session.ts";
import { defaultTaskPermissions } from "../tools.ts";
import type { AgentMessage, AgentToolContext } from "../types.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "hearth-harness-"));
  roots.push(root);
  return root;
}

function context(root: string): AgentToolContext {
  const outDir = join(root, "out");
  return {
    workspaceRoot: root,
    outDir,
    permissions: defaultTaskPermissions({ workspaceRoot: root, outDir, networkHosts: [] }),
    signal: new AbortController().signal,
    state: createAgentState(root)
  };
}

describe("edit matching", () => {
  it("matches CRLF files and indentation drift", () => {
    const raw = "function greet(name) {\r\n  console.log(\"Hello\", name);\r\n}\r\n";
    const normalized = normalizeFile(raw);
    const match = findEditMatch(normalized.text, 'function greet(name) {\nconsole.log("Hello", name);');
    expect("start" in match).toBe(true);
    if (!("start" in match)) return;
    const next = restoreFile({ ...normalized, text: applyEdit(normalized.text, match, "function greet(name) {\n  return name;\n}") });
    expect(next).toContain("return name;");
    expect(next.includes("\r\n")).toBe(true);
  });

  it("refuses ambiguous matches instead of guessing", () => {
    const result = findEditMatch("a\nb\na\nb\n", "a\nb");
    expect("start" in result).toBe(false);
  });

  it("matches curly quotes and unicode escapes without changing offsets", () => {
    const content = 'const message = "It’s fine";\nconst next = 1;\n';
    const quoteMatch = findEditMatch(content, 'const message = "It\'s fine";');
    expect("start" in quoteMatch && quoteMatch.tier).toBe("unicode");
    if (!("start" in quoteMatch)) return;
    expect(content.slice(quoteMatch.start, quoteMatch.end)).toBe('const message = "It’s fine";');

    const escapeMatch = findEditMatch(content, 'const message = "It\\u2019s fine";');
    expect("start" in escapeMatch).toBe(true);
  });

  it("rejects omission placeholders in edit text", () => {
    expect(findOmissionPlaceholder("a\n// ... existing code ...\nb")).toMatchObject({ line: 2 });
    expect(findOmissionPlaceholder("a\n...\nb")).toMatchObject({ line: 2 });
    expect(findOmissionPlaceholder("a\n// 其余不变\nb")).toMatchObject({ line: 2 });
    expect(findOmissionPlaceholder("const text = '...';\nconst dots = ['a', 'b'];")).toBeNull();
    expect(omissionPlaceholderError("a\n...\nb")).toContain("省略占位符");
  });
});

describe("file state", () => {
  it("requires a read before editing an existing file", () => {
    const root = workspace();
    const file = join(root, "src.ts");
    writeFileSync(file, "old");
    const state = createAgentState(root);
    expect(requireReadBeforeWrite({ ...context(root), state }, file)).toContain("尚未读取");
    recordFileRead(state, file, readFileSync(file, "utf8"));
    expect(requireReadBeforeWrite({ ...context(root), state }, file)).toBeNull();
  });
});

describe("compaction", () => {
  it("keeps recent tool output intact and prunes old output with head and tail", async () => {
    const messages: AgentMessage[] = [
      { role: "system", content: "system" },
      { role: "user", content: "goal" },
      { role: "assistant", content: "", toolCalls: [{ id: "a", name: "read", arguments: {}, rawArguments: "{}" }] },
      { role: "tool", toolCallId: "a", name: "read", content: `${"a".repeat(30_000)}END-OLD` },
      { role: "assistant", content: "", toolCalls: [{ id: "b", name: "read", arguments: {}, rawArguments: "{}" }] },
      { role: "tool", toolCallId: "b", name: "read", content: `${"b".repeat(30_000)}END-NEW` }
    ];
    const result = await compactAgentMessagesWithSummary(messages, { maxToolChars: 8_000, keepRecentToolOutputs: 1 });
    const old = result.messages.find((message) => message.role === "tool" && message.toolCallId === "a");
    const recent = result.messages.find((message) => message.role === "tool" && message.toolCallId === "b");
    expect(old?.content).toContain("chars omitted");
    expect(old?.content).toContain("END-OLD");
    expect(recent?.content.endsWith("END-NEW")).toBe(true);
    expect(result.messages.some((message) => message.role === "tool")).toBe(true);
  });

  it("injects the progress ledger and project instructions when compacting", async () => {
    const messages: AgentMessage[] = [
      { role: "system", content: "system" },
      { role: "user", content: "goal" },
      { role: "assistant", content: "old".repeat(2_000), toolCalls: [] },
      { role: "user", content: "continue" }
    ];
    const result = await compactAgentMessagesWithSummary(messages, {
      contextWindowTokens: 1_000,
      reserveTokens: 10,
      recentTokens: 1,
      stateSummary: "files_modified=2, tests=1",
      projectInstructions: "Run pnpm test"
    });
    expect(result.compacted).toBe(true);
    expect(result.messages.some((message) => message.content.includes("files_modified=2"))).toBe(true);
    expect(result.messages.some((message) => message.content.includes("Run pnpm test"))).toBe(true);
  });
});

describe("search and project profile", () => {
  it("finds text in files ignored by the old extension allowlist", () => {
    const root = workspace();
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "Main.java"), "class Main { void run() {} }\n");
    const result = searchFiles({ root, pattern: "void run", include: "*.java" });
    expect(result.matches.some((match) => match.file.endsWith("Main.java"))).toBe(true);
  });

  it("detects Node scripts and package manager", () => {
    const root = workspace();
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "vitest run", lint: "eslint ." } }));
    writeFileSync(join(root, "pnpm-lock.yaml"), "");
    const profile = detectProjectProfile(root);
    expect(["javascript", "typescript"]).toContain(profile.language);
    expect(profile.commands.test).toContain("pnpm");
    expect(profile.commands.lint).toContain("pnpm");
  });
});

describe("todo and command policy", () => {
  it("stores one in-progress todo and reports open work", async () => {
    const ctx = context(workspace());
    const result = await todoWriteTool.execute({ todos: [
      { id: "t1", content: "inspect", status: "completed" },
      { id: "t2", content: "implement", status: "in_progress" }
    ] }, ctx);
    expect(result.isError).not.toBe(true);
    const read = await todoReadTool.execute({}, ctx);
    expect(read.content).toContain("implement");
    expect(todoReminder(ctx.state!.todos)).toContain("todo");
  });

  it("rejects destructive commands and force pushes", () => {
    expect(commandPolicyIssue("rm -rf /")).toBeTruthy();
    expect(commandPolicyIssue("git reset --hard HEAD")).toBeTruthy();
    expect(commandPolicyIssue("git push --force origin main")).toBeTruthy();
    expect(commandPolicyIssue("git status --short")).toBeNull();
  });

  it("allows only read-only commands in plan mode", () => {
    expect(commandPolicyIssue("git status --short", { planMode: true })).toBeNull();
    expect(commandPolicyIssue("rg TODO src", { planMode: true })).toBeNull();
    expect(commandPolicyIssue("npm test", { planMode: true })).toContain("plan mode");
    expect(commandPolicyIssue("rm -rf build", { planMode: true })).toBeTruthy();
    expect(commandPolicyIssue("git push origin main", { planMode: true })).toBeTruthy();
    expect(commandPolicyIssue("echo x > file", { planMode: true })).toBeTruthy();
  });
});

describe("prompt tool contract", () => {
  it("includes repository head, default branch, user and recent commits", () => {
    const block = environmentBlock({
      cwd: "D:/work",
      outDir: "D:/work/out",
      profile: "coding",
      mode: "build",
      git: {
        isRepository: true,
        root: "D:/work",
        branch: "feature/runtime",
        dirty: true,
        changedFiles: 3,
        headSha: "abc1234",
        headSubject: "feat(runtime): add checkpoint state",
        defaultBranch: "main",
        recentCommits: ["abc1234 feat(runtime): add checkpoint state", "def5678 docs: update plan"],
        userName: "Jason"
      }
    });
    expect(block).toContain("git: branch=feature/runtime, dirty=true, changed_files=3");
    expect(block).toContain("git_head: abc1234 feat(runtime): add checkpoint state");
    expect(block).toContain("git_default_branch: main");
    expect(block).toContain("git_user: Jason");
    expect(block).toContain("git_recent:");
    expect(block).toContain("- def5678 docs: update plan");
  });

  it("uses tool schemas instead of duplicating tool descriptions", () => {
    const root = workspace();
    const prompt = codingSystemPrompt({
      workspaceRoot: root,
      outDir: join(root, "out"),
      availableTools: ["read_file", "grep", "finish_task"]
    });
    expect(prompt).toContain("Tool schemas define each tool's arguments");
    expect(prompt).toContain("tool_search");
    expect(prompt).toContain("## Safety");
    expect(prompt).not.toContain("## Tools");
    expect(prompt).not.toContain("- read_file:");
    expect(prompt).not.toContain("read_image");
    expect(prompt).not.toContain("load_skill");
    expect(prompt).not.toContain("delegate_task");
    expect(prompt).not.toContain("▸");
    expect(prompt).not.toContain("2-4 headed sections");
    expect(prompt).toContain("Keep the final answer concise and understandable");
  });

  it("places stable prompt sections before environment context", () => {
    const root = workspace();
    const base = codingPromptSections({ workspaceRoot: root, outDir: join(root, "out") });
    expect(base.map((section) => section.id)).toEqual(["rules", "environment"]);

    const plan = codingPromptSections({ workspaceRoot: root, outDir: join(root, "out"), mode: "plan" });
    expect(plan.map((section) => section.id)).toEqual(["rules", "environment"]);
    const planRules = plan.find((section) => section.id === "rules")?.content ?? "";
    expect(planRules).toContain("This run is read-only");
    expect(planRules).toContain("Call submit_plan");
    expect(planRules).not.toContain("Call finish_task");
  });
});

describe("tool output", () => {
  it("redacts credentials before they reach the model", () => {
    const token = `ghp_${"a".repeat(36)}`;
    const key = `sk-${"b".repeat(32)}`;
    expect(redactSecrets(`token ${token}`)).toContain("[REDACTED_GITHUB_TOKEN]");
    expect(redactSecrets(`api_key=${key}`)).toContain("[REDACTED_API_KEY]");
    expect(redactSecrets("Authorization: Bearer abcdefghijklmnopqrstuvwxyz")).toContain("Bearer [REDACTED]");
    expect(redactSecrets("password=hunter2hunter2")).toContain("password=[REDACTED]");
  });
});

describe("coding completion", () => {
  it("ignores changes that existed before the task and only gates agent edits on tests", () => {
    const root = workspace();
    const source = join(root, "src", "app.ts");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(source, "export const value = 1;\n");
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-qm", "initial"], { cwd: root });
    writeFileSync(source, "export const value = 2;\n");

    const ctx = context(root);
    expect(codingFinishIssue(ctx)).toBeNull();

    recordFileModified(ctx.state, source, "export const value = 3;\n");
    expect(codingFinishIssue(ctx)).toContain("还没有运行过测试");
  });
});

describe("shell sessions", () => {
  it("captures output, exits, and supports explicit kill", async () => {
    const root = workspace();
    const out = join(root, "out");
    const result = await runShellSession({ command: "node -e \"process.stdout.write('hello')\"", cwd: root, outDir: out, timeoutMs: 10_000, unsafeNoSandbox: true });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("hello");
    const started = await startShellSession({ command: "node -e \"setInterval(() => {}, 1000)\"", cwd: tmpdir(), outDir: out, unsafeNoSandbox: true });
    expect(shellOutput(started.sessionId)?.running).toBe(true);
    killShellSession(started.sessionId);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_500));
    expect(shellOutput(started.sessionId)?.running).toBe(false);
  });
});
