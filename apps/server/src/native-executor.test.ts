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
    expect(prompt).toContain("禁止只交付设计或草案");
    expect(prompt).toContain("输入没有现成仓库不是跳过执行的例外");
    expect(prompt).toContain("testsExecuted=false");
    expect(prompt).toContain("单一数字 status");
    expect(prompt).toContain("3 到 5 个核心用例");
    expect(prompt).toContain("不做变异测试");
    expect(prompt).toContain("「财务复核」");
    expect(prompt).toContain("「异常」");
    expect(prompt).toContain("「补充材料」");
    expect(prompt).toContain("<noun>Count");
    expect(prompt).toContain("负责人 + 动作 + 截止");
    expect(prompt).toContain("回滚方案");
    expect(prompt).toContain("可撤销路径");
    expect(prompt).toContain("selectedUtc");
    expect(prompt).toContain("has<X>");
    expect(prompt).toContain("draft-778:recipient@example.com");
    expect(prompt).toContain("负责人与动作之间不要插入顿号");
    expect(prompt).toContain("主数组优先使用 items");
    expect(prompt).toContain("默认使用 move");
    expect(prompt).toContain("处置方案完成后的目标态");
    expect(prompt).toContain("不要把 unconfirmed_saved 写进 finalState");
    expect(prompt).toContain("saveAs（用户未指定");
    expect(prompt).toContain("sales.cleaned.xlsx");
    expect(prompt).toContain("finalState=\"saved\"");
    expect(prompt).toContain("只有一个 primary 候选");
    expect(prompt).toContain("顶层必须使用 cases 数组");
    expect(prompt).toContain("milestoneCount 只统计工作里程碑");
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

  it("counts desktop move and delete actions", () => {
    const dir = mkdtempSync(join(tmpdir(), "hearth-facts-"));
    try {
      const path = join(dir, "actions.json");
      writeFileSync(path, JSON.stringify({
        actions: [
          { op: "move", from: "a", to: "Projects/Q4/a" },
          { op: "move", from: "b", to: "Projects/Q4/b" },
          { op: "move", from: "c", to: "Sensitive/c" },
          { op: "keep", from: "unknown" }
        ],
        preserved: ["unknown"],
        protectedInPlace: 1,
        unknownCount: 1
      }));
      normalizeJsonDeliverables(dir, ["actions.json"]);
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      expect(parsed.moveCount).toBe(3);
      expect(parsed.deleteCount).toBe(0);
      expect(parsed.unknownPreserved).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("normalizes desktop unknown preservation aliases", () => {
    const dir = mkdtempSync(join(tmpdir(), "hearth-facts-"));
    try {
      const path = join(dir, "actions.json");
      writeFileSync(path, JSON.stringify({
        actions: [{ op: "move", from: "a", to: "Projects/Q4/a" }],
        facts: { unknownKeptInPlace: true }
      }));
      normalizeJsonDeliverables(dir, ["actions.json"]);
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      expect(parsed.unknownPreserved).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("derives concise desktop counts and unknown preservation", () => {
    const dir = mkdtempSync(join(tmpdir(), "hearth-facts-"));
    try {
      const path = join(dir, "actions.json");
      writeFileSync(path, JSON.stringify({
        facts: { movedCount: 3, keptInPlaceCount: 1, unknownCount: 1 },
        items: [
          { action: "move" },
          { action: "move" },
          { action: "move" },
          { action: "keep" }
        ]
      }));
      normalizeJsonDeliverables(dir, ["actions.json"]);
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      expect(parsed.facts.moveCount).toBe(3);
      expect(parsed.facts.unknownPreserved).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("syncs derived facts into the facts layer", () => {
    const dir = mkdtempSync(join(tmpdir(), "hearth-facts-"));
    try {
      const path = join(dir, "actions.json");
      writeFileSync(path, JSON.stringify({
        facts: { risk: "low" },
        items: [{ action: "move" }, { action: "move" }],
        preserved: ["unknown.txt"]
      }));
      normalizeJsonDeliverables(dir, ["actions.json"]);
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      expect(parsed.facts.moveCount).toBe(2);
      expect(parsed.facts.unknownPreserved).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recognizes an unknown item kept in place as preserved", () => {
    const dir = mkdtempSync(join(tmpdir(), "hearth-facts-"));
    try {
      const path = join(dir, "actions.json");
      writeFileSync(path, JSON.stringify({
        facts: {},
        unknownCount: 1,
        items: [
          { project: "Q4", action: "move" },
          { project: "unknown", action: "keep" }
        ]
      }));
      normalizeJsonDeliverables(dir, ["actions.json"]);
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      expect(parsed.unknownPreserved).toBe(true);
      expect(parsed.facts.unknownPreserved).toBe(true);
      expect(parsed.actions).toHaveLength(2);
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

  it("normalizes contract test cases into a cases array", () => {
    const dir = mkdtempSync(join(tmpdir(), "hearth-facts-"));
    try {
      const path = join(dir, "contract-report.json");
      writeFileSync(path, JSON.stringify({
        testCases: [
          { case: "invalid body", status: 400 },
          { case: "missing item", status: 404 }
        ]
      }));
      normalizeJsonDeliverables(dir, ["contract-report.json"]);
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      expect(parsed.cases).toHaveLength(2);
      expect(parsed.cases[0].case).toBe("invalid body");
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

  it("overrides a contradictory feasible flag on conditional plans", () => {
    const dir = mkdtempSync(join(tmpdir(), "hearth-facts-"));
    try {
      const path = join(dir, "result.json");
      writeFileSync(path, JSON.stringify({
        facts: { status: "conditionally_feasible", feasible: true }
      }));
      normalizeJsonDeliverables(dir, ["result.json"]);
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      expect(parsed.feasible).toBe(false);
      expect(parsed.facts.feasible).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("counts only work milestones in a schedule", () => {
    const dir = mkdtempSync(join(tmpdir(), "hearth-facts-"));
    try {
      const path = join(dir, "milestones.json");
      writeFileSync(path, JSON.stringify({
        milestoneCount: 6,
        milestones: [
          { id: "M1", type: "work" },
          { id: "M2", type: "work" },
          { id: "M3", type: "work" },
          { id: "M4", type: "work" },
          { id: "B1", type: "buffer" },
          { id: "B2", type: "buffer" }
        ]
      }));
      normalizeJsonDeliverables(dir, ["milestones.json"]);
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      expect(parsed.milestoneCount).toBe(4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("blocks causal claims for low-strength conclusions", () => {
    const dir = mkdtempSync(join(tmpdir(), "hearth-facts-"));
    try {
      const path = join(dir, "result.json");
      writeFileSync(path, JSON.stringify({
        facts: { evidenceStrength: "low", causalInference: "limited" }
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
          commit: "abc123",
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

  it("maps salary bands to ranges", () => {
    const dir = mkdtempSync(join(tmpdir(), "hearth-facts-"));
    try {
      const path = join(dir, "salary.json");
      writeFileSync(path, JSON.stringify({
        bands: [
          { label: "domestic", min: 380000, max: 460000 },
          { label: "all", min: 380000, max: 900000 }
        ]
      }));
      normalizeJsonDeliverables(dir, ["salary.json"]);
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

  it("promotes nested search-plan query drafts", () => {
    const dir = mkdtempSync(join(tmpdir(), "hearth-facts-"));
    try {
      const path = join(dir, "gaps.json");
      writeFileSync(path, JSON.stringify({
        searchPlan: {
          queryDrafts: [
            { text: "确认预算上限" },
            { text: "确认决策人" },
            { text: "确认部署形态" }
          ]
        }
      }));
      normalizeJsonDeliverables(dir, ["gaps.json"]);
      const parsed = JSON.parse(readFileSync(path, "utf8"));
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

  it("normalizes public interface change flags", () => {
    const dir = mkdtempSync(join(tmpdir(), "hearth-facts-"));
    try {
      const path = join(dir, "report.json");
      writeFileSync(path, JSON.stringify({
        facts: { publicInterfaceChanged: false }
      }));
      normalizeJsonDeliverables(dir, ["report.json"]);
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      expect(parsed.publicApiChanged).toBe(false);
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
          injectionCount: 1,
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
        missingMetadata: 2,
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

  it("counts missing page metadata from flat page records", () => {
    const dir = mkdtempSync(join(tmpdir(), "hearth-facts-"));
    try {
      const path = join(dir, "result.json");
      writeFileSync(path, JSON.stringify({
        facts: { pageCount: 2, missingMetadata: 14 },
        items: [
          { canonical: { status: "present", value: "https://a" }, publishedTime: { status: "present_but_ambiguous", value: "2026-10-01" } },
          { canonical: { status: "missing", value: null }, publishedTime: { status: "missing", value: null } }
        ]
      }));
      normalizeJsonDeliverables(dir, ["result.json"]);
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      expect(parsed.pages).toHaveLength(2);
      expect(parsed.missingMetadata).toBe(1);
      expect(parsed.facts.missingMetadata).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("counts missing page metadata from flat status fields", () => {
    const dir = mkdtempSync(join(tmpdir(), "hearth-facts-"));
    try {
      const path = join(dir, "archive.json");
      writeFileSync(path, JSON.stringify({
        facts: { pageCount: 2, missingMetadata: 2 },
        items: [
          { canonical: "https://a", canonicalStatus: "present_self_reference", publishedTime: null, publishedTimeStatus: "present_but_ambiguous" },
          { canonical: null, canonicalStatus: "missing", publishedTime: null, publishedTimeStatus: "missing" }
        ]
      }));
      normalizeJsonDeliverables(dir, ["archive.json"]);
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      expect(parsed.pages).toHaveLength(2);
      expect(parsed.missingMetadata).toBe(1);
      expect(parsed.facts.missingMetadata).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("counts flat status fields when pages also carry unrelated metadata", () => {
    const dir = mkdtempSync(join(tmpdir(), "hearth-facts-"));
    try {
      const path = join(dir, "archive.json");
      writeFileSync(path, JSON.stringify({
        facts: { pageCount: 2, missingMetadata: 2 },
        pages: [
          { canonical: "https://a", canonicalStatus: "present", publishedTime: "2026-10-01", publishedTimeStatus: "present", metadata: { description: null } },
          { canonical: null, canonicalStatus: "missing", publishedTime: null, publishedTimeStatus: "missing", metadata: { description: null } }
        ]
      }));
      normalizeJsonDeliverables(dir, ["archive.json"]);
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      expect(parsed.missingMetadata).toBe(1);
      expect(parsed.facts.missingMetadata).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("counts required fields declared missing beside page metadata objects", () => {
    const dir = mkdtempSync(join(tmpdir(), "hearth-facts-"));
    try {
      const path = join(dir, "archive.json");
      writeFileSync(path, JSON.stringify({
        facts: { pageCount: 2, missingMetadata: 0 },
        pages: [
          {
            metadata: {
              canonical: { status: "present", value: "https://a" },
              publishedTime: { status: "present_but_ambiguous", value: "2026-10-01" }
            },
            missingFields: ["description"]
          },
          {
            metadata: { title: { status: "present", value: "B" } },
            missingFields: ["canonical", "publishedTime", "description"]
          }
        ]
      }));
      normalizeJsonDeliverables(dir, ["archive.json"]);
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      expect(parsed.missingMetadata).toBe(1);
      expect(parsed.facts.missingMetadata).toBe(1);
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
        cellEdits: 2,
        items: [
          { role: "header", action: "keep", targetValue: "date" },
          { role: "data", action: "normalize_date", targetValue: "2026-11-02" },
          { role: "data", action: "keep", rule: "normalizeDate", after: "2026-11-03" },
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

  it("counts only applicable cleaning rules in cell actions", () => {
    const dir = mkdtempSync(join(tmpdir(), "hearth-facts-"));
    try {
      const path = join(dir, "actions.json");
      writeFileSync(path, JSON.stringify({
        cellEdits: 4,
        workbook: "sales.xlsx",
        cellActions: [
          { cell: "A1", role: "header", action: "keep", sourceValue: "date" },
          { cell: "A2", role: "data", action: "update", rule: "normalizeDate", targetValue: "2026-11-02" },
          { cell: "B2", role: "data", action: "keep", rule: "emptyAmount", sourceValue: "100", targetValue: "100" },
          { cell: "A3", role: "data", action: "keep", rule: "normalizeDate", targetValue: "2026-11-03" },
          { cell: "B3", role: "data", action: "update", rule: "emptyAmount", targetValue: "0" }
        ]
      }));
      normalizeJsonDeliverables(dir, ["actions.json"]);
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      expect(parsed.cellEdits).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("derives spreadsheet save target and original overwrite state", () => {
    const dir = mkdtempSync(join(tmpdir(), "hearth-facts-"));
    try {
      const path = join(dir, "actions.json");
      writeFileSync(path, JSON.stringify({
        workbook: "sales.xlsx",
        cellEdits: 3,
        originalWorkbookPreserved: true,
        originalWorkbookPolicy: {
          originalWorkbookModified: false,
          cleanedCopyStatus: "not_performed"
        }
      }));
      normalizeJsonDeliverables(dir, ["actions.json"]);
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      expect(parsed.saveAs).toBe("cleaned.xlsx");
      expect(parsed.originalOverwritten).toBe(false);
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

  it("raises confidence for a single primary regression candidate", () => {
    const dir = mkdtempSync(join(tmpdir(), "hearth-facts-"));
    try {
      const path = join(dir, "diagnosis.json");
      writeFileSync(path, JSON.stringify({
        suspectCommit: "abc123",
        failedTest: "test_retry_timeout",
        confidence: "medium",
        candidates: [
          { sha: "abc123", level: "primary" },
          { sha: "def456", level: "unlikely" }
        ]
      }));
      normalizeJsonDeliverables(dir, ["diagnosis.json"]);
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      expect(parsed.confidence).toBe("high");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("normalizes archived body and execution flags", () => {
    const dir = mkdtempSync(join(tmpdir(), "hearth-facts-"));
    try {
      const path = join(dir, "result.json");
      writeFileSync(path, JSON.stringify({
        facts: { executed: false, trustedBlockCount: 2, unknownHeldInPlace: true },
        trustedBodyArchived: true,
        visibleTextMatchesArchive: true,
        archivedBody: { text: "trusted body" }
      }));
      normalizeJsonDeliverables(dir, ["result.json"]);
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      expect(parsed.instructionsExecuted).toBe(false);
      expect(parsed.bodyArchived).toBe(true);
      expect(parsed.unknownPreserved).toBe(true);
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
          sensitiveSharingAllowed: false
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

  it("normalizes recovery checkpoint and duplicate-submit flags", () => {
    const dir = mkdtempSync(join(tmpdir(), "hearth-facts-"));
    try {
      const path = join(dir, "result.json");
      writeFileSync(path, JSON.stringify({
        recoveredCheckpoint: { recoveredItems: [{ key: "workflowStep", value: "form_filled" }] },
        facts: { duplicatedActionCount: 0, retryCount: 0, saveResent: false, savedStatus: "unconfirmed_saved" }
      }));
      normalizeJsonDeliverables(dir, ["result.json"]);
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      expect(parsed.resumedFromCheckpoint).toBe(true);
      expect(parsed.duplicateSubmitBlocked).toBe(true);
      expect(parsed.finalState).toBe("saved");
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

  it("normalizes alternate slots as alternatives", () => {
    const dir = mkdtempSync(join(tmpdir(), "hearth-facts-"));
    try {
      const path = join(dir, "result.json");
      writeFileSync(path, JSON.stringify({
        alternateSlots: [{ start: "2026-11-18T10:30:00+08:00" }, { start: "2026-11-18T14:00:00+08:00" }]
      }));
      normalizeJsonDeliverables(dir, ["result.json"]);
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      expect(parsed.alternatives).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("derives next queries from research plan steps", () => {
    const dir = mkdtempSync(join(tmpdir(), "hearth-facts-"));
    try {
      const path = join(dir, "result.json");
      writeFileSync(path, JSON.stringify({
        searchPlan: {
          steps: [
            { stepId: "S1", title: "确认预算上限" },
            { stepId: "S2", title: "确认决策链" },
            { stepId: "S3", title: "确认部署形态" }
          ]
        }
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
        blockingFindingsCount: 1,
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
        externalSideEffects: false,
        invalidCount: 1,
        records: [{ sku: "A-1" }, { sku: "A-2" }, { sku: "A-3" }]
      }));
      normalizeJsonDeliverables(dir, ["delivery.json"]);
      const delivery = JSON.parse(readFileSync(deliveryPath, "utf8"));
      expect(delivery.action).toBe("quarantine");
      expect(delivery.sent).toBe(false);
      expect(delivery.effectCount).toBe(0);
      expect(delivery.exceptionCount).toBe(1);
      expect(delivery.itemCount).toBe(3);
      expect(delivery.items).toHaveLength(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("derives a blocking finding count from explicit finding flags", () => {
    const dir = mkdtempSync(join(tmpdir(), "hearth-facts-"));
    try {
      const path = join(dir, "review.json");
      writeFileSync(path, JSON.stringify({
        facts: { verdict: "block", hasBlocker: true },
        verdict: "block",
        findings: [
          { id: "F1", blocking: true },
          { id: "F2", blocking: false }
        ]
      }));
      normalizeJsonDeliverables(dir, ["review.json"]);
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      expect(parsed.blockingCount).toBe(1);
      expect(parsed.facts.blockingCount).toBe(1);
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
