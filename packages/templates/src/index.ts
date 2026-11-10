import type { TaskInput } from "@hearth/core";

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

const text = (label: string, value: string): TaskInput => ({ kind: "text", label, value });
const url = (label: string, value: string): TaskInput => ({ kind: "url", label, value });

const TEMPLATE_DEFINITIONS: Omit<TaskTemplate, "acceptance">[] = [
  {
    id: "T01", title: "会议转写转行动纪要", category: "document", description: "把原始会议记录整理成结论、行动项和待确认问题。",
    goal: "根据会议原始记录生成可直接发送的行动纪要，保留来源索引，不编造未讨论的信息。",
    inputs: [text("会议原始记录", "2026-11-11 产品周会\n- 决定：本周完成评测入口拆分。\n- 行动：小王补充验收记录，周五前提交。\n- 待确认：是否保留旧接口。")], networkHosts: [],
    outputDir: ".hearth/artifacts/T01", expectedOutputs: ["meeting-notes.md"], approvalKind: "none", github: null
  },
  {
    id: "T02", title: "合同条款与义务提取", category: "document", description: "提取 SaaS 合同中的关键义务、期限、金额和缺失附件。",
    goal: "生成合同条款清单，逐项标注页码、风险、责任方和需要法务确认的问题。",
    inputs: [text("SaaS 合同", "服务期限：2026-01-01 至 2026-12-31。\n月度费用：人民币 8,000 元，按自然月结算。\n终止：任一方可提前 30 天书面通知终止。\n附件：数据处理协议尚未提供。")], networkHosts: [],
    outputDir: ".hearth/artifacts/T02", expectedOutputs: ["clause-checklist.md"], approvalKind: "none", github: null
  },
  {
    id: "T03", title: "多报告合并为执行摘要", category: "document", description: "合并三份报告，保留冲突与来源。",
    goal: "生成面向管理层的执行摘要，明确共识、冲突、关键数字和决策建议。",
    inputs: [
      text("报告 A", "季度收入 120 万元，同比增长 18%；重点客户续约率 91%。"),
      text("报告 B", "季度收入 117 万元，同比增长 12%；重点客户续约率 88%。"),
      text("报告 C", "市场团队认为续约率应使用 90% 作为统一口径，并建议下季度复盘差异。")
    ], networkHosts: [],
    outputDir: ".hearth/artifacts/T03", expectedOutputs: ["executive-summary.md"], approvalKind: "none", github: null
  },
  {
    id: "T04", title: "指定网页归档为 Markdown", category: "web", description: "抓取三篇公开网页并保留来源清单。",
    goal: "把指定网页正文归档为 Markdown，保留标题、表格、代码块、链接和抓取证据。",
    inputs: [url("MDN HTTP 指南", "https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Overview"), url("GitHub Issues 文档", "https://docs.github.com/en/issues/tracking-your-work-with-issues/learning-about-issues/about-issues"), url("WCAG 2.2 快速参考", "https://www.w3.org/WAI/WCAG22/quickref/")],
    networkHosts: ["developer.mozilla.org", "docs.github.com", "www.w3.org"], outputDir: ".hearth/artifacts/T04",
    expectedOutputs: ["pages/", "manifest.json"], approvalKind: "none", github: null
  },
  {
    id: "T05", title: "竞品公开定价与功能对比", category: "web", description: "整理 ClickUp、Linear、Asana 的公开套餐信息。",
    goal: "生成有来源的竞品定价与功能对比表；未公开内容标记为未公开，不推测价格。",
    inputs: [url("ClickUp Pricing", "https://clickup.com/pricing"), url("Linear Pricing", "https://linear.app/pricing"), url("Asana Pricing", "https://asana.com/pricing")],
    networkHosts: ["clickup.com", "linear.app", "asana.com"], outputDir: ".hearth/artifacts/T05",
    expectedOutputs: ["competitor-comparison.md"], approvalKind: "none", github: null
  },
  {
    id: "T06", title: "AI 治理官方政策更新摘要", category: "web", description: "汇总 EU、NIST、ICO 的官方 AI 治理更新。",
    goal: "只使用官方来源生成政策更新摘要，记录访问状态和不可访问原因。",
    inputs: [url("EU AI Act", "https://digital-strategy.ec.europa.eu/en/policies/regulatory-framework-ai"), url("NIST AI RMF", "https://www.nist.gov/itl/ai-risk-management-framework"), url("UK ICO AI guidance", "https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/artificial-intelligence/")],
    networkHosts: ["digital-strategy.ec.europa.eu", "www.nist.gov", "ico.org.uk"], outputDir: ".hearth/artifacts/T06",
    expectedOutputs: ["policy-update-digest.md"], approvalKind: "none", github: null
  },
  {
    id: "T07", title: "按 Issue 实现并提交 PR", category: "code", description: "在 GoldMind 中完成 Issue #16，并准备可评审 PR。",
    goal: "按 Issue #16 的验收条件完成最小改动和回归测试，先在本地提交，等待用户审批后再推送并创建 PR。",
    inputs: [text("任务要求", "按 Issue #16 完成最小实现和回归测试；先本地提交，等待批准后再推送并创建 PR。"), { kind: "github", label: "Issue #16", value: "https://github.com/JasonBuildAI/GoldMind/issues/16" }], networkHosts: [],
    outputDir: ".hearth/artifacts/T07", expectedOutputs: ["report.md", "pr-preview.json"], approvalKind: "github.publish-pr",
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
    inputs: [text("任务要求", "评审 PR #15 当前 head，给出按严重程度分级的证据化发现；评论需等待批准后发布。"), { kind: "github", label: "PR #15", value: "https://github.com/JasonBuildAI/GoldMind/pull/15" }], networkHosts: [],
    outputDir: ".hearth/artifacts/T08", expectedOutputs: ["pr-review.md"], approvalKind: "github.comment",
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
    inputs: [text("任务要求", "复现 PR #14 的后端 pytest 失败，记录环境、命令、原始输出和恢复方式，不修改代码。"), { kind: "github", label: "PR #14", value: "https://github.com/JasonBuildAI/GoldMind/pull/14" }], networkHosts: [],
    outputDir: ".hearth/artifacts/T09", expectedOutputs: ["bug-reproduction.md"], approvalKind: "none",
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
    inputs: [text("销售导出", "order_id,customer,amount,date\n1001,星河科技,1200,2026-11-01\n1002,远山设计,980,2026-11-02\n1003,星河科技,,2026-11-03")], networkHosts: [],
    outputDir: ".hearth/artifacts/T10", expectedOutputs: ["cleaned-sales.csv", "exceptions.csv", "change-log.md", "summary.md"], approvalKind: "none", github: null
  },
  {
    id: "T11", title: "报销票据核对", category: "data", description: "按报销政策逐笔核对 7 张票据。",
    goal: "逐笔核对票据与政策，合计应为 2640.00，列明异常和需要补充的材料。",
    inputs: [
      text("报销政策", "交通费需提供行程单；单笔超过 500 元需部门负责人审批；缺少发票的票据不得报销。"),
      text("票据", "高铁票 620 元；出租车 88 元；住宿 1932 元；餐饮 120 元且无发票。")
    ], networkHosts: [],
    outputDir: ".hearth/artifacts/T11", expectedOutputs: ["expense-reconciliation.md"], approvalKind: "none", github: null
  },
  {
    id: "T12", title: "客服工单分类与回复草稿", category: "people", description: "分类 8 个工单并起草回复。",
    goal: "生成分类表、回复草稿、升级清单和知识库草案；脱敏且不自动发送。",
    inputs: [
      text("工单导出", "id,message\n1,无法登录\n2,发票抬头写错\n3,需要退款\n4,功能建议"),
      text("客服知识库", "登录问题优先检查验证码；退款需订单号；功能建议转产品团队；所有回复必须脱敏。")
    ], networkHosts: [],
    outputDir: ".hearth/artifacts/T12", expectedOutputs: ["triage.csv", "reply-drafts.md", "escalations.md", "kb-draft.md"], approvalKind: "none", github: null
  },
  {
    id: "T13", title: "招聘需求转 JD 与面试题", category: "people", description: "把岗位需求转成合规 JD 和面试工具包。",
    goal: "生成无歧视项的职位说明和包含 6 个能力维度的面试工具包。",
    inputs: [text("岗位需求", "招聘一名后端工程师，负责 API 与数据服务；要求 3 年以上经验，熟悉 TypeScript 和 PostgreSQL。")], networkHosts: [],
    outputDir: ".hearth/artifacts/T13", expectedOutputs: ["job-description.md", "interview-kit.md"], approvalKind: "none", github: null
  },
  {
    id: "T14", title: "课程转教案与测验", category: "document", description: "为七年级科学课生成 45 分钟教案和测验。",
    goal: "生成 45 分钟教案、8 题测验和答案解析，正确处理三个常见误区。",
    inputs: [text("课程资料", "七年级科学：水的三态变化。学生需区分熔化、凝固、汽化和液化，并能用生活例子解释。")], networkHosts: [],
    outputDir: ".hearth/artifacts/T14", expectedOutputs: ["lesson-plan.md", "quiz.md", "answer-key.md"], approvalKind: "none", github: null
  },
  {
    id: "T15", title: "产品资料转营销简报", category: "marketing", description: "把产品资料转成三渠道活动简报和素材清单。",
    goal: "生成以可审核知识库回复为核心的营销简报和素材清单，不发布或投放。",
    inputs: [text("产品简报", "产品：本地优先的个人 Agent。卖点：数据留在本机、任务可恢复、外部动作需审批。面向知识工作者。")], networkHosts: [],
    outputDir: ".hearth/artifacts/T15", expectedOutputs: ["campaign-brief.md", "asset-checklist.md"], approvalKind: "none", github: null
  }
];

export const TEMPLATES: TaskTemplate[] = TEMPLATE_DEFINITIONS.map((template) => ({
  ...template,
  acceptance: []
}));

export function getTemplate(id: string): TaskTemplate | undefined {
  return TEMPLATES.find((template) => template.id === id);
}
