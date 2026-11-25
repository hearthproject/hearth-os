import { describe, expect, it } from "vitest";
import type { AgentCheckpoint, JournalEvent } from "@hearth/agent-runtime";
import {
  BROWSER_REDACTED_TEXT,
  browserToolSecrets,
  redactBrowserToolArguments,
  redactKnownSecrets,
  sanitizeNativeCheckpoint,
  sanitizeRuntimeJournalEvent
} from "./browser-redaction.ts";

const typedSecret = "login-P@ssword-2026";

describe("browser redaction", () => {
  it("redacts direct and deferred browser text arguments", () => {
    expect(redactBrowserToolArguments("browser_type", {
      ref: "2:e4",
      text: typedSecret
    })).toEqual({ ref: "2:e4", text: BROWSER_REDACTED_TEXT });

    expect(redactBrowserToolArguments("tool_call", {
      name: "browser_type_at",
      arguments: { x: 20, y: 30, text: typedSecret }
    })).toEqual({
      name: "browser_type_at",
      arguments: { x: 20, y: 30, text: BROWSER_REDACTED_TEXT }
    });
    expect(browserToolSecrets("tool_call", {
      name: "browser_type_at",
      arguments: { x: 20, y: 30, text: typedSecret }
    })).toEqual([typedSecret]);
  });

  it("removes typed values from checkpoint messages, summaries and raw arguments", () => {
    const checkpoint = {
      seq: 3,
      kind: "turn",
      messages: [
        {
          role: "assistant",
          content: `正在填写 ${typedSecret}`,
          toolCalls: [{
            id: "call-1",
            name: "browser_type",
            arguments: { ref: "1:e2", text: typedSecret },
            rawArguments: JSON.stringify({ ref: "1:e2", text: typedSecret })
          }]
        },
        {
          role: "tool",
          toolCallId: "call-1",
          name: "browser_type",
          content: `输入的值为 ${typedSecret}`
        }
      ],
      usage: { inputTokens: 1, outputTokens: 1 },
      turns: 1,
      toolCalls: 1,
      summary: `用户密码是 ${typedSecret}`
    } as unknown as AgentCheckpoint;

    const safe = sanitizeNativeCheckpoint(checkpoint);
    expect(JSON.stringify(safe)).not.toContain(typedSecret);
    expect(safe.messages[0]).toMatchObject({
      toolCalls: [{ arguments: { text: BROWSER_REDACTED_TEXT } }]
    });
  });

  it("scrubs runtime journal calls, results and assistant tool calls", () => {
    const events: JournalEvent[] = [
      {
        seq: 1,
        at: "2026-11-25T00:00:00.000Z",
        type: "tool.call",
        callId: "call-1",
        name: "browser_type",
        args: { ref: "1:e2", text: typedSecret }
      },
      {
        seq: 2,
        at: "2026-11-25T00:00:01.000Z",
        type: "tool.result",
        callId: "call-1",
        name: "browser_type",
        message: { role: "tool", toolCallId: "call-1", name: "browser_type", content: `echo ${typedSecret}` }
      },
      {
        seq: 3,
        at: "2026-11-25T00:00:02.000Z",
        type: "message",
        message: {
          role: "assistant",
          content: `I entered ${typedSecret}`,
          toolCalls: [{
            id: "call-2",
            name: "browser_type_at",
            arguments: { x: 1, y: 2, text: typedSecret },
            rawArguments: JSON.stringify({ x: 1, y: 2, text: typedSecret })
          }]
        }
      },
      {
        seq: 4,
        at: "2026-11-25T00:00:03.000Z",
        type: "message",
        message: { role: "assistant", content: `Later echo ${typedSecret}`, toolCalls: [] }
      }
    ];

    const knownSecrets = new Set<string>();
    const sanitized = events.map((event) => {
      if (event.type === "tool.call" && typeof event.name === "string") {
        for (const secret of browserToolSecrets(event.name, event.args)) knownSecrets.add(secret);
      }
      return sanitizeRuntimeJournalEvent(event, knownSecrets);
    });
    const serialized = JSON.stringify(sanitized);
    expect(serialized).not.toContain(typedSecret);
    expect(redactKnownSecrets(`x ${typedSecret} y`, [typedSecret])).toBe(`x ${BROWSER_REDACTED_TEXT} y`);
  });
});
