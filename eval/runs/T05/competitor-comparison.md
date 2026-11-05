# ClickUp、Linear、Asana 公开定价与功能对比

- 调研日期：2026-11-05（Asia/Shanghai）
- 数据边界：仅使用任务提供的三份只读网页快照；未联网、未使用网页搜索、未访问快照外链接、未混入第三方信息。
- 价格口径：按页面原文抄录，不做币种换算、税额推导、月付/年付互换或总拥有成本估算。
- 标注口径：“未公开”表示快照没有给出可核对的公开值；“待确认”表示需要厂商销售/产品确认，本文件不作推测。

## 1. 结论摘要

- **套餐结构**：ClickUp 公开 Free、Core、Business、Enterprise、Max；Linear 公开 Free、Basic、Business、Enterprise；Asana 公开 Personal、Starter、Advanced、Enterprise，并说明可提供 Enterprise+。（C1，https://clickup.com/pricing，2026-11-05；L1，https://linear.app/pricing，2026-11-05；A1，https://asana.com/pricing，2026-11-05）
- **价格口径最清晰的厂商**：Linear 在 Basic/Business 价格旁明确写“Billed yearly”，Enterprise 写“Annual billing only”；Asana 同时给出年付与月付单价；ClickUp 仅 Max 价格卡明确写“billed yearly”，Core/Business 价格卡未写计费周期。（C1，https://clickup.com/pricing，2026-11-05；L1，https://linear.app/pricing，2026-11-05；A1，https://asana.com/pricing，2026-11-05）
- **可核对的入门付费刊例数字**：ClickUp Core 显示 `$9 user / mo`（周期未公开）；Linear Basic 为 `$10 per user/month`、按年计费；Asana Starter 为年付 `$10.99`、月付 `$13.49`（均为每用户每月）。在计费周期明确的价格中，Linear Basic 的年付单价最低；ClickUp Core 因周期未明示，不能直接据此做同口径排名。（C1，https://clickup.com/pricing，2026-11-05；L1，https://linear.app/pricing，2026-11-05；A1，https://asana.com/pricing，2026-11-05）
- **企业安全能力**：三者都把 SAML/SCIM 一类能力放在 Enterprise 档；Asana 另提供 Enterprise+ 的 SIEM、数据驻留、审计日志、专用工作区说明，但未公开 Enterprise/Enterprise+ 价格。（C1，https://clickup.com/pricing，2026-11-05；L1，https://linear.app/pricing，2026-11-05；A1，https://asana.com/pricing，2026-11-05）
- **AI 计入方式差异明显**：ClickUp 各档均带 Brain² 月度额度，Max 另有较多“Unlimited”AI 项目；Linear 免费层即列出 agent/Linear Agent，但 Cloud coding agent 与 Loops 标注需 AI credits；Asana 在付费档列 AI Teammates、Asana Dash、AI Studio 额度，并另售 AI 用量。（C1，https://clickup.com/pricing，2026-11-05；L1，https://linear.app/pricing，2026-11-05；A1，https://asana.com/pricing，2026-11-05）

## 2. 来源索引与快照状态

### 2.1 官方来源

| ID | 厂商 | 官方 URL | 抓取时间（UTC） | 抓取时间（北京时间） | HTTP / `ok` | 页面标题（`source.json`） |
| --- | --- | --- | --- | --- | --- | --- |
| C1 | ClickUp | https://clickup.com/pricing | 2026-11-05T10:04:35.340Z | 2026-11-05 18:04:35 | 200 / `true` | ClickUp Pricing and Plans |
| L1 | Linear | https://linear.app/pricing | 2026-11-05T10:04:36.262Z | 2026-11-05 18:04:36 | 200 / `true` | Pricing – Linear |
| A1 | Asana | https://asana.com/pricing | 2026-11-05T10:04:36.845Z | 2026-11-05 18:04:36 | 200 / `true` | Asana Pricing \| Personal, Starter, Advanced, & Enterprise plans • Asana |

三份 `source.json` 的 `requestedUrl` 与 `finalUrl` 均分别等于上表官方 URL，`contentType` 均为 `text/html; charset=utf-8`。

**抓取日期统一记为 2026-11-05。** 下表及正文中的每个价格/功能结论均以 C1、L1、A1 为来源，并在结论旁标注来源 ID、官方 URL 与抓取日期。

### 2.2 快照完整性与可核查信息

| ID | 只读快照 | `page.md` 字节数 | `page.md` SHA-256（本次计算） | `source.json` 记录的原始 HTML 字节数 | `source.json` 记录的原始 HTML SHA-256 | 状态 |
| --- | --- | ---: | --- | ---: | --- | --- |
| C1 | `inputs/01-ClickUp-Pricing/page.md` | 22,789 | `b3335d1f221d9aa833cc6a41bf18d508e1e2d89f6fbca1207611569bc76f572b` | 557,040 | `8310f50e030b0cf4b2bd3fcfc1a638afd4e76269ab6b05b53f11e14206dec867` | `ok: true` |
| L1 | `inputs/02-Linear-Pricing/page.md` | 5,596 | `161e03a92e0e380f82f4fdb407d99621bba692ebd486e0d90a52414f649ff2f7` | 816,261 | `8b2199c9983b5de46311688228889e778a34cccf41d7e908d78ee5edfd30ec93` | `ok: true` |
| A1 | `inputs/03-Asana-Pricing/page.md` | 46,939 | `ececb12f70634f34295ec8800e57ab059bcc94804cb731dd4a1d8867742309e1` | 1,244,412 | `ba9717d9a8f036ae574845acaa9a01242d4d551402120673d321f93e209da893` | `ok: true` |

说明：`source.json` 中的 SHA-256 是该次抓取的**原始 HTML** 摘要，不是 `page.md` 的摘要；本次另行计算了 `page.md` 摘要，便于复核只读快照未发生变化。

### 2.3 失败状态

- 三份 `source.json` 均为 `ok: true`、HTTP 200，故没有需要保留的失败正文或失败原因。
- 本文所有价格与功能均来自上述三份成功快照，没有用失败页或二手资料补写。

## 3. 公开套餐、价格与计费周期

### 3.1 主套餐价格表

| 厂商 | 套餐 | 页面公开价格（原文口径） | 计费周期 | 币种 / 税费 | 来源与抓取日期 |
| --- | --- | --- | --- | --- | --- |
| ClickUp | Free | `$0 user / mo` | 不适用（免费） | 币种：未公开（仅显示 `$`）；税费：未公开 | C1，https://clickup.com/pricing，2026-11-05 |
| ClickUp | Core | `$9 user / mo` | **未公开**（价格卡未标注；页面有 Monthly/Yearly 切换，但快照不呈现选中态） | 币种：未公开（仅显示 `$`）；税费：未公开 | C1，https://clickup.com/pricing，2026-11-05 |
| ClickUp | Business | `$17 user / mo` | **未公开**（价格卡未标注；页面有 Monthly/Yearly 切换，但快照不呈现选中态） | 币种：未公开（仅显示 `$`）；税费：未公开 | C1，https://clickup.com/pricing，2026-11-05 |
| ClickUp | Enterprise | `Custom` | **未公开**（需联系销售） | 币种：未公开；税费：未公开 | C1，https://clickup.com/pricing，2026-11-05 |
| ClickUp | Max | `$100 user / mo · billed yearly`；同卡另示 `Regular price $120` | 年付（`billed yearly`） | 币种：未公开（仅显示 `$`）；税费：未公开 | C1，https://clickup.com/pricing，2026-11-05 |
| Linear | Free | `$0`；`Free for everyone` | 不适用（免费） | 币种：未公开（仅显示 `$`）；税费：未公开 | L1，https://linear.app/pricing，2026-11-05 |
| Linear | Basic | `$10 per user/month` | 年付（`Billed yearly`）；月付价格**未公开** | 币种：未公开（仅显示 `$`）；税费：未公开 | L1，https://linear.app/pricing，2026-11-05 |
| Linear | Business | `$16 per user/month` | 年付（`Billed yearly`）；月付价格**未公开** | 币种：未公开（仅显示 `$`）；税费：未公开 | L1，https://linear.app/pricing，2026-11-05 |
| Linear | Enterprise | `Custom` | 仅年付（`Annual billing only`） | 币种：未公开；税费：未公开 | L1，https://linear.app/pricing，2026-11-05 |
| Asana | Personal | `$0`；`Free forever` | 不适用（免费） | 币种：未公开（仅显示 `$`）；税费：页面说明可能按账单地址收取州/地方销售税，并可能适用 VAT/GST | A1，https://asana.com/pricing，2026-11-05 |
| Asana | Starter | 年付 `$10.99`；月付 `$13.49`（均为 per user, per month） | 年付与月付两种公开口径 | 币种：未公开（仅显示 `$`）；税费：可能加收，见 A1 税费说明 | A1，https://asana.com/pricing，2026-11-05 |
| Asana | Advanced | 年付 `$24.99`；月付 `$30.49`（均为 per user, per month） | 年付与月付两种公开口径 | 币种：未公开（仅显示 `$`）；税费：可能加收，见 A1 税费说明 | A1，https://asana.com/pricing，2026-11-05 |
| Asana | Enterprise | `Contact sales for custom pricing` / `Contact sales for pricing` | **未公开** | 币种：未公开；税费：可能加收，见 A1 税费说明 | A1，https://asana.com/pricing，2026-11-05 |
| Asana | Enterprise+ | **未公开**（页面仅说明可提供，并给出安全/合规扩展描述，无独立价格） | **未公开** | 币种：未公开；税费：可能加收，见 A1 税费说明 | A1，https://asana.com/pricing，2026-11-05 |

### 3.2 可选 AI 用量价格（单位不同，不能直接横比）

| 厂商 | 项目 | 页面公开价格（原文口径） | 计费节奏 | 来源与抓取日期 |
| --- | --- | --- | --- | --- |
| ClickUp | AI Super Credits | `$10 per 10K credits` | **未公开** | C1，https://clickup.com/pricing，2026-11-05 |
| Asana | 预付 AI requests | `$0.50 per AI request` | `billed upfront` | A1，https://asana.com/pricing，2026-11-05 |
| Asana | 按需 AI requests | `$0.60 per AI request` | `billed monthly` | A1，https://asana.com/pricing，2026-11-05 |
| Asana | 按需页内另列价格 | `$5.99 per user, per month billed annually` | 与同段“billed monthly”表述冲突，**计费口径未公开/待确认** | A1，https://asana.com/pricing，2026-11-05 |

说明：ClickUp 按“10K credits”计价，Asana 按“request”计价，二者不是同一计量单位；本文不换算，也不据此判断哪家 AI 更便宜。

## 4. 各套餐关键功能

### 4.1 ClickUp

| 套餐 | 页面列出的关键功能（不改写为推断能力） | 来源与抓取日期 |
| --- | --- | --- |
| Free | Unlimited Tasks & Subtasks；Unlimited Free Members；Collaborative Docs；Kanban Boards；Calendar View；Sprint Management；Time Tracking；SyncUps Video Calls；Two-Factor Authentication；24/7 Support；60 MB Storage；1 Form。 | C1，https://clickup.com/pricing，2026-11-05 |
| Core | “Everything in Free Forever”另加：Custom Fields & Task Types；Unlimited Storage and Spaces；Unlimited Forms；Unlimited Gantt Charts；Unlimited ClickUp Chat；1K Automations / mo；Goals；Guest Permissions；Email in ClickUp；Google Drive、Dropbox & Box；Live Chat Support。 | C1，https://clickup.com/pricing，2026-11-05 |
| Business | “Everything in Core”另加：Advanced Dashboards；Webhooks & Automation Integrations；10K Automations / mo；Resource Management；Google SSO + SMS 2FA；Private Views；Private Docs；Timesheets；Time in Status Reports。 | C1，https://clickup.com/pricing，2026-11-05 |
| Enterprise | “Everything in Business”另加：White Labeling；1M Automations / mo；Unlimited Custom Roles；Enterprise Permissions & Governance；Advanced SSO、SCIM、SAML；Audit Logs & Session Management；MSA、Data Residency；HIPAA support with BAA；Enterprise API & Integrations；Connected Search（Google Drive、OneDrive、Gmail、Microsoft Teams、Slack）。 | C1，https://clickup.com/pricing，2026-11-05 |
| Max | “Everything in Enterprise”另加：ClickUp Brain² MAX（Maximum Premium Model Usage、Custom Skills、Context Engine & Auto-Memory、Talk-to-Text、MCP Connections、Artifact Creation: Prototypes）；Unlimited AI Fields；Unlimited Notetaker；Unlimited AI Image Generation；Unlimited Autopilot Agents；Unlimited AI Dashboard Cards；10K credits / user / mo · pooled；并重申 Enterprise 的 White Labeling、1M Automations / mo、Audit Logs & Session Management、Enterprise API、Unlimited Custom Roles、Advanced SSO/SCIM/SAML、HIPAA support with BAA。 | C1，https://clickup.com/pricing，2026-11-05 |

补充：ClickUp 的 Free 套餐在功能文案中写作 “Free Forever”；对比表列名为 “Free”。页面另有 AI credits 配额表：Free 500 / workspace；Core 1,000 / user / mo · pooled；Business 1,500 / user / mo · pooled；Enterprise 3,000 / user / mo · pooled；Max 10,000 / user / mo · pooled（C1，https://clickup.com/pricing，2026-11-05）。

### 4.2 Linear

| 套餐 | 页面列出的关键功能（不改写为推断能力） | 来源与抓取日期 |
| --- | --- | --- |
| Free | Unlimited members；2 teams；250 issues；Agent platform；Linear Agent；Loops。功能表另列：10 MB file upload、Issues/Projects/Cycles/Initiatives、Customer requests、API and webhook access、Import and export、Triage、Pulse、Issue sync、Diffs、Agent platform、MCP access、Linear Agent、Cloud coding agent、Loops、Google SSO、Admin roles 等。 | L1，https://linear.app/pricing，2026-11-05 |
| Basic | “All Free features +”：5 teams；Unlimited issues；Unlimited file uploads；Admin roles。功能表另列 Guided reviews 为 Included。 | L1，https://linear.app/pricing，2026-11-05 |
| Business | “All Basic features +”：Unlimited teams；Private teams and guests；Triage Intelligence；Code Intelligence；Linear Insights；Linear Asks；Zendesk and Intercom integrations。功能表另列 Issue SLAs、Triage responsibility、Triage rules、Releases（15 pipelines）、Support integrations、Sub-teams（1 level）、Slack/email intake 等。 | L1，https://linear.app/pricing，2026-11-05 |
| Enterprise | “All Business features +”：Invoice/PO billing；SAML and SCIM；Granular admin controls；Enterprise-grade security；Advanced org modeling；Migration & onboarding support；Priority support；Account management。功能表另列 Unlimited releases、Sub-initiatives、Dashboards、Web forms、Multiple Slack workspaces、Private Slack channels、Per-channel configurations、IP restrictions、Domain claiming、Audit log、HIPAA compliance、Uptime SLA、Custom terms 等。 | L1，https://linear.app/pricing，2026-11-05 |

补充：页面脚注写明 Cloud coding agent 与 Loops “** Requires AI credits”；该页没有给出 AI credits 的价格或具体额度（L1，https://linear.app/pricing，2026-11-05）。

### 4.3 Asana

| 套餐 | 页面列出的关键功能（不改写为推断能力） | 来源与抓取日期 |
| --- | --- | --- |
| Personal | 2 users；Unlimited tasks and projects；List、Board、Calendar views；Unlimited storage，单文件上限 100 MB；Status updates；Time tracking with integrations；100+ free integrations。页面未列出该档 AI 功能。 | A1，https://asana.com/pricing，2026-11-05 |
| Starter | No user seat limits；Timeline and Gantt views；Reporting dashboards；Unlimited automations；Forms；Custom templates；Custom fields；Unlimited free guests。AI：AI Teammates and Asana Dash，含 5 requests / user / month、每账户最多 50 requests；AI Studio，含 50K credits / billing account / month。 | A1，https://asana.com/pricing，2026-11-05 |
| Advanced | “Everything in Starter”另加：Unlimited portfolios；Goals；Resource management（within one portfolio）；Approvals and proofing；Tables；Forms branching & customization；Time tracking；Scaled security；Salesforce、Tableau、Power BI 连接。AI：AI Meetings；AI Teammates and Asana Dash（5 requests / user / month、每账户最多 50）；AI Studio 75K credits / billing account / month。 | A1，https://asana.com/pricing，2026-11-05 |
| Enterprise | “Everything in Advanced”另加：SAML authentication；User provisioning（SCIM）；Universal resource management；Capacity planning；Tables；Service accounts；View-only licenses；Guest invitation permissions；Project admin controls。AI：AI Meetings；AI Teammates and Asana Dash（5 requests / user / month、每账户最多 250）；AI Studio 200K credits / billing account / month。 | A1，https://asana.com/pricing，2026-11-05 |
| Enterprise+ | 页面将其描述为面向更高安全/合规需求的扩展：SIEM integration、data residency、audit logs、dedicated workspaces。本快照未见独立价格卡；价格未公开。 | A1，https://asana.com/pricing，2026-11-05 |

补充：Asana 的 AI 用量页还公开 `$0.50 per AI request`（预付、billed upfront）与 `$0.60 per AI request`（按需、billed monthly）；同段另出现 `$5.99 per user, per month billed annually`，但同一段又写 “billed monthly”，口径冲突，详见第 7 节（A1，https://asana.com/pricing，2026-11-05）。

## 5. 跨厂商关键功能对比矩阵

> 下表把“套餐档位名称”只当作厂商自己的名称，不假设 ClickUp Core、Linear Basic、Asana Starter 的功能完全等价。每个单元格末尾的来源 ID 均指向第 2.1 节的官方 URL，抓取日期均为 2026-11-05。

| 对比维度 | ClickUp | Linear | Asana | 来源与抓取日期 |
| --- | --- | --- | --- | --- |
| 免费层容量 | 任务/子任务不限；Free Members 不限；5 Spaces；60 MB 文件存储；1 Form。 | 成员不限；2 teams；250 issues；单文件上传 10 MB。 | 2 users；任务与项目不限；存储不限但单文件 100 MB。 | C1 https://clickup.com/pricing；L1 https://linear.app/pricing；A1 https://asana.com/pricing；均为 2026-11-05 |
| 入门付费档 | Core：自定义字段/任务类型、无限存储/Spaces/Forms/Gantt/Chat、1K automations/mo、Goals、Guest Permissions。 | Basic：5 teams、无限 issues、无限文件上传、Admin roles。 | Starter：无席位上限、Timeline/Gantt、Reporting dashboards、无限 automations、Forms、自定义模板/字段、无限免费 guests。 | C1 https://clickup.com/pricing；L1 https://linear.app/pricing；A1 https://asana.com/pricing；均为 2026-11-05 |
| 中间付费档 | Business：Advanced Dashboards、Webhooks & Automation Integrations、10K automations/mo、Resource Management、Google SSO + SMS 2FA、Private Views/Docs、Timesheets、Time in Status。 | Business：无限 teams、私有 teams/guests、Triage Intelligence、Code Intelligence、Insights、Asks、Zendesk/Intercom。 | Advanced：无限 portfolios、Goals、单 portfolio 内 Resource management、Approvals/proofing、Tables、分支表单、Time tracking、Scaled security、Salesforce/Tableau/Power BI。 | C1 https://clickup.com/pricing；L1 https://linear.app/pricing；A1 https://asana.com/pricing；均为 2026-11-05 |
| 企业档 | Enterprise：White Labeling、1M automations/mo、无限自定义角色、Enterprise 权限治理、Advanced SSO/SCIM/SAML、Audit Logs & Session Management、MSA/Data Residency、HIPAA BAA、Enterprise API。 | Enterprise：Invoice/PO、SAML/SCIM、Granular admin controls、Enterprise-grade security、Advanced org modeling、迁移/上线支持、Priority support、Account management。 | Enterprise：SAML、SCIM、Universal resource management、Capacity planning、Service accounts、View-only licenses、Guest invitation permissions、Project admin controls；Enterprise+ 另述 SIEM、数据驻留、审计日志、专用工作区。 | C1 https://clickup.com/pricing；L1 https://linear.app/pricing；A1 https://asana.com/pricing；均为 2026-11-05 |
| AI 额度 | 所有档位有月度 Brain² credits：Free 500/workspace；Core 1,000/user/mo；Business 1,500/user/mo；Enterprise 3,000/user/mo；Max 10,000/user/mo。Max 另列无限 AI Fields、Notetaker、Image Generation、Autopilot Agents、Dashboard Cards。 | Free 即列 Agent platform、Linear Agent、Loops；Cloud coding agent 与 Loops 标注需 AI credits；Business+ 有 Triage Intelligence、Code Intelligence。页面未给 AI credits 单价。 | Personal 未列 AI；Starter/Advanced/Enterprise 列 AI Teammates、Asana Dash、AI Studio。AI Studio credits：50K/75K/200K per billing account/mo；AI Teammates 请求：5/user/mo，账户上限 50/50/250。 | C1 https://clickup.com/pricing；L1 https://linear.app/pricing；A1 https://asana.com/pricing；均为 2026-11-05 |
| 视图与规划对象 | List、Table、Calendar 全档 Included；Gantt 免费为 Trial、Core 起 Included；Timeline/Workload 从 Business 起 Included；Sprints 全档 Included；Whiteboards 免费 3、Core 10、Business 起 Included。 | 页面列 Issues、projects、cycles、initiatives 全档 Included；定价快照没有以 List/Board/Calendar 命名视图。 | List/Board/Calendar 从 Personal 起；Timeline/Gantt 从 Starter 起；Portfolios 从 Advanced 起。 | C1 https://clickup.com/pricing；L1 https://linear.app/pricing；A1 https://asana.com/pricing；均为 2026-11-05 |
| 自动化/规则 | Automation Actions：Free 100、Core 1,000、Business 10,000、Enterprise 1M、Max 1M（均为 workspace/month）；Active Rules：Free 5，其余 Unlimited。 | 页面未给统一的自动化次数/额度；Business 起列 Triage rules。 | Starter 起列 Unlimited automations。 | C1 https://clickup.com/pricing；L1 https://linear.app/pricing；A1 https://asana.com/pricing；均为 2026-11-05 |
| 身份与安全 | Google SSO 从 Business 起；SMS 2FA 从 Business 起；Microsoft/Okta/SAML SSO、SCIM、Session Management、Audit Trails 从 Enterprise 起。 | Google SSO 全档；SAML 与 SCIM 从 Enterprise 起；Admin roles 全档。 | SAML 与 SCIM 从 Enterprise 起；Advanced 档只列 Scaled security，未在该档列 SAML/SCIM。 | C1 https://clickup.com/pricing；L1 https://linear.app/pricing；A1 https://asana.com/pricing；均为 2026-11-05 |
| 外部协作 | Free 可有无限制成员/guests；FAQ 说明 Free 的 guests 有完整创建/编辑权限且不可修改；付费档为有限外部 guest seats + 无限只读 guests。 | Private teams and guests 从 Business 起。 | Personal 为 2 users；Starter 起列 Unlimited free guests。 | C1 https://clickup.com/pricing；L1 https://linear.app/pricing；A1 https://asana.com/pricing；均为 2026-11-05 |
| 报表/洞察 | Dashboards：Free/Core 为 Trial，Business 起 Included；Advanced Reporting、Time in Status 从 Business 起。 | Linear Insights 从 Business 起；Dashboards 从 Enterprise 起。 | Reporting dashboards 从 Starter 起；Portfolios/Goals 从 Advanced 起。 | C1 https://clickup.com/pricing；L1 https://linear.app/pricing；A1 https://asana.com/pricing；均为 2026-11-05 |

## 6. 差异说明

### 6.1 价格与计费结构

- **档位数量与顶部产品不同**：ClickUp 有独立的 Max 档，公开价为 `$100 user / mo · billed yearly`，并另示常规价 `$120`；Linear 与 Asana 的公开价目卡最高档均为 Enterprise（Custom/Contact sales），Asana 另说明 Enterprise+ 可提供但无公开价格。（C1，https://clickup.com/pricing，2026-11-05；L1，https://linear.app/pricing，2026-11-05；A1，https://asana.com/pricing，2026-11-05）
- **计费周期透明度不同**：Linear 的 Basic/Business 明示 `Billed yearly`，Enterprise 明示 `Annual billing only`；Asana 明示 Starter/Advanced 的年付与月付单价；ClickUp 只有 Max 明示 `billed yearly`，Core/Business 价格卡未明示周期，因此不能把 `$9`、`$17` 直接当作年付或月付价。（L1，https://linear.app/pricing，2026-11-05；A1，https://asana.com/pricing，2026-11-05；C1，https://clickup.com/pricing，2026-11-05）
- **入门/中间档页面数字**：ClickUp Core `$9`、Business `$17`（周期未公开）；Linear Basic `$10`、Business `$16`（均按年计费）；Asana Starter 年付 `$10.99` / 月付 `$13.49`、Advanced 年付 `$24.99` / 月付 `$30.49`。这些数字只能用于页面刊例价对照，不能在没有席位、合同期、税费和 AI 用量假设时直接计算 TCO。（C1，https://clickup.com/pricing，2026-11-05；L1，https://linear.app/pricing，2026-11-05；A1，https://asana.com/pricing，2026-11-05）
- **年付优惠表述**：ClickUp 写 `Save up to 33% with yearly`；Asana 写 `Yearly Save up to 18%`。两条都是厂商页面宣称，快照未给全量档位的月付对照或适用条件；ClickUp 的 Max 卡又单独显示 `$100` 与常规价 `$120`，页面未说明该卡与“最高 33%”的关系。（C1，https://clickup.com/pricing，2026-11-05；A1，https://asana.com/pricing，2026-11-05）

### 6.2 免费层与付费门槛

- **ClickUp 免费层强在任务/成员，弱在存储**：任务与子任务不限、Free Members 不限，但文件存储仅 60 MB；Core 才给无限存储与 Spaces。（C1，https://clickup.com/pricing，2026-11-05）
- **Linear 免费层强在成员数，弱在 issue 与 team 配额**：成员不限，但只有 2 teams、250 issues、单文件上传 10 MB；Basic 才解除 issue 与文件上传限制并增至 5 teams。（L1，https://linear.app/pricing，2026-11-05）
- **Asana 免费层偏向个人/小规模**：Personal 限 2 users，但任务、项目与存储不限，单文件上限 100 MB；这与 ClickUp/Linear 的免费层限制维度不同，不能只看 `$0` 就判定等价。（A1，https://asana.com/pricing，2026-11-05）

### 6.3 功能覆盖与产品侧重

- **ClickUp 覆盖面最宽**：公开功能同时覆盖 tasks、Docs、Chat、Whiteboards、Sprints、Timesheets、Dashboards，并在 Max 叠加更完整的 AI 项目；这是“工作管理套件”式覆盖。（C1，https://clickup.com/pricing，2026-11-05）
- **Linear 更集中于 issue/产品开发流程**：页面核心对象是 issues、projects、cycles、initiatives，并列出 Triage、Issue SLAs、Releases、Code Intelligence、Sub-initiatives；其对比维度与通用项目管理工具不同。（L1，https://linear.app/pricing，2026-11-05）
- **Asana 更突出项目组合与目标管理**：Starter 起给 Timeline/Gantt，Advanced 起给 Unlimited portfolios、Goals、Resource management、Approvals，Enterprise 再加 universal resource management 与 capacity planning。（A1，https://asana.com/pricing，2026-11-05）
- **自动化可比性有限**：ClickUp 给出逐档 automation actions 数量；Asana Starter 直接写 Unlimited automations；Linear 该定价页没有统一自动化额度，只列 Triage rules 等规则能力。三者不是同一计量口径。（C1，https://clickup.com/pricing，2026-11-05；A1，https://asana.com/pricing，2026-11-05；L1，https://linear.app/pricing，2026-11-05）

### 6.4 AI、企业安全与合同能力

- **AI 计价方式不同**：ClickUp 采用 Brain² 月度 credits，并向所有档位分配额度；Linear 使用 AI credits 约束 Cloud coding agent 与 Loops，但页面不公开 credits 单价；Asana 采用 AI Studio credits/请求额度，并公开 `$0.50` 预付与 `$0.60` 按需的单次请求价格。单位不同，不能直接横比。（C1，https://clickup.com/pricing，2026-11-05；L1，https://linear.app/pricing，2026-11-05；A1，https://asana.com/pricing，2026-11-05）
- **企业身份能力均后置**：ClickUp 的 Microsoft/Okta/SAML SSO、SCIM、Audit Trails 从 Enterprise 起；Linear 的 SAML/SCIM 从 Enterprise 起；Asana 的 SAML/SCIM 也只在 Enterprise 列出。（C1，https://clickup.com/pricing，2026-11-05；L1，https://linear.app/pricing，2026-11-05；A1，https://asana.com/pricing，2026-11-05）
- **合同/安全扩展的公开程度不同**：ClickUp 在 Enterprise/Max 明示 MSA、Data Residency、HIPAA BAA、Enterprise API；Linear 在 Enterprise 明示 Invoice/PO、Custom terms、Uptime SLA；Asana 在 Enterprise+ 只给 SIEM、data residency、audit logs、dedicated workspaces 的说明，未给 Enterprise+ 价格。（C1，https://clickup.com/pricing，2026-11-05；L1，https://linear.app/pricing，2026-11-05；A1，https://asana.com/pricing，2026-11-05）

## 7. 异常、缺口与保留方式

| 编号 | 厂商/位置 | 页面事实 | 影响 | 本文处理 | 来源与抓取日期 |
| --- | --- | --- | --- | --- | --- |
| X1 | ClickUp Core/Business 价格卡 | 只显示 `$9 user / mo`、`$17 user / mo`；没有 `billed monthly` 或 `billed yearly` 标签。页面顶部出现 `MonthlyYearly` 切换和 `Save up to 33% with yearly`。 | 无法确认这两个数字对应月付还是年付。 | 价格照录，计费周期标为**未公开/待确认**；不将其与 Linear/Asana 年付价直接排名。 | C1，https://clickup.com/pricing，2026-11-05 |
| X2 | ClickUp Max 价格卡 | `$100 user / mo · billed yearly`；另示 `~Regular price $120~`；全页又宣称 `Save up to 33% with yearly`。 | 页面未说明 $120 是哪个周期/口径，也未说明与 33% 宣称的对应关系。 | 保留 `$100`、`$120` 和 `billed yearly` 原文，不做折扣率反算。 | C1，https://clickup.com/pricing，2026-11-05 |
| X3 | ClickUp 客服 FAQ | FAQ 使用 `Unlimited Plan` 的 guest seat 规则，但当前套餐卡为 Free/Core/Business/Enterprise/Max，没有 `Unlimited` 档。 | 无法确认 FAQ 的 `Unlimited Plan` 是否等同于 Core，或是否为旧名称。 | 只引用 Free 与 Business/Enterprise 可对应的规则；`Unlimited Plan` 映射标为**待确认**。 | C1，https://clickup.com/pricing，2026-11-05 |
| X4 | Linear 价格卡 | Basic/Business 只写年付价格与 `Billed yearly`；Enterprise 只写 `Annual billing only`。 | 月付价格、月付是否存在及年付承诺期未公开。 | 月付价格标为**未公开**；不按月付口径计算节省率。 | L1，https://linear.app/pricing，2026-11-05 |
| X5 | Asana 快照结构 | 同一页面快照中出现两份 Personal/Starter/Advanced/Enterprise 文案；前一份 Starter/Advanced 只写年付价，后一份同时写出月付价。顶部有 `Monthly`、`YearlySave up to 18%`。 | 若只读前一份会漏掉月付价格。 | 采用后一份明确写出 `$13.49 billed monthly`、`$30.49 billed monthly` 的原文，并在价格表并列年付/月付。 | A1，https://asana.com/pricing，2026-11-05 |
| X6 | Asana AI 按需段 | 同一段先写 on-demand `billed monthly`，又出现 `$5.99 per user, per month billed annually`，同时还有 `$0.60 per AI request, billed monthly`。 | 无法判断 `$5.99` 是 AI add-on 的席位费、另一计费方案，还是页面文案错误。 | 将其列入“可选 AI 用量价格”但不纳入主套餐价格；标为**计费口径未公开/待确认**。 | A1，https://asana.com/pricing，2026-11-05 |
| X7 | 三家页面 | 页面均使用 `$`，但快照没有明确写 currency code；ClickUp 与 Linear 快照没有税费说明。 | 无法确认币种、税费、含税/未税。 | 所有价格标“币种未公开（仅 `$`）”；不换算为 USD 或其他币种。Asana 单独保留其销售税/VAT/GST 说明。 | C1，https://clickup.com/pricing，2026-11-05；L1，https://linear.app/pricing，2026-11-05；A1，https://asana.com/pricing，2026-11-05 |
| X8 | Asana 页面文字质量 | 快照存在 `ber billing account`、`Al Meetings` 等拼写/OCR式文本。 | 不影响价格数字，但降低文本抽取质量。 | 功能含义按同一上下文核对后使用；原文异常保留在本行，不据此推断新功能。 | A1，https://asana.com/pricing，2026-11-05 |
| X9 | 三份 `source.json` | C1/L1/A1 均 `ok: true`、HTTP 200；没有失败正文。 | 无失败内容需要补写。 | 在 2.1/2.2 完整保留状态、时间、HTML 字节数和摘要。 | C1，https://clickup.com/pricing，2026-11-05；L1，https://linear.app/pricing，2026-11-05；A1，https://asana.com/pricing，2026-11-05 |

## 8. 需要销售或产品人工确认的问题

### 8.1 ClickUp

| ID | 建议确认对象 | 问题 | 为什么必须确认 |
| --- | --- | --- | --- |
| CQ1 | ClickUp Sales / Product | `Core $9`、`Business $17` 是月付价、年付价，还是页面某一切换状态下的人均月价？年付与月付的完整价目分别是什么？ | 页面价格卡未标计费周期，无法做同口径竞品比较。 |
| CQ2 | ClickUp Sales | Max 的 `$100 billed yearly` 与 `Regular price $120` 分别对应什么周期？续费价、最低席位、合同期为何？ | 可避免把促销/常规价混用。 |
| CQ3 | ClickUp Sales | Enterprise 的最低席位数、最低合同额、AI credits 包含量、Data Residency/HIPAA BAA、Enterprise API 是否另收费？ | `Custom` 未给任何可量化边界。 |
| CQ4 | ClickUp Product | FAQ 中的 `Unlimited Plan` 与当前哪一档对应？Free/付费档的 guest seats 和可编辑权限最终规则是什么？ | FAQ 与该页套餐卡名称不一致。 |
| CQ5 | ClickUp Sales | 所列 `$` 是哪种币种？报价是否含税？不同地区是否另有价目？ | 快照未给 currency code 或税费规则。 |

### 8.2 Linear

| ID | 建议确认对象 | 问题 | 为什么必须确认 |
| --- | --- | --- | --- |
| LQ1 | Linear Sales | Basic/Business 是否有公开月付价？若只有年付，最短承诺期、退款/升降级规则为何？ | 页面只给 `Billed yearly`，无法做月付比较。 |
| LQ2 | Linear Sales | Enterprise 的起始价格、最低席位、合同期、Invoice/PO 条件分别是什么？ | 页面只给 `Custom` 与 `Annual billing only`。 |
| LQ3 | Linear Product | AI credits 的单价、每档额度、Cloud coding agent 与 Loops 的消耗规则是什么？ | 页面标注这些功能需要 AI credits，但未公开价格/额度。 |
| LQ4 | Linear Sales | 页面 `$` 对应的币种、税费和地区价目是什么？ | 快照未给 currency code 或税费规则。 |

### 8.3 Asana

| ID | 建议确认对象 | 问题 | 为什么必须确认 |
| --- | --- | --- | --- |
| AQ1 | Asana Sales | Enterprise 的公开起价、最低席位、合同期是什么？Enterprise+ 与 Enterprise 的价格/功能边界分别是什么？ | 两项都未公开价格，Enterprise+ 只有功能描述。 |
| AQ2 | Asana Sales / Product | `$5.99 per user, per month billed annually` 的适用对象是什么？它与 `$0.60 per AI request, billed monthly`、`$0.50 prepaid` 的关系是什么？ | 同一 AI 段落出现 annual/monthly 两种口径，无法安全报价。 |
| AQ3 | Asana Sales | Asana Starter/Advanced 的年付与月付价是否均为未税刊例价？最低席位数/最低合同额为何？ | 页面列出数字与税费说明，但未给完整成交边界。 |
| AQ4 | Asana Product | Enterprise+ 的 SIEM、data residency、audit logs、dedicated workspaces 是否全部含在 Enterprise+，还是部分需另购？ | 页面只给一句扩展描述，未给套餐包含矩阵。 |
| AQ5 | Asana Product / Sales | AI Teammates 的 5 requests/user/month 与账户上限（50/50/250）超额后如何计费？AI Studio credits 超额后的单价是什么？ | 页面给出额度与部分请求单价，但未完整说明超额组合。 |

### 8.4 跨厂商/内部产品

| ID | 建议确认对象 | 问题 | 为什么必须确认 |
| --- | --- | --- | --- |
| PQ1 | 采购/财务/产品 | 我方比较假设的席位规模、合同期、月付/年付偏好、税费地区和 AI 用量是多少？ | 没有这些输入不能把三家的不同计价单位变成可执行 TCO。 |
| PQ2 | 产品/法务 | “Unlimited”“fair usage”“Enterprise-grade”“Custom”的合同定义和限额分别是什么？ | 页面营销词不能直接当成无上限或同等服务等级。 |
| PQ3 | 产品 | 需要的是通用工作管理、软件 issue/发布管理，还是项目组合/目标管理？ | 三家功能侧重不同；只按价格最低选型会忽略流程匹配度。 |

## 9. 专项验收自查

| 验收项 | 结果 | 可核查依据 |
| --- | --- | --- |
| 1. 对比 ClickUp、Linear、Asana 的公开套餐、价格、计费周期和关键功能 | 通过 | 第 3.1 节逐套餐列出价格与计费周期；第 4 节逐厂商列出关键功能；第 5 节给出跨厂商矩阵。三份 `source.json` 均为 `ok: true`。 |
| 2. 每个价格和功能结论附官方 URL 与抓取日期；未公开项标注、不推测 | 通过 | 价格表、AI 表、功能表、功能矩阵均有“来源与抓取日期”列；主价格均引用 https://clickup.com/pricing、https://linear.app/pricing 或 https://asana.com/pricing，日期为 2026-11-05；计费周期、月付价、币种、税费、Enterprise 价格等缺口均写“未公开/待确认”，未补写任何数字。 |
| 3. 输出为表格加差异说明，并列出需要销售或产品人工确认的问题 | 通过 | 第 3-5 节为表格；第 6 节为差异说明；第 8 节按 ClickUp、Linear、Asana、跨厂商分别列出人工确认问题。 |
| 硬性要求 1：只写交付文件，不改输入快照或其他文件 | 通过 | 本次仅创建 `out/competitor-comparison.md`；输入快照保持只读，完成后再次核对 `page.md` 摘要。 |
| 硬性要求 2：不联网、不搜索、不访问输入外链接 | 通过 | 仅读取本地 `inputs` 下三份 `page.md`/`source.json`；未执行网络请求，也未打开页面中的其他链接。 |
| 硬性要求 3：不编造输入中没有的事实，信息不足标“未知/待确认” | 通过 | 对 ClickUp Core/Business 周期、Linear 月付价、三家币种/税费、Asana Enterprise+ 价格、Asana AI `$5.99` 口径均标为“未公开/待确认”；没有推算价格或功能。 |
| 硬性要求 4：保留来源索引、日期、数字和异常说明 | 通过 | 第 2 节保留 URL、抓取时间、HTTP/ok、标题、字节数、SHA-256；第 7 节逐项保留异常 X1-X9；第 10 节保留原文行号与摘录。 |
| 硬性要求 5：若 `source.json` 为 `ok:false`，保留失败状态和原因 | 不适用/已核对 | 三份均为 `ok:true`，无失败状态；已在第 2.3 节明确记录。 |
| 硬性要求 6：完成前逐条自查并保留依据 | 通过 | 即本节；第 10 节提供可逐行回查的快照摘录。 |
| 硬性要求 7：最后用中文简短说明完成内容和人工确认项 | 通过 | 交付末尾的“中文交付说明”将给出简短总结和待确认重点。 |

## 10. 可核查原文摘录

> 行号基于对应 `page.md` 的只读快照；引文保持英文原文，未改写数字或条件。

来源 ID 对照：C1 = https://clickup.com/pricing（2026-11-05）；L1 = https://linear.app/pricing（2026-11-05）；A1 = https://asana.com/pricing（2026-11-05）。

| 来源 | 快照行号 | 原文摘录 | 本文用途 |
| --- | --- | --- | --- |
| C1 | `page.md:7` | `Save up to 33% with yearly` | ClickUp 年付优惠宣称 |
| C1 | `page.md:145-149` | `$100`；`~Regular price $120~`；`user / mo · billed yearly` | ClickUp Max 价格与计费周期 |
| C1 | `page.md:205-221` | `Free$0user / mo`；`Core$9user / mo`；`Business$17user / mo`；`EnterpriseCustom`；`Max$100user / mo` | ClickUp 套餐卡价格 |
| C1 | `page.md:250` | `AI Credits` 列值为：`500/ workspace`；`1,000/ user / mo · pooled`；`1,500/ user / mo · pooled`；`3,000/ user / mo · pooled`；`10,000/ user / mo · pooled` | ClickUp AI credits 分档 |
| C1 | `page.md:331` | `Automation Actions` 列值为：`100actions / workspace / month`；`1,000actions / workspace / month`；`10,000actions / workspace / month`；`1Mactions / workspace / month`；`1Mactions / workspace / month` | ClickUp 自动化额度 |
| C1 | `page.md:377-381` | `Google SSO` 各列为 `Not included`、`Not included`、`Included`、`Included`、`Included`；`SAML SSO`、`SCIM Provisioning` 在 Enterprise/Max 为 `Included` | ClickUp 身份能力分档 |
| C1 | `page.md:512-516` | `Free Forever Workspaces can have an unlimited number of members and guests at no charge.`；`Unlimited Plan: receive 5 guest seats for a 1 paid user Workspace and 2 guest seats for each additional paid user you invite to your Workspace`；`Business Plan: receive 10 guest seats for a 1 paid user Workspace and 5 guest seats for each additional paid user you invite to your Workspace` | ClickUp guest 规则及 `Unlimited Plan` 命名异常 |
| L1 | `page.md:1-20` | `Free`、`$0`、`Free for everyone`；`Basic`、`$10 per user/month`、`Billed yearly` | Linear Free/Basic 价格 |
| L1 | `page.md:30-34` | `Business`；`$16 per user/month`；`Billed yearly` | Linear Business 价格 |
| L1 | `page.md:47-51` | `Enterprise`；`Custom`；`Annual billing only` | Linear Enterprise 价格与周期 |
| L1 | `page.md:85-123` | `Members`、`Issues`、`Teams` 对应 `Unlimited`、`250 issues`、`2 teams`/`5 teams` 等 | Linear 免费/付费配额 |
| L1 | `page.md:299-337` | `Cloud coding agent**`、`Loops**`、`Code Intelligence`、`Triage Intelligence` 的 Included/Not included 状态 | Linear AI/代码能力 |
| L1 | `page.md:507-519` | `SSO` 为 `Google`/`Google + SAML`；`Admin roles` 各档 Included | Linear SSO/admin 能力 |
| L1 | `page.md:659` | `** Requires AI credits` | Linear AI credits 条件 |
| A1 | `page.md:5-7` | `Monthly`；`YearlySave up to 18%` | Asana 月/年切换与年付宣称 |
| A1 | `page.md:274-276` | `$10.99`；`Per user, per month billed annually. $13.49 billed monthly` | Asana Starter 年付/月付 |
| A1 | `page.md:329-331` | `$24.99`；`Per user, per month billed annually. $30.49 billed monthly` | Asana Advanced 年付/月付 |
| A1 | `page.md:164-168` | `Contact sales for pricing` | Asana Enterprise 价格未公开 |
| A1 | `page.md:224-226` | `Enterprise+ available for advanced security and compliance`；`SIEM integration, data residency, audit logs and dedicated workspaces` | Asana Enterprise+ 功能与价格缺口 |
| A1 | `page.md:1118-1139` | `$0.50 per AI request, billed upfront`；`$5.99 per user, per month billed annually`；`$0.60 per AI request, billed monthly` | Asana AI 价格及口径冲突 |
| A1 | `page.md:1306-1324` | `Will I be charged sales tax?`；`Yes. We will apply state and local sales tax based on your billing address to your total charge.`；`Asana may be required to charge VAT, GST, and other taxes on your subscription in accordance with local laws and regulations.` | Asana 税费说明 |

## 11. 中文交付说明

已完成 ClickUp、Linear、Asana 的公开套餐、价格、计费周期与关键功能对比，并将来源 URL、抓取日期、HTTP/`ok` 状态、快照摘要、页面行号和异常说明写入本文件。价格以页面原文为准，未做币种换算或年化/月化推算；未公开项均已明确标注。

仍需人工确认的重点：

- ClickUp Core/Business 的 `$9`/`$17` 对应月付还是年付，以及币种、税费、最低席位和 Enterprise 报价边界。
- ClickUp FAQ 中 `Unlimited Plan` 与当前套餐卡的映射关系，以及 Max 的 `$100`/`$120` 口径。
- Linear Basic/Business 的月付价格、年付承诺期，以及 AI credits 的单价与额度。
- Asana Enterprise/Enterprise+ 的真实起价与合同条件，以及 AI 段落中 `$5.99 per user, per month billed annually` 与 `$0.60 per AI request, billed monthly` 的适用关系。
- 三家页面的 `$` 具体币种、税费及地区差异；本快照不足以确认。
