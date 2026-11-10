import { describe, expect, it } from "vitest";
import { hermesArgs, hermesProbeErrorCode, hermesProgress, hermesStderrProgress, parseHermesEvent, probeHermes } from "./hermes-executor.ts";

describe("Hermes stream-json adapter", () => {
  it("parses init, text, tool and result events", () => {
    expect(parseHermesEvent(JSON.stringify({ type: "system", subtype: "init", session_id: "session-1" }))).toMatchObject({
      type: "system",
      subtype: "init",
      sessionId: "session-1"
    });
    expect(parseHermesEvent(JSON.stringify({ type: "text", text: "正在分析" }))).toMatchObject({
      type: "text",
      text: "正在分析"
    });
    expect(parseHermesEvent(JSON.stringify({ type: "tool_use", name: "search", input: { query: "hearth" }, tool_call_id: "call-1" }))).toMatchObject({
      type: "tool_use",
      name: "search",
      toolCallId: "call-1"
    });
    expect(parseHermesEvent(JSON.stringify({ type: "tool_result", name: "search", output: "found", duration_ms: 42 }))).toMatchObject({
      type: "tool_result",
      output: "found",
      durationMs: 42
    });
    expect(parseHermesEvent(JSON.stringify({
      type: "result",
      text: "完成",
      session_id: "session-1",
      exit_code: 0,
      usage: { input_tokens: 12, output_tokens: 5 }
    }))).toMatchObject({
      type: "result",
      text: "完成",
      sessionId: "session-1",
      usage: { inputTokens: 12, outputTokens: 5 }
    });
  });

  it("maps events to readable progress and structured details", () => {
    const init = parseHermesEvent(JSON.stringify({ type: "system", session_id: "session-1" }));
    expect(hermesProgress(init!)).toMatchObject({ type: "system", message: "Hermes 已启动" });

    const tool = parseHermesEvent(JSON.stringify({ type: "tool_use", name: "search", input: { query: "x" } }));
    expect(hermesProgress(tool!)).toMatchObject({
      type: "tool_use",
      message: "调用工具：search",
      detail: { executorId: "hermes", title: "search", input: { query: "x" } }
    });

    const result = parseHermesEvent(JSON.stringify({ type: "result", text: "最终答复", exit_code: 0 }));
    expect(hermesProgress(result!)).toMatchObject({
      type: "result",
      message: "执行完成",
      detail: { executorId: "hermes", text: "最终答复", exitCode: 0 }
    });
  });

  it("detects approval requests instead of silently allowing them", () => {
    const event = parseHermesEvent(JSON.stringify({ type: "approval_request", message: "需要发邮件授权" }));
    expect(event).toMatchObject({ type: "error", requiresApproval: true });
    expect(hermesProgress(event!)).toMatchObject({ type: "error", message: "需要发邮件授权" });
  });

  it("reports a missing Hermes command as unavailable", async () => {
    const result = await probeHermes("hearth-hermes-command-that-does-not-exist", 1_000);
    expect(result.ok).toBe(false);
    expect(result.version).toBeNull();
    expect(result.error).toContain("--version");
  });

  it("marks Hermes quota and rate-limit failures as quota errors", () => {
    expect(hermesProbeErrorCode("HTTP 429 Too Many Requests")).toBe("HTTP_429");
    expect(hermesProbeErrorCode("provider quota exceeded")).toBe("HTTP_429");
    expect(hermesProbeErrorCode("login required")).toBe("AUTH_FAILED");
  });

  it("publishes stderr chunks and marks quota errors as visible progress", () => {
    expect(hermesStderrProgress("connecting to provider")).toMatchObject({
      type: "stderr",
      detail: { executorId: "hermes", eventType: "stderr", status: "running" }
    });
    expect(hermesStderrProgress("HTTP 429 Too Many Requests")).toMatchObject({
      type: "stderr",
      message: expect.stringContaining("额度或频率限制"),
      detail: { executorId: "hermes", eventType: "stderr", status: "quota_exceeded" }
    });
  });

  it("passes an existing session back to Hermes when resuming", () => {
    const args = hermesArgs({
      promptPath: "prompt.md",
      mode: "full",
      maxTurns: 4,
      runBudgetSeconds: 90,
      resumeSessionId: "session-42"
    });
    expect(args).toContain("--resume");
    expect(args.slice(args.indexOf("--resume"))).toEqual(["--resume", "session-42"]);
    expect(args).toContain("--yolo");
  });
});
