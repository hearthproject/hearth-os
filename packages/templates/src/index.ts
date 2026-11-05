import type { TaskInput } from "@hearth/core";
import { TEMPLATE_ACCEPTANCE } from "./acceptance.ts";

export type TemplateCategory = "document" | "web" | "code" | "data" | "people" | "marketing";

export interface TaskRuntimeSpec {
  python?: {
    version: string;
    workingDirectory: string;
    requirements: string[];
  };
  node?: {
    workingDirectory: string;
    install: "ci" | "install";
  };
  optional?: boolean;
}

export interface TaskTemplate {
  id: string;
  title: string;
  category: TemplateCategory;
  description: string;
  goal: string;
  inputs: TaskInput[];
  networkHosts: string[];
  outputDir: string;
  expectedOutputs: string[];
  acceptance: string[];
  approvalKind: "none" | "github.publish-pr" | "github.comment";
  github: null | { repo: string; issue?: number; pull?: number; headSha?: string; branch?: string; runtime?: TaskRuntimeSpec };
}

const file = (label: string, value: string): TaskInput => ({ kind: "file", label, value });
const url = (label: string, value: string): TaskInput => ({ kind: "url", label, value });

const TEMPLATE_DEFINITIONS: Omit<TaskTemplate, "acceptance">[] = [
  {
    id: "T01", title: "会议转写转行动纪要", category: "document", description: "把原始会议记录整理成结论、行动项和待确认问题。",
    goal: "根据会议原始记录生成可直接发送的行动纪要，保留来源索引，不编造未讨论的信息。",
    inputs: [file("会议原始记录", "eval/inputs/T01-meeting-transcript.md")], networkHosts: [],
    outputDir: "eval/runs/T01", expectedOutputs: ["meeting-notes.md"], approvalKind: "none", github: null
  },
  {
    id: "T02", title: "合同条款与义务提取", category: "document", description: "提取 SaaS 合同中的关键义务、期限、金额和缺失附件。",
    goal: "生成合同条款清单，逐项标注页码、风险、责任方和需要法务确认的问题。",
    inputs: [file("SaaS 合同", "eval/inputs/T02-saas-contract.md")], networkHosts: [],
    outputDir: "eval/runs/T02", expectedOutputs: ["clause-checklist.md"], approvalKind: "none", github: null
  },
  {
    id: "T03", title: "多报告合并为执行摘要", category: "document", description: "合并三份报告，保留冲突与来源。",
    goal: "生成面向管理层的执行摘要，明确共识、冲突、关键数字和决策建议。",
    inputs: [file("报告 A", "eval/inputs/T03-report-a.md"), file("报告 B", "eval/inputs/T03-report-b.md"), file("报告 C", "eval/inputs/T03-report-c.md")], networkHosts: [],
    outputDir: "eval/runs/T03", expectedOutputs: ["executive-summary.md"], approvalKind: "none", github: null
  },
  {
    id: "T04", title: "指定网页归档为 Markdown", category: "web", description: "抓取三篇公开网页并保留来源清单。",
    goal: "把指定网页正文归档为 Markdown，保留标题、表格、代码块、链接和抓取证据。",
    inputs: [url("MDN HTTP 指南", "https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Overview"), url("GitHub Issues 文档", "https://docs.github.com/en/issues/tracking-your-work-with-issues/learning-about-issues/about-issues"), url("WCAG 2.2 快速参考", "https://www.w3.org/WAI/WCAG22/quickref/")],
    networkHosts: ["developer.mozilla.org", "docs.github.com", "www.w3.org"], outputDir: "eval/runs/T04",
    expectedOutputs: ["pages/", "manifest.json"], approvalKind: "none", github: null
  },
  {
    id: "T05", title: "竞品公开定价与功能对比", category: "web", description: "整理 ClickUp、Linear、Asana 的公开套餐信息。",
    goal: "生成有来源的竞品定价与功能对比表；未公开内容标记为未公开，不推测价格。",
    inputs: [url("ClickUp Pricing", "https://clickup.com/pricing"), url("Linear Pricing", "https://linear.app/pricing"), url("Asana Pricing", "https://asana.com/pricing")],
    networkHosts: ["clickup.com", "linear.app", "asana.com"], outputDir: "eval/runs/T05",
    expectedOutputs: ["competitor-comparison.md"], approvalKind: "none", github: null
  },
  {
    id: "T06", title: "AI 治理官方政策更新摘要", category: "web", description: "汇总 EU、NIST、ICO 的官方 AI 治理更新。",
    goal: "只使用官方来源生成政策更新摘要，记录访问状态和不可访问原因。",
    inputs: [url("EU AI Act", "https://digital-strategy.ec.europa.eu/en/policies/regulatory-framework-ai"), url("NIST AI RMF", "https://www.nist.gov/itl/ai-risk-management-framework"), url("UK ICO AI guidance", "https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/artificial-intelligence/")],
    networkHosts: ["digital-strategy.ec.europa.eu", "www.nist.gov", "ico.org.uk"], outputDir: "eval/runs/T06",
    expectedOutputs: ["policy-update-digest.md"], approvalKind: "none", github: null
  },
  {
    id: "T07", title: "按 Issue 实现并提交 PR", category: "code", description: "在 GoldMind 中完成 Issue #16，并准备可评审 PR。",
    goal: "按 Issue #16 的验收条件完成最小改动和回归测试，先在本地提交，等待用户审批后再推送并创建 PR。",
    inputs: [file("任务要求", "eval/inputs/T07-goldmind-issue.md"), { kind: "github", label: "Issue #16", value: "https://github.com/JasonBuildAI/GoldMind/issues/16" }], networkHosts: [],
    outputDir: "eval/runs/T07", expectedOutputs: ["report.md", "pr-preview.json"], approvalKind: "github.publish-pr",
    github: {
      repo: "JasonBuildAI/GoldMind",
      issue: 16,
      branch: "test/health-secret-guard",
      runtime: {
        python: {
          version: "3.11",
          workingDirectory: "backend",
          requirements: ["backend/requirements.txt", "backend/requirements-dev.txt"]
        }
      }
    }
  },
  {
    id: "T08", title: "评审 PR 并回复", category: "code", description: "对 GoldMind PR #15 做证据化评审。",
    goal: "评审 PR #15 当前 head，生成分级发现和结论；展示完整评论后等待用户批准才发布。",
    inputs: [file("任务要求", "eval/inputs/T08-goldmind-pr-review.md"), { kind: "github", label: "PR #15", value: "https://github.com/JasonBuildAI/GoldMind/pull/15" }], networkHosts: [],
    outputDir: "eval/runs/T08", expectedOutputs: ["pr-review.md"], approvalKind: "github.comment",
    github: {
      repo: "JasonBuildAI/GoldMind",
      pull: 15,
      headSha: "c007c4ed55345682689ac50bbafb090c5934c31a",
      runtime: {
        node: { workingDirectory: "app", install: "ci" },
        optional: true
      }
    }
  },
  {
    id: "T09", title: "复现 CI Bug", category: "code", description: "复现 GoldMind PR #14 的 Backend pytest 失败。",
    goal: "在隔离工作区复现 PR #14 的后端测试失败，记录环境、命令和证据，不修改代码。",
    inputs: [file("任务要求", "eval/inputs/T09-goldmind-bug-repro.md"), { kind: "github", label: "PR #14", value: "https://github.com/JasonBuildAI/GoldMind/pull/14" }], networkHosts: [],
    outputDir: "eval/runs/T09", expectedOutputs: ["bug-reproduction.md"], approvalKind: "none",
    github: {
      repo: "JasonBuildAI/GoldMind",
      pull: 14,
      headSha: "1c5efe94dfa784c3b6c0b5c221286f489d7f11f2",
      runtime: {
        python: {
          version: "3.11",
          workingDirectory: "backend",
          requirements: ["backend/requirements.txt", "backend/requirements-dev.txt"]
        },
        optional: true
      }
    }
  },
  {
    id: "T10", title: "清洗销售 CSV", category: "data", description: "清洗 20 行销售导出并列出异常。",
    goal: "保持原始文件不变，生成干净 CSV、异常清单和清洗说明。",
    inputs: [file("销售导出", "eval/inputs/T10-sales-export.csv")], networkHosts: [],
    outputDir: "eval/runs/T10", expectedOutputs: ["cleaned-sales.csv", "exceptions.csv", "change-log.md", "summary.md"], approvalKind: "none", github: null
  },
  {
    id: "T11", title: "报销票据核对", category: "data", description: "按报销政策逐笔核对 7 张票据。",
    goal: "逐笔核对票据与政策，合计应为 2640.00，列明异常和需要补充的材料。",
    inputs: [file("报销政策", "eval/inputs/T11-expense-policy.md"), file("票据", "eval/inputs/T11-receipts.md")], networkHosts: [],
    outputDir: "eval/runs/T11", expectedOutputs: ["expense-reconciliation.md"], approvalKind: "none", github: null
  },
  {
    id: "T12", title: "客服工单分类与回复草稿", category: "people", description: "分类 8 个工单并起草回复。",
    goal: "生成分类表、回复草稿、升级清单和知识库草案；脱敏且不自动发送。",
    inputs: [file("工单导出", "eval/inputs/T12-tickets.csv"), file("客服知识库", "eval/inputs/T12-policy-kb.md")], networkHosts: [],
    outputDir: "eval/runs/T12", expectedOutputs: ["triage.csv", "reply-drafts.md", "escalations.md", "kb-draft.md"], approvalKind: "none", github: null
  },
  {
    id: "T13", title: "招聘需求转 JD 与面试题", category: "people", description: "把岗位需求转成合规 JD 和面试工具包。",
    goal: "生成无歧视项的职位说明和包含 6 个能力维度的面试工具包。",
    inputs: [file("岗位需求", "eval/inputs/T13-role-intake.md")], networkHosts: [],
    outputDir: "eval/runs/T13", expectedOutputs: ["job-description.md", "interview-kit.md"], approvalKind: "none", github: null
  },
  {
    id: "T14", title: "课程转教案与测验", category: "document", description: "为七年级科学课生成 45 分钟教案和测验。",
    goal: "生成 45 分钟教案、8 题测验和答案解析，正确处理三个常见误区。",
    inputs: [file("课程资料", "eval/inputs/T14-curriculum-source.md")], networkHosts: [],
    outputDir: "eval/runs/T14", expectedOutputs: ["lesson-plan.md", "quiz.md", "answer-key.md"], approvalKind: "none", github: null
  },
  {
    id: "T15", title: "产品资料转营销简报", category: "marketing", description: "把产品资料转成三渠道活动简报和素材清单。",
    goal: "生成以可审核知识库回复为核心的营销简报和素材清单，不发布或投放。",
    inputs: [file("产品简报", "eval/inputs/T15-product-brief.md")], networkHosts: [],
    outputDir: "eval/runs/T15", expectedOutputs: ["campaign-brief.md", "asset-checklist.md"], approvalKind: "none", github: null
  }
];

export const TEMPLATES: TaskTemplate[] = TEMPLATE_DEFINITIONS.map((template) => ({
  ...template,
  acceptance: TEMPLATE_ACCEPTANCE[template.id] ?? []
}));

export function getTemplate(id: string): TaskTemplate | undefined {
  return TEMPLATES.find((template) => template.id === id);
}
