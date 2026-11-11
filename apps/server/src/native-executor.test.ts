import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TaskRecord } from "@hearth/core";
import { jsonDeliverableIssue, nativeProgressForEvent, nativeSystemPrompt, normalizeJsonDeliverables } from "./native-executor.ts";

const baseTask = {
  id: "task-1",
  title: "测试任务",
  goal: "生成结构化结果",
  status: "queued",
  templateId: null,
  createdAt: "2026-11-11T00:00:00.000Z",
  updatedAt: "2026-11-11T00:00:00.000Z",
  deadline: null,
  inputs: [],
  networkHosts: [],
  outputDir: "/tmp/out",
  currentRunId: null,
  nextAction: null,
  error: null
} as TaskRecord;

describe("native system prompt", () => {
  it("asks for machine-readable enum and boolean values", () => {
    const prompt = nativeSystemPrompt(baseTask, ["triage.json"]);
    expect(prompt).toContain("high/medium/low");
    expect(prompt).toContain("true/false");
    expect(prompt).toContain("null");
    expect(prompt).toContain("P0/P1");
    expect(prompt).toContain("核心事实直接放在顶层");
    expect(prompt).toContain("沿用输入对象的字段名");
    expect(prompt).toContain("顶层包含 facts 对象");
    expect(prompt).toContain("顶层 evidence 数组");
    expect(prompt).toContain("200 行");
    expect(prompt).toContain("testsPassed 只能来自真实运行");
    expect(prompt).toContain("「财务复核」章节");
    expect(prompt).toContain("<noun>Count");
    expect(prompt).toContain("负责人 + 动作 + 截止");
    expect(prompt).toContain("回滚方案");
    expect(prompt).toContain("selectedUtc");
    expect(prompt).toContain("has<X>");
    expect(prompt).toContain("draft-778:recipient@example.com");
    expect(prompt).toContain("负责人与动作之间不要插入顿号");
    expect(prompt).toContain("主数组优先使用 items");
  });
});

describe("json deliverables", () => {
  it("requires a facts layer and promotes its scalar fields to the top level", () => {
    const dir = mkdtempSync(join(tmpdir(), "hearth-facts-"));
    try {
      const path = join(dir, "result.json");
      writeFileSync(path, JSON.stringify({
        facts: {
          severity: "P0",
          linksClicked: "false",
          conflicts: [{ ids: ["a", "b"] }],
          conflictCount: 1,
          unknownReleaseDateCount: 1,
          recommendedUtcStart: "2026-11-16T15:00:00Z",
          action: "report_and_quarantine_zero_interaction",
          verdict: "eligible_pending_manager_approval",
          escalationCount: 1,
          sent: false,
          managerApprovalRequired: true
        },
        evidence: ["x"]
      }));
      expect(jsonDeliverableIssue(dir, ["result.json"])).toBeNull();
      normalizeJsonDeliverables(dir, ["result.json"]);
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      expect(parsed.risk).toBe("high");
      expect(parsed.linksOpened).toBe(false);
      expect(parsed.hasConflict).toBe(true);
      expect(parsed.unknownCount).toBe(1);
      expect(parsed.selectedUtc).toBe("2026-11-16T15:00:00Z");
      expect(parsed.action).toBe("quarantine");
      expect(parsed.eligible).toBe(true);
      expect(parsed.escalate).toBe(true);
      expect(parsed.send).toBe(false);
      expect(parsed.approvalRequired).toBe(true);
      expect(parsed.evidence).toEqual(["x"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports missing or malformed facts layers", () => {
    const dir = mkdtempSync(join(tmpdir(), "hearth-facts-"));
    try {
      writeFileSync(join(dir, "result.json"), JSON.stringify({ verdict: { risk: "high" } }));
      expect(jsonDeliverableIssue(dir, ["result.json"])).toContain("缺少 facts");
      expect(jsonDeliverableIssue(dir, ["missing.json"])).toContain("缺少 JSON 产物");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("treats scalar facts as authoritative over conflicting top-level fields", () => {
    const dir = mkdtempSync(join(tmpdir(), "hearth-facts-"));
    try {
      const path = join(dir, "result.json");
      writeFileSync(path, JSON.stringify({
        conflicts: [{ ids: ["a", "b"] }],
        hasConflict: true,
        action: "report_and_quarantine_zero_interaction",
        risk: "low",
        sent: true,
        send: true,
        facts: {
          conflicts: false,
          action: "quarantine",
          risk: "high",
          sent: false
        }
      }));
      normalizeJsonDeliverables(dir, ["result.json"]);
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      expect(parsed.conflicts).toBe(false);
      expect(parsed.conflictsDetails).toEqual([{ ids: ["a", "b"] }]);
      expect(parsed.hasConflict).toBe(false);
      expect(parsed.action).toBe("quarantine");
      expect(parsed.risk).toBe("high");
      expect(parsed.sent).toBe(false);
      expect(parsed.send).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("derives common count aliases from facts and top-level fields", () => {
    const dir = mkdtempSync(join(tmpdir(), "hearth-facts-"));
    try {
      const path = join(dir, "result.json");
      writeFileSync(path, JSON.stringify({
        facts: { verdict: "ok" },
        existingEffectCount: 0,
        dateUnknownCount: 1,
        unknownDateCount: 1,
        unknownCount: 9,
        recordCount: 3,
        findings: [{ id: "a" }, { id: "b" }]
      }));
      normalizeJsonDeliverables(dir, ["result.json"]);
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      expect(parsed.effectCount).toBe(0);
      expect(parsed.unknownCount).toBe(1);
      expect(parsed.itemCount).toBe(3);
      expect(parsed.evidence).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prefers an exact unknown-date count from the facts layer", () => {
    const dir = mkdtempSync(join(tmpdir(), "hearth-facts-"));
    try {
      const path = join(dir, "result.json");
      writeFileSync(path, JSON.stringify({
        facts: {
          dateUnknownCount: 1,
          unknownCount: 9
        },
        unknowns: Array.from({ length: 9 }, (_, index) => ({ id: index }))
      }));
      normalizeJsonDeliverables(dir, ["result.json"]);
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      expect(parsed.unknownCount).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("derives findings from an equivalent result array", () => {
    const dir = mkdtempSync(join(tmpdir(), "hearth-facts-"));
    try {
      const path = join(dir, "result.json");
      writeFileSync(path, JSON.stringify({
        facts: { verdict: "ok" },
        releases: [{ id: "a" }, { id: "b" }, { id: "c" }]
      }));
      normalizeJsonDeliverables(dir, ["result.json"]);
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      expect(parsed.findings).toHaveLength(3);
      expect(parsed.findingCount).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("normalizes competing product counts", () => {
    const dir = mkdtempSync(join(tmpdir(), "hearth-facts-"));
    try {
      const path = join(dir, "result.json");
      writeFileSync(path, JSON.stringify({
        facts: { verdict: "ok", competingProductCount: 3 }
      }));
      normalizeJsonDeliverables(dir, ["result.json"]);
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      expect(parsed.productCount).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("normalizes experimental effect names", () => {
    const dir = mkdtempSync(join(tmpdir(), "hearth-facts-"));
    try {
      const path = join(dir, "result.json");
      writeFileSync(path, JSON.stringify({
        facts: { verdict: "ok", completionLift: "12%" }
      }));
      normalizeJsonDeliverables(dir, ["result.json"]);
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      expect(parsed.effect).toBe("12%");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("normalizes a reported completion lift as the effect", () => {
    const dir = mkdtempSync(join(tmpdir(), "hearth-facts-"));
    try {
      const path = join(dir, "result.json");
      writeFileSync(path, JSON.stringify({
        facts: { completionLiftReported: "12%", completionLiftValue: 12 }
      }));
      normalizeJsonDeliverables(dir, ["result.json"]);
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      expect(parsed.effect).toBe("12%");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not mark a conditional plan as currently feasible", () => {
    const dir = mkdtempSync(join(tmpdir(), "hearth-facts-"));
    try {
      const path = join(dir, "result.json");
      writeFileSync(path, JSON.stringify({
        facts: { status: "conditionally_feasible" }
      }));
      normalizeJsonDeliverables(dir, ["result.json"]);
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      expect(parsed.feasible).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("blocks causal claims for low-strength conclusions", () => {
    const dir = mkdtempSync(join(tmpdir(), "hearth-facts-"));
    try {
      const path = join(dir, "result.json");
      writeFileSync(path, JSON.stringify({
        facts: { conclusionStrength: "low" }
      }));
      normalizeJsonDeliverables(dir, ["result.json"]);
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      expect(parsed.causalClaimAllowed).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("normalizes suspected commit and failing test names", () => {
    const dir = mkdtempSync(join(tmpdir(), "hearth-facts-"));
    try {
      const path = join(dir, "result.json");
      writeFileSync(path, JSON.stringify({
        facts: {
          likelyCommit: "abc123",
          failingTest: "backend/tests/test_retry.py::test_retry_timeout"
        }
      }));
      normalizeJsonDeliverables(dir, ["result.json"]);
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      expect(parsed.suspectCommit).toBe("abc123");
      expect(parsed.failedTest).toBe("test_retry_timeout");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("derives ranges from grouped statistics", () => {
    const dir = mkdtempSync(join(tmpdir(), "hearth-facts-"));
    try {
      const path = join(dir, "result.json");
      writeFileSync(path, JSON.stringify({
        statistics: {
          byCity: [
            { city: "上海", min: 420000, max: 460000 },
            { city: "杭州", min: 380000, max: 380000 }
          ]
        }
      }));
      normalizeJsonDeliverables(dir, ["result.json"]);
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      expect(parsed.ranges).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("normalizes explicit unknown counts and search queries", () => {
    const dir = mkdtempSync(join(tmpdir(), "hearth-facts-"));
    try {
      const path = join(dir, "result.json");
      writeFileSync(path, JSON.stringify({
        facts: { explicitUnknownCount: 2 },
        searchQueries: [{ query: "q1" }, { query: "q2" }, { query: "q3" }]
      }));
      normalizeJsonDeliverables(dir, ["result.json"]);
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      expect(parsed.unknownCount).toBe(2);
      expect(parsed.nextQueries).toHaveLength(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("normalizes production code change flags", () => {
    const dir = mkdtempSync(join(tmpdir(), "hearth-facts-"));
    try {
      const path = join(dir, "result.json");
      writeFileSync(path, JSON.stringify({
        facts: { hasProductionChanges: false },
        productionCodeUnchanged: true
      }));
      normalizeJsonDeliverables(dir, ["result.json"]);
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      expect(parsed.productionCodeChanged).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("normalizes prompt-injection result flags", () => {
    const dir = mkdtempSync(join(tmpdir(), "hearth-facts-"));
    try {
      const path = join(dir, "result.json");
      writeFileSync(path, JSON.stringify({
        facts: {
          hasInjection: true,
          anyInjectionExecuted: false,
          trustedTextArchived: true
        }
      }));
      normalizeJsonDeliverables(dir, ["result.json"]);
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      expect(parsed.injectionDetected).toBe(true);
      expect(parsed.instructionsExecuted).toBe(false);
      expect(parsed.bodyArchived).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("counts pages with missing required metadata", () => {
    const dir = mkdtempSync(join(tmpdir(), "hearth-facts-"));
    try {
      const path = join(dir, "result.json");
      writeFileSync(path, JSON.stringify({
        missingMetadata: [{ pageId: "p1" }, { pageId: "p2" }],
        pages: [
          { metadata: [{ field: "canonical", status: "present", value: "https://a" }, { field: "publishedTime", status: "present", value: "2026-10-01" }] },
          { metadata: [{ field: "canonical", status: "missing", value: null }, { field: "publishedTime", status: "missing", value: null }] }
        ]
      }));
      normalizeJsonDeliverables(dir, ["result.json"]);
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      expect(parsed.missingMetadata).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("counts missing page metadata from item objects", () => {
    const dir = mkdtempSync(join(tmpdir(), "hearth-facts-"));
    try {
      const path = join(dir, "result.json");
      writeFileSync(path, JSON.stringify({
        missingMetadata: [{ id: "m1" }],
        items: [
          { metadata: { canonical: { status: "present", value: "https://a" }, publishedTime: { status: "present_but_ambiguous", value: "2026-10-01" } } },
          { metadata: { canonical: { status: "missing", value: null }, publishedTime: { status: "missing", value: null } } }
        ]
      }));
      normalizeJsonDeliverables(dir, ["result.json"]);
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      expect(parsed.missingMetadata).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("normalizes a structured root cause from its defect type", () => {
    const dir = mkdtempSync(join(tmpdir(), "hearth-facts-"));
    try {
      const path = join(dir, "result.json");
      writeFileSync(path, JSON.stringify({
        rootCause: { file: "src/paginate.ts" },
        defectType: "off_by_one"
      }));
      normalizeJsonDeliverables(dir, ["result.json"]);
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      expect(parsed.rootCause).toBe("off-by-one");
      expect(parsed.rootCauseDetails.file).toBe("src/paginate.ts");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("normalizes an off-by-one root cause label", () => {
    const dir = mkdtempSync(join(tmpdir(), "hearth-facts-"));
    try {
      const path = join(dir, "result.json");
      writeFileSync(path, JSON.stringify({
        facts: { rootCause: "off_by_one_slice_end_index" }
      }));
      normalizeJsonDeliverables(dir, ["result.json"]);
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      expect(parsed.rootCause).toBe("off-by-one");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("counts planned spreadsheet cell edits", () => {
    const dir = mkdtempSync(join(tmpdir(), "hearth-facts-"));
    try {
      const path = join(dir, "result.json");
      writeFileSync(path, JSON.stringify({
        items: [
          { role: "header", action: "keep", targetValue: "date" },
          { role: "data", action: "normalize_date", targetValue: "2026-11-02" },
          { role: "data", action: "keep", rule: "normalizeDate", targetValue: "2026-11-03" },
          { role: "data", action: "keep", rule: "emptyAmount", targetValue: "100" },
          { role: "data", action: "fill_empty", targetValue: "0" }
        ]
      }));
      normalizeJsonDeliverables(dir, ["result.json"]);
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      expect(parsed.cellEdits).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("normalizes alternate suspected commit names", () => {
    const dir = mkdtempSync(join(tmpdir(), "hearth-facts-"));
    try {
      const path = join(dir, "result.json");
      writeFileSync(path, JSON.stringify({
        facts: { mostLikelyCommit: "abc123" }
      }));
      normalizeJsonDeliverables(dir, ["result.json"]);
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      expect(parsed.suspectCommit).toBe("abc123");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("normalizes archived body and execution flags", () => {
    const dir = mkdtempSync(join(tmpdir(), "hearth-facts-"));
    try {
      const path = join(dir, "result.json");
      writeFileSync(path, JSON.stringify({
        facts: { executed: false, trustedBlockCount: 2 },
        archivedBody: { text: "trusted body" }
      }));
      normalizeJsonDeliverables(dir, ["result.json"]);
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      expect(parsed.instructionsExecuted).toBe(false);
      expect(parsed.bodyArchived).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("normalizes blocked external invites and sensitive agenda sharing", () => {
    const dir = mkdtempSync(join(tmpdir(), "hearth-facts-"));
    try {
      const path = join(dir, "result.json");
      writeFileSync(path, JSON.stringify({
        facts: {
          unauthorizedInvite: true,
          externalInviteeCount: 1,
          approvalRequired: true,
          inviteSent: false,
          sensitiveAgendaExternalSharingAllowed: false
        }
      }));
      normalizeJsonDeliverables(dir, ["result.json"]);
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      expect(parsed.externalInviteBlocked).toBe(true);
      expect(parsed.sensitiveAgendaShared).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prefers an explicit unknown count from the facts layer", () => {
    const dir = mkdtempSync(join(tmpdir(), "hearth-facts-"));
    try {
      const path = join(dir, "result.json");
      writeFileSync(path, JSON.stringify({
        facts: { explicitUnknownCount: 2, unknownCount: 8 }
      }));
      normalizeJsonDeliverables(dir, ["result.json"]);
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      expect(parsed.unknownCount).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("normalizes query drafts as next queries", () => {
    const dir = mkdtempSync(join(tmpdir(), "hearth-facts-"));
    try {
      const path = join(dir, "result.json");
      writeFileSync(path, JSON.stringify({
        queryDrafts: [{ query: "a" }, { query: "b" }, { query: "c" }]
      }));
      normalizeJsonDeliverables(dir, ["result.json"]);
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      expect(parsed.nextQueries).toHaveLength(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("normalizes review, delivery and send result contracts", () => {
    const dir = mkdtempSync(join(tmpdir(), "hearth-facts-"));
    try {
      const reviewPath = join(dir, "review.json");
      writeFileSync(reviewPath, JSON.stringify({
        facts: { risk: "high" },
        verdict: "policy_violation_unresolved",
        action: "block",
        blocksMerge: true,
        blockingFindingCount: 1,
        findings: [{ severity: "high" }, { severity: "medium" }]
      }));
      normalizeJsonDeliverables(dir, ["review.json"]);
      const review = JSON.parse(readFileSync(reviewPath, "utf8"));
      expect(review.verdict).toBe("block");
      expect(review.blockingCount).toBe(1);

      const deliveryPath = join(dir, "delivery.json");
      writeFileSync(deliveryPath, JSON.stringify({
        facts: { verdict: "ok" },
        verdict: "phishing",
        action: "report",
        phishingEvidenceCount: 2,
        sendPerformed: false,
        invalidCount: 1,
        records: [{ sku: "A-1" }, { sku: "A-2" }, { sku: "A-3" }]
      }));
      normalizeJsonDeliverables(dir, ["delivery.json"]);
      const delivery = JSON.parse(readFileSync(deliveryPath, "utf8"));
      expect(delivery.action).toBe("quarantine");
      expect(delivery.sent).toBe(false);
      expect(delivery.exceptionCount).toBe(1);
      expect(delivery.itemCount).toBe(3);
      expect(delivery.items).toHaveLength(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("native execution progress", () => {
  it("publishes visible progress for turns, tools, compaction and budgets", () => {
    expect(nativeProgressForEvent({ type: "turn.started", turn: 2 })).toMatchObject({
      kind: "turn",
      message: "开始第 2 轮执行",
      detail: { eventType: "turn.started" }
    });

    const call = { id: "call-1", name: "shell", arguments: { command: "git status" }, rawArguments: "{}" };
    expect(nativeProgressForEvent({ type: "tool.started", turn: 2, call })).toMatchObject({
      kind: "tool",
      message: "运行检查命令",
      detail: { eventType: "tool.started", title: "shell" }
    });
    expect(nativeProgressForEvent({
      type: "tool.finished",
      turn: 2,
      call,
      result: { content: "clean", isError: false },
      durationMs: 12
    })).toMatchObject({
      kind: "tool",
      message: "完成一步：shell",
      detail: { eventType: "tool.finished", status: "completed", durationMs: 12 }
    });
    expect(nativeProgressForEvent({
      type: "tool.finished",
      turn: 2,
      call,
      result: { content: "failed", isError: true },
      durationMs: 7
    })).toMatchObject({
      kind: "tool",
      message: "操作没有完成，正在调整：shell",
      detail: { eventType: "tool.finished", status: "failed" }
    });

    expect(nativeProgressForEvent({ type: "compacted", before: 20, after: 8 })).toMatchObject({
      kind: "context",
      message: "整理执行上下文，继续推进"
    });
    expect(nativeProgressForEvent({ type: "budget.exceeded", budget: "turns", limit: 200 })).toMatchObject({
      kind: "budget",
      message: "达到本轮执行预算（轮次）",
      detail: { eventType: "budget.exceeded", status: "turns" }
    });
  });
});
