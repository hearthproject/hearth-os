---
title: "第一阶段 MVP 验收"
description: "15 个跨行业真实任务的结果、证据与未完成边界。"
outline: [2, 3]
---

# 第一阶段 MVP 验收

<p class="lead">第一阶段的出口不是“代码写完”，而是用 15 个跨行业真实任务证明同一条任务链路可以执行、持久化、审批、产出、失败恢复和备份。</p>

## 结论

| 项目 | 结果 |
|---|---|
| 验收日期 | 2026-11-05 |
| 任务总数 | 15 |
| 通过 | 13（T01–T06、T09–T15） |
| 产物通过但等待外部批准 | 1（T08） |
| 未通过 | 1（T07） |
| 硬门槛 | 至少 10/15 通过；已超过 |

T07 和 T08 没有用于凑数。T07 以 `recoverable` 结束并保留失败证据；T08 的 GitHub 评论审批仍是 `pending`，没有任何外部副作用。

## 逐项结果

| ID | 结果 | 已保存的证据 | 验收说明 |
|---|---|---|---|
| T01 | 通过 | `runs/T01/meeting-notes.md`、`run-manifest.json` | 会议转写转行动纪要，保留行动项、负责人、日期、待确认项和来源索引 |
| T02 | 通过 | `runs/T02/clause-checklist.md`、`run-manifest.json` | 合同条款、义务、页码、缺失附件和金额可核对，未补造缺失信息 |
| T03 | 通过 | `runs/T03/executive-summary.md`、`run-manifest.json` | 多报告合并时保留冲突和来源，不把矛盾结论强行统一 |
| T04 | 通过 | `runs/T04/pages/`、`manifest.json`、`verification.md`、`run-manifest.json` | 3 个 URL 均有状态、最终 URL、抓取时间、HTTP 状态和 SHA-256；WCAG 页面访问失败被如实保留 |
| T05 | 通过 | `runs/T05/competitor-comparison.md`、`run-manifest.json` | 竞品价格和功能有来源，未公开项标记未知而非推测 |
| T06 | 通过 | `runs/T06/policy-update-digest.md`、`run-manifest.json` | 政策更新只使用官方来源，日期和变更类型可追溯 |
| T07 | **未通过** | `runs/T07/report.md`、`pr-preview.json`、`run-manifest.json` | 交付校验拦截：`backend/tests/unit/test_health_no_secrets.py` 未提交；未推送分支、未创建 PR |
| T08 | 产物通过，**等待用户批准** | `runs/T08/pr-review.md`、`run-manifest.json` | 固定 PR #15 head `c007c4ed55345682689ac50bbafb090c5934c31a`，生成 13 KB 分级评审；评论审批状态 `pending`，`effectId` 为 `null` |
| T09 | 通过 | `runs/T09/bug-reproduction.md`、`pytest-output.txt`、`pytest-focused.txt`、退出码与路由证据 | 复现 PR #14 的 8 个后端失败，保留环境差异、临时目录问题和未验证项 |
| T10 | 通过 | `runs/T10/cleaned-sales.csv`、`exceptions.csv`、`change-log.md`、`summary.md` | 20 行销售数据清洗，重复、缺失和异常均可追溯，原文件未修改 |
| T11 | 通过 | `runs/T11/expense-reconciliation.md`、`run-manifest.json` | 7 行逐笔匹配，2640.00 合计复核，异常完整 |
| T12 | 通过 | `runs/T12/triage.csv`、`reply-drafts.md`、`escalations.md`、`kb-draft.md` | 8 个工单完成分类、脱敏、升级和回复草稿；未自动发送 |
| T13 | 通过 | `runs/T13/job-description.md`、`interview-kit.md` | JD 无歧视项；面试工具包和合规自查完整 |
| T14 | 通过 | `runs/T14/lesson-plan.md`、`quiz.md`、`answer-key.md` | 课程、测验和答案键一致，覆盖目标与难度分层 |
| T15 | 通过 | `runs/T15/campaign-brief.md`、`asset-checklist.md` | 营销主张有输入依据，三渠道素材和审批状态完整；未发布、未投放 |

## 运行环境

- 操作系统：Windows，PowerShell。
- Node.js：`v26.11.1`；npm：`11.20.0`。
- 控制面：Fastify + TypeScript；前端：React + Vite。
- 执行器：Codex 原生适配；实际配置为 `OpenDesign / deepseek-v4.1-flash`。
- 认证来源：`provider-env`，密钥由启动 Hearth 的终端环境提供，不写入浏览器。
- 健康检查：`GET /api/health` 返回 `canRun: true`、`authSource: "provider-env"`、`issues: []`。

因此不需要先执行 `codex login`。只要 `~/.codex/config.toml` 配置了 `model_provider` 和对应的 `env_key`，并且启动 Hearth 的终端存在该变量，Codex 就能作为执行器运行。

## G1–G9 验收基线

| 基线 | 证据 |
|---|---|
| G1 输入范围明确 | 任务模板和任务记录包含目标、输入路径/URL、输出目录；运行清单记录输入来源和 SHA-256 |
| G2 状态可见 | 状态机覆盖 `queued`、`running`、`waiting_input`、`waiting_approval`、`completed`、`failed`、`recoverable`、`cancelled` |
| G3 结果持久 | 任务、运行、审批、效果、事件和产物索引写入 `.hearth/hearth.sqlite`，服务重启后可查询 |
| G4 产物可追溯 | 每个 `run-manifest.json` 记录任务/运行 ID、输入摘要、执行器、生成时间和产物 SHA-256 |
| G5 外部动作受控 | GitHub 推送、创建 PR 和评论先生成审批预览；T08 审批尚未执行，无效果记录 |
| G6 不伪造 | T04 访问挑战、T08 缺失 CI 日志、T09 宿主临时目录问题均标记未知或失败 |
| G7 失败可恢复 | T07 以 `recoverable` 结束，显示具体未提交文件并保留工作区 |
| G8 权限最小化 | 服务只接受本机回环地址，阻止跨站写请求；外部写入需要绑定参数指纹的一次性审批 |
| G9 用户可核对 | 待办、任务详情、审批预览、产物预览和应用内时间线可直接查看 |

## 自动校验

```powershell
npm.cmd test
npm.cmd run typecheck
npm.cmd run build -w @hearth/web
```

验收时 `npm test` 通过 51 项测试；TypeScript 类型检查通过；Web 生产构建通过。2026-11-06 之后测试扩展到 40 个测试文件、199 个测试，当前基线以[验收与证据](/delivery/acceptance)为准。

## 这次验收没有证明什么

- 没有证明邮件、日历、真实发送或桌面高风险动作可用。
- 没有证明手机入口、主动服务打扰控制或多设备切换可用。
- 没有证明数周连续运行、资源漂移或版本升级回退可靠。
- 没有把 T07 的失败或 T08 的等待批准写成成功。

逐项原始证据见仓库 `eval/phase-1-acceptance.md` 与 `eval/runs/`。
