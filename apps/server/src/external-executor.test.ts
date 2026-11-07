import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExecutorLaunch } from "./executor-runtime.ts";
import {
  kimiArgs,
  runExternalExecutor,
  workbuddyArgs,
  zcodeArgs,
  type ExternalProgress,
  type ExternalRunOptions
} from "./external-executor.ts";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "hearth-external-"));
  roots.push(root);
  return root;
}

function launch(id: "qoder" | "workbuddy" | "zcode" | "kimi", script: string): ExecutorLaunch {
  return {
    id,
    kind: id === "qoder" ? "qoder-sdk" : "node-script",
    command: process.execPath,
    args: id === "qoder" ? [] : [script],
    env: {},
    source: "configured",
    script,
    display: script
  };
}

function options(
  id: "qoder" | "workbuddy" | "zcode" | "kimi",
  script: string,
  root: string,
  progress: string[] = []
): ExternalRunOptions {
  return {
    id,
    launch: launch(id, script),
    workingDirectory: root,
    prompt: "prepare result.md",
    mode: "full",
    maxTurns: 4,
    runBudgetSeconds: 60,
    resumeSessionId: "resume-1",
    onProgress: (event) => progress.push(event.detail?.eventType ?? event.type)
  };
}

describe("external executor runners", () => {
  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it("builds defensive CLI arguments", () => {
    expect(kimiArgs({ prompt: "hello", resumeSessionId: "s1" })).toEqual([
      "-p", "hello", "--output-format", "stream-json", "-r", "s1"
    ]);
    expect(workbuddyArgs({ mode: "full", resumeSessionId: "s2" })).toEqual([
      "-p", "--output-format", "stream-json", "--verbose", "-y", "-r", "s2"
    ]);
    expect(zcodeArgs({ prompt: "hello", workingDirectory: "C:\\work", mode: "necessary" })).toEqual([
      "--prompt", "hello", "--json", "--cwd", "C:\\work", "--mode", "guarded"
    ]);
  });

  it("streams Kimi output and captures the resume hint", async () => {
    const root = tempRoot();
    const script = join(root, "kimi.mjs");
    writeFileSync(script, [
      "console.log(JSON.stringify({ role: 'meta', type: 'session.resume_hint', session_id: 'kimi-session' }));",
      "console.log(JSON.stringify({ role: 'assistant', content: 'Kimi final' }));"
    ].join("\n"), "utf8");
    const progress: string[] = [];

    const result = await runExternalExecutor(options("kimi", script, root, progress));
    expect(result.finalResponse).toBe("Kimi final");
    expect(result.sessionId).toBe("kimi-session");
    expect(progress).toContain("text");
  });

  it("passes the WorkBuddy prompt on stdin and parses stream-json", async () => {
    const root = tempRoot();
    const script = join(root, "workbuddy.mjs");
    writeFileSync(script, [
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => {",
      "  console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'wb-session' }));",
      "  console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: `stdin=${input}` }] } }));",
      "  console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'WorkBuddy final', session_id: 'wb-session', usage: { input_tokens: 3, output_tokens: 2 } }));",
      "});"
    ].join("\n"), "utf8");

    const result = await runExternalExecutor(options("workbuddy", script, root));
    expect(result.finalResponse).toBe("WorkBuddy final");
    expect(result.sessionId).toBe("wb-session");
    expect(result.usage).toMatchObject({ inputTokens: 3, outputTokens: 2 });
  });

  it("parses ZCode one-shot JSON output", async () => {
    const root = tempRoot();
    const script = join(root, "zcode.mjs");
    writeFileSync(script, [
      "console.log(JSON.stringify({ sessionId: 'zcode-session', response: 'ZCode final', usage: { input_tokens: 5, output_tokens: 1 } }));"
    ].join("\n"), "utf8");

    const result = await runExternalExecutor(options("zcode", script, root));
    expect(result.finalResponse).toBe("ZCode final");
    expect(result.sessionId).toBe("zcode-session");
    expect(result.usage?.inputTokens).toBe(5);
  });

  it("drives the Qoder SDK query API", async () => {
    const root = tempRoot();
    const script = join(root, "qoder-sdk.mjs");
    writeFileSync(script, [
      "export function qodercliAuth() { return { type: 'test' }; }",
      "export async function* query(input) {",
      "  yield { type: 'system', subtype: 'init', session_id: 'qoder-session' };",
      "  yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Qoder working' }, { type: 'tool_use', name: 'read_file', input: { path: 'README.md' } }] } };",
      "  yield { type: 'result', subtype: 'success', result: `Qoder final ${input.options.resume}`, usage: { input_tokens: 8, output_tokens: 4 }, duration_ms: 2 };",
      "}"
    ].join("\n"), "utf8");
    const progress: ExternalProgress[] = [];

    const result = await runExternalExecutor({
      ...options("qoder", script, root),
      onProgress: (event) => progress.push(event)
    });
    expect(result.finalResponse).toBe("Qoder final resume-1");
    expect(result.sessionId).toBe("qoder-session");
    expect(result.usage).toMatchObject({ inputTokens: 8, outputTokens: 4 });
    expect(progress.map((event) => event.type)).toContain("tool_use");
  });
});
