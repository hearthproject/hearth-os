# T06 输入：AI 治理官方政策更新摘要

- 日期范围：2025-01-01 至 2025-12-31
- 主题：AI 治理、风险管理、隐私与合规指导
- 目标读者：一家 50 人软件公司的合规负责人
- 输出文件夹：`eval/runs/T06/`

## 官方来源

1. 欧盟委员会 AI Act 官方政策页：`https://digital-strategy.ec.europa.eu/en/policies/regulatory-framework-ai`
2. NIST AI Risk Management Framework：`https://www.nist.gov/itl/ai-risk-management-framework`
3. 英国 ICO AI 与数据保护指导：`https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/artificial-intelligence/`

> 访问说明：2026-11-05 实测 ICO 页面返回 HTTP 403。执行时必须记录 URL、访问时间和失败原因，继续检查其他官方来源；不得用第三方镜像、搜索摘要或模型记忆替代原文。

## 输出要求

- 生成 `eval/runs/T06/policy-update-digest.md`。
- 只记录上述官方来源在日期范围内发布、修订、征求意见或即将生效的事项。
- 每条包含来源机构、发布日期、生效日期（如公开）、变更类型、原文链接和两到四句摘要。
- 明确区分新发布、修订、废止、提案/征求意见和“未发现日期范围内更新”。
- 不提供法律意见；需要解释的地方标注“需专业复核”。
- 如果来源页面无法访问，记录 URL、访问时间和失败原因。

