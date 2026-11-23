import { describe, expect, it } from "vitest";
import type { ApprovalRecord } from "@hearth/core";
import { approvalView, toolDisplay } from "./approval-display.ts";

function approval(overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
  return {
    id: "approval-1",
    taskId: "task-1",
    runId: "run-1",
    kind: "tool.shell",
    summary: "运行命令",
    target: {},
    preview: {},
    parameterHash: "hash",
    status: "pending",
    expiresAt: "2026-11-23T12:00:00.000Z",
    decidedAt: null,
    effectId: null,
    createdAt: "2026-11-23T11:00:00.000Z",
    ...overrides
  };
}

describe("approval display projection", () => {
  it("extracts labeled tool arguments and redacts sensitive values", () => {
    const view = approvalView(approval({
      target: {
        arguments: {
          command: "npm test",
          cwd: "D:/work/app",
          api_token: "do-not-show",
          options: { authorization: "nested-secret", retries: 2 }
        }
      }
    }));

    expect(view.display).toEqual({
      kind: "tool",
      toolName: "shell",
      fields: [
        { label: "命令", value: "npm test" },
        { label: "工作目录", value: "D:/work/app" },
        { label: "API 令牌", value: "••••••（已隐藏）", redacted: true },
        {
          label: "Options",
          value: '{\n  "authorization": "••••••（已隐藏）",\n  "retries": 2\n}'
        }
      ]
    });
    expect(JSON.stringify(view.display)).not.toContain("do-not-show");
    expect(JSON.stringify(view.display)).not.toContain("nested-secret");
  });

  it("bounds the number and length of displayed fields", () => {
    const argumentsValue = Object.fromEntries([
      ["long_description", "x".repeat(1_500)],
      ...Array.from({ length: 26 }, (_, index) => [`field_${index}`, index])
    ]);
    const display = toolDisplay(approval({
      target: { arguments: argumentsValue }
    }));

    expect(display?.fields).toHaveLength(25);
    expect(display?.fields[0]?.truncated).toBe(true);
    expect(display?.fields.at(-1)?.value).toContain("另有 3 项");
  });

  it("does not add a tool display projection to non-tool approvals", () => {
    expect(toolDisplay(approval({ kind: "email.smtp-send" }))).toBeNull();
  });
});
