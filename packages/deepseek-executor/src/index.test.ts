import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { HarnessNotification } from "@deepseek-ai/dsh-sdk-client";
import {
  buildDshPatch,
  clearStaleCredentialLocks,
  dshPermissionMode,
  ordinaryQuestionMarkdown,
  planReviewMarkdown,
  promptForRun,
  runDeepSeekHarness,
  teamMemberFromNotification,
  teamMemberFromSessionEvent,
  type DeepSeekHarnessRunOptions
} from "./index.ts";

function options(overrides: Partial<DeepSeekHarnessRunOptions["settings"]> = {}): DeepSeekHarnessRunOptions {
  return {
    settings: {
      protocol: "openai-chat",
      baseUrl: "http://127.0.0.1:1",
      model: "test-model",
      apiKey: "test-key",
      ...overrides
    },
    dshHome: ".test-dsh",
    workingDirectory: ".",
    outDir: ".",
    prompt: "test",
    mode: "necessary",
    maxTurns: 1,
    runBudgetSeconds: 30
  };
}

describe("runDeepSeekHarness runtime loading", () => {
  it("loads the optional SDK lazily and validates settings", async () => {
    await expect(runDeepSeekHarness(options({ model: "" }))).rejects.toMatchObject({
      code: "DSH_MODEL_INCOMPLETE"
    });
  });
});

describe("clearStaleCredentialLocks", () => {
  it("removes a lock owned by a dead process but keeps a live owner", () => {
    const root = mkdtempSync(join(tmpdir(), "hearth-dsh-lock-"));
    try {
      writeFileSync(join(root, ".credentials.yaml.lock"), "99999999");
      writeFileSync(join(root, ".credentials.yaml.lock.takeover-dead"), "99999998");
      clearStaleCredentialLocks(root);
      expect(readdirSync(root).filter((name) => name.startsWith(".credentials.yaml.lock"))).toEqual([]);

      writeFileSync(join(root, ".credentials.yaml.lock"), String(process.pid));
      clearStaleCredentialLocks(root);
      expect(readdirSync(root)).toContain(".credentials.yaml.lock");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("buildDshPatch", () => {
  it("loads Hearth library tools through the standard MCP client", () => {
    const patch = buildDshPatch({
      protocol: "openai-chat",
      baseUrl: "http://127.0.0.1:1",
      model: "test-model",
      apiKey: "test-key"
    }, {
      hearth: { command: "node.exe", args: ["library-mcp.mjs"], env: { HEARTH_BASE_URL: "http://127.0.0.1:4317" } }
    });
    expect(patch).toContain("id: mcp-hearth");
    expect(patch).toContain("serverName: \"hearth\"");
    expect(patch).toContain("command: \"node.exe\"");
    expect(patch).toContain("HEARTH_BASE_URL: \"http://127.0.0.1:4317\"");
  });

  it("keeps subagent tools disabled in single mode without inserting the team packages", () => {
    const patch = buildDshPatch({
      protocol: "openai-chat",
      baseUrl: "http://127.0.0.1:1",
      model: "test-model",
      apiKey: "test-key"
    }, {}, { enabled: false });
    expect(patch).toContain("- id: tool-subagent-control");
    expect(patch).toContain("- id: tool-subagent-fork");
    expect(patch).not.toContain("agent-team");
    expect(patch).not.toContain("- insert:");
  });

  it("inserts the team layer with clamped limits in team mode", () => {
    const patch = buildDshPatch({
      protocol: "openai-chat",
      baseUrl: "http://127.0.0.1:1",
      model: "test-model",
      apiKey: "test-key"
    }, {}, { enabled: true, maxMembers: 8, maxTasks: 256 });
    expect(patch).toContain("- id: agent-team");
    expect(patch).toContain("name: '@deepseek-ai/dsh-experimental-agent-team'");
    expect(patch).toContain("maxMembers: 8");
    expect(patch).toContain("maxTasks: 256");
    expect(patch).toContain("maxMessageBytes: 65536");
    expect(patch).toContain("disposalTimeoutMs: 5000");
    expect(patch).toContain("- id: tool-agent-team");
    expect(patch).toContain("freshProvider: spawn");
    expect(patch).toContain("forkProvider: fork");
    expect(patch).not.toContain("ui-agent-team");
  });
});

describe("DSH team member events", () => {
  it("maps documented subagent notifications to started/completed members", () => {
    expect(teamMemberFromNotification({
      method: "subagent/started",
      params: { childId: "child-1", parentId: "root", title: "Researcher" }
    } as HarnessNotification)).toEqual({
      memberId: "child-1",
      parentId: "root",
      status: "started",
      title: "Researcher"
    });
    expect(teamMemberFromNotification({
      method: "subagent/completed",
      params: { memberId: "child-1", name: "Researcher" }
    } as HarnessNotification)).toMatchObject({ memberId: "child-1", parentId: null, status: "completed" });
  });

  it("ignores non-team methods and member events without an id", () => {
    expect(teamMemberFromNotification({ method: "turn/start", params: { id: "x" } } as HarnessNotification)).toBeNull();
    expect(teamMemberFromNotification({ method: "subagent/started", params: {} } as HarnessNotification)).toBeNull();
  });

  it("does not treat the root session heartbeat as a member", () => {
    expect(teamMemberFromSessionEvent("subagent/started", { sessionId: "root" }, "root")).toBeNull();
    expect(teamMemberFromSessionEvent("subagent/started", { sessionId: "root", childId: "child-1" }, "root")).toMatchObject({
      memberId: "child-1",
      status: "started"
    });
  });
});

describe("DSH plan mode", () => {
  it("enters /plan with a hard read-only permission that cannot be widened", () => {
    const planOptions = {
      ...options(),
      planMode: true,
      mode: "full" as const,
      permissionMode: "danger-full-access" as const,
      prompt: "inspect the repository"
    };
    expect(dshPermissionMode(planOptions)).toBe("read-only");
    expect(promptForRun(planOptions)).toBe("/plan inspect the repository");
  });

  it("captures only the full plan-review detail and ignores ordinary questions", () => {
    expect(planReviewMarkdown([
      { intent: { kind: "clarify" }, detail: "Which branch?" },
      { intent: { kind: "plan-review" }, detail: "## 调查结论\n\n- inspected" },
      { intent: { kind: "plan-review" }, detail: "## 执行步骤\n\n1. implement" }
    ])).toBe("## 调查结论\n\n- inspected\n\n## 执行步骤\n\n1. implement");
  });

  it("captures ordinary clarification text without treating it as a plan", () => {
    expect(ordinaryQuestionMarkdown([
      { intent: { kind: "plan-review" }, question: "Review plan", detail: "## 执行步骤" },
      { question: "Which branch should I use?", detail: "Choose the target branch." }
    ])).toBe("Which branch should I use?\n\nChoose the target branch.");
  });
});
