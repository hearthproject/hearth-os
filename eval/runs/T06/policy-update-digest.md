# AI 治理官方政策更新摘要

- 生成日期：2026-11-05
- 资料范围：任务提供的 3 份只读网页快照
- 来源限制：仅使用 EU、NIST、ICO 的官方来源；未联网、未搜索网页、未访问快照之外的链接
- 时间基准：访问时间为快照 `source.json` 记录的 UTC 时间；正文日期按来源原文记录
- 重要口径：本摘要只把来源页面中的可核对表述视为事实；“未载明”“未知”“待确认”均不推定

## 结论速览

1. **EU（可实质摘要）**：AI Act 页面抓取成功，页面标注最后更新于 **2026-10-19**。页面载明 AI Act 于 **2024-08-01** 生效、于 **2026-08-02** 适用，并列出禁止性实践、GPAI、治理执法、透明度及高风险系统的分阶段时间表；同时载明“AI Omnibus”的通过、政治协议和生效日期。
2. **NIST（仅有限确认）**：页面抓取成功，但提供的正文快照只有一句概述及其指向的一篇 NIST 新闻链接。**版本号、发布日期、更新时间、具体修订内容及生效时间均未知**，不能据此描述为某项已确认的新版政策变化。
3. **ICO（不可摘要）**：抓取返回 **HTTP 403**，`bytes=0`，无网页正文、标题或日期。**变更类型、适用范围、生效时间和发布日期均未知**；不得根据标题、URL 或常识补写。

> “无法确认”不等于“没有更新”。NIST 和 ICO 在本次快照条件下均不能得出无更新或已更新结论。

## 按政策主体整理

### 1. 欧盟委员会（European Commission）——EU AI Act

| 项目 | 可核对内容 |
|---|---|
| 政策主体 | 欧盟委员会（European Commission），EU AI Act 官方政策页 |
| 官方文件标识 | Regulation (EU) 2024/1689；页面称其为全球首个综合性 AI 法律框架 |
| 变更类型 | 综合立法框架的实施与简化；页面另述“AI Omnibus”对实施时间表及部分条款作出调整 |
| 适用范围 | 面向 AI 开发者和部署者，按用途实施风险分级规则；页面列出 4 个风险等级，并对 GPAI 模型提供者设置透明度、版权及系统性风险评估/缓解等规则。页面未在快照中给出完整的辖域定义，**具体地域与主体衔接细节待确认** |
| 页面发布日期/更新时间 | **页面最后更新：2026-10-19**；快照未单列首次发布日期 |
| 原文链接 | [EU AI Act 官方政策页](https://digital-strategy.ec.europa.eu/en/policies/regulatory-framework-ai)；页面所引法规为 [Regulation (EU) 2024/1689](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A32024R1689)（未访问） |

#### 可确认的更新与生效节点

| 日期 | 事项 | 适用范围/说明 |
|---|---|---|
| 2024-08-01 | AI Act 生效（entered into force） | AI Act 整体 |
| 2025-02-02 | 禁止性 AI 实践及 AI 素养义务开始适用 | 页面另述“禁止性实践 1–8”于 2025 年 2 月生效；精确时间表采用 2025-02-02 |
| 2025-08-02 | 治理规则及 GPAI 模型义务开始适用 | 页面另述 GPAI 规则于 2025 年 8 月生效 |
| 2025-11-19 | “AI Omnibus”获通过（adopted） | 页面未说明通过该文本的具体机构 |
| 2026-05-07 | 就简化 AI 规则达成政治协议 | AI Omnibus |
| 2026-07-27 | AI Omnibus 生效 | AI Omnibus |
| 2026-08 | AI Act 透明度规则生效 | 页面仅给出月份，**具体日期未知** |
| 2026-08-02 | AI Act 一般适用日；AI Office 与成员国主管机关开始实施、监督和执法 | 页面称 AI Office 对 GPAI 模型具有执法权，可要求技术文档、评估模型、要求纠正措施并对不合规行为罚款 |
| 2026-12 | 第 9 项禁止性实践生效 | 针对生成非自愿性露骨/私密内容或儿童性虐待材料（CSAM）的 AI 系统，例如“nudification”应用；页面仅给出月份，**具体日期未知** |
| 2027 | AI 模型评估能力建设预计投入运行 | 页面称委员会将发起征集，以在模型进入 EU 市场前加强评估；为“预计”而非已生效义务 |
| 2027-12-02 | 特定敏感领域高风险 AI 规则开始适用 | 包括生物识别、关键基础设施、教育、就业、移民、庇护和边境控制；页面称该期限因 AI Omnibus 政治协议而延展 |
| 2028-08-02 | 嵌入受监管产品的高风险 AI 系统规则开始适用 | 页面所举产品包括电梯、玩具；页面称该期限因 AI Omnibus 政治协议而延展 |

#### 其他可核对的数量与实施信息

- AI Act 设定 **4 个风险等级**：不可接受风险、高风险、透明度风险、最小或无风险。
- 页面列明 **9 项禁止性实践**；其中第 1–8 项于 2025 年 2 月生效，第 9 项于 2026 年 12 月生效，且第 9 项由 AI Omnibus 引入。
- 2025 年 7 月，委员会发布 **3 项**支持 GPAI 模型负责任开发与部署的工具：GPAI 义务范围指南、GPAI 行为准则、GPAI 训练内容公开摘要模板。
- 页面称 AI Act 与 AI Continent Action Plan、AI Innovation Package、AI Factories 等共同构成可信 AI 政策组合；本次未访问这些链接，故不将其内容作为独立更新来源。
- 页面“Latest News”栏目包含 2026-09-30 至 2026-10-30 的多条新闻，但本摘要**不把新闻栏目条目当作政策条款更新**。

#### 来源证据定位

- 4 个风险等级：`inputs/01-EU-AI-Act/page.md:19`
- 9 项禁止性实践及第 9 项时间：`inputs/01-EU-AI-Act/page.md:25-42`
- 高风险系统义务与 2027-12-02 起始日：`inputs/01-EU-AI-Act/page.md:58`
- 透明度规则于 2026 年 8 月生效：`inputs/01-EU-AI-Act/page.md:74`
- GPAI 规则于 2025 年 8 月生效：`inputs/01-EU-AI-Act/page.md:88`
- AI Office 自 2026-08-02 起执法：`inputs/01-EU-AI-Act/page.md:109`
- 主时间表及 Annex I/III 延展：`inputs/01-EU-AI-Act/page.md:117-123`
- AI Omnibus 日期、2027-12-02 与 2028-08-02：`inputs/01-EU-AI-Act/page.md:127-132`
- 页面最后更新：`inputs/01-EU-AI-Act/page.md:295-297`

### 2. 美国国家标准与技术研究院（NIST）——AI Risk Management Framework

| 项目 | 可核对内容 |
|---|---|
| 政策主体 | 美国国家标准与技术研究院（NIST） |
| 来源标题 | AI Risk Management Framework（取自 `source.json`） |
| 变更类型 | 页面以 “New guidance” 指称相关指引；但新版、修订或补充的具体性质**未知** |
| 适用范围 | 页面仅概括为“AI 技术”的可信性、创新与风险缓解；具体适用主体、行业及强制性**未知** |
| 生效时间 | **未知**；页面未载明 |
| 发布日期/更新时间 | **未知**；页面未载明。图片链接文本中的 “2023/01” 仅为链接路径，不能据此当作已核实的发布日期 |
| 原文链接 | [NIST AI Risk Management Framework](https://www.nist.gov/itl/ai-risk-management-framework) |

#### 快照实际提供的内容

页面正文快照仅有一句概述：

> “New guidance seeks to cultivate trust in AI technologies and promote AI innovation while mitigating risk.”

该句可支持“页面称相关指引旨在培育 AI 信任、促进创新并降低风险”，但不能支持版本、发布日期、具体控制项、适用对象或生效状态的判断。快照中的 NIST 新闻链接未被访问，也未用作独立政策更新依据。

#### 来源证据定位

- 标题与访问状态：`inputs/02-NIST-AI-RMF/source.json`
- 唯一概述句：`inputs/02-NIST-AI-RMF/page.md:3`

### 3. 英国信息专员办公室（ICO）——AI guidance

| 项目 | 可核对内容 |
|---|---|
| 政策主体 | 英国信息专员办公室（ICO） |
| 来源主题 | 输入标注为 UK ICO AI guidance；官方页面原始 URL 见下 |
| 访问结果 | **失败：HTTP 403**；未获取正文 |
| 变更类型 | **未知** |
| 适用范围 | **未知** |
| 生效时间 | **未知** |
| 发布日期/更新时间 | **未知** |
| 原文链接 | [ICO artificial intelligence guidance](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/artificial-intelligence/) |

#### 不可访问原因（完整保留）

- 原始 URL：`https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/artificial-intelligence/`
- 最终 URL：`https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/artificial-intelligence/`
- 抓取时间：`2026-11-05T10:14:00.497Z`
- HTTP 状态：`403`
- 错误代码：`http_error`
- 错误信息：`网页返回 HTTP 403：https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/artificial-intelligence/`
- 网页内容：`bytes=0`、`contentType=null`、`title=null`、`sha256=null`

`inputs/03-UK-ICO-AI-guidance/page.md` 的 550 字节是“网页抓取失败”的错误说明，**不是 ICO 指引正文**。因此本摘要不提供 ICO 指引内容、版本变化或生效结论。

#### 来源证据定位

- 失败状态与原因：`inputs/03-UK-ICO-AI-guidance/source.json`
- 失败说明：`inputs/03-UK-ICO-AI-guidance/page.md:1-10`

## 来源索引与访问证据

| ID | 政策主体 | 官方 URL | 本地快照 | 抓取时间（UTC） | HTTP | HTTP 响应字节 | 本地 `page.md` 字节 | SHA-256 |
|---|---|---|---|---:|---:|---:|---|---|
| S1 | European Commission —— AI Act | https://digital-strategy.ec.europa.eu/en/policies/regulatory-framework-ai | `inputs/01-EU-AI-Act/page.md` | 2026-11-05T10:13:58.695Z | 200 | 92,991 | 26,161 | `901ac46b0d5f2649d6e5af2609ed11515d879c7fa3acfb323ed8a4e8e6b8af74` |
| S2 | NIST —— AI RMF | https://www.nist.gov/itl/ai-risk-management-framework | `inputs/02-NIST-AI-RMF/page.md` | 2026-11-05T10:13:59.367Z | 200 | 93,968 | 471 | `6daaf57d6c625d077ec85e1eac255a24a09df8523cd564e0e3fe8c66775d2be5` |
| S3 | UK ICO —— AI guidance | https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/artificial-intelligence/ | `inputs/03-UK-ICO-AI-guidance/page.md` | 2026-11-05T10:14:00.497Z | 403 | 0 | 550（错误说明，非正文） | `null` |

补充状态字段：

- S1：`contentType=text/html; charset=UTF-8`；`title=AI Act`；`ok=true`
- S2：`contentType=text/html; charset=UTF-8`；`title=AI Risk Management Framework`；`ok=true`
- S3：`contentType=null`；`title=null`；`ok=false`；`errorCode=http_error`

## 日期、数字与异常核对

- **日期精确性**：EU 页面给出日级日期的项目按日记录；仅给出“2026 年 8 月”“2026 年 12 月”的项目未擅自补日为具体日期。
- **数字保留**：4 个风险等级、9 项禁止性实践、3 项 GPAI 支持工具、Regulation (EU) 2024/1689，均直接来自 EU 快照。
- **新闻与政策区分**：EU “Latest News”栏目未被作为政策变更依据；NIST 页面上的新闻链接未被访问；ICO 无正文，未使用二手解读。
- **NIST 信息不足**：成功状态仅证明页面可访问，不证明摘要完整。快照没有日期、版本号、目录结构或具体变更说明。
- **ICO 失败状态**：403 与零字节正文均保留；没有伪造标题、日期或政策内容。
- **EU 时间表口径**：页面早段称“禁止性实践 1–8”于 2025 年 2 月生效，时间表精确写为 2025-02-02；本摘要采用更精确的时间表日期并保留两者关系。
- **待人工确认**：EU 页面未说明 AI Omnibus 通过文本的具体机构；NIST 的版本、日期、具体修订与适用性；ICO 的实际页面内容及是否存在更新。上述均不能由现有快照确认。

## 专项验收自查

| 验收项 | 自查结果 | 可核查依据 |
|---|---|---|
| 1. 仅用 EU、NIST、ICO 官方来源；逐项记录访问状态、发布日期或更新时间 | **通过** | 来源索引 S1–S3；S1 成功且最后更新 2026-10-19；S2 成功但日期未知；S3 HTTP 403、日期未知 |
| 2. 按政策主体、变更类型、适用范围、生效时间和原文链接整理 | **通过** | 三个“按政策主体整理”小节均含上述字段；EU 另列逐项时间表 |
| 3. 无法确认日期或条款标为未知；不把新闻稿或二手解读当官方更新 | **通过** | NIST/ICO 的未知项均已标注；EU Latest News 明确排除；未访问任何外部链接 |
| 硬性要求 3–5：不编造、保留来源索引/日期/数字/异常、保留失败状态 | **通过** | 结论速览、来源索引、日期与异常核对、ICO 403 原文均保留 |
| 硬性要求 6：逐条自查并保留依据 | **通过** | 本表及各小节“来源证据定位” |

## 仍需人工确认

1. NIST AI RMF 页面的完整正文、版本号、发布日期/更新日期、具体修订内容及生效状态。
2. ICO 页面在 HTTP 403 背后的实际内容、最新版本与更新日期；需在许可条件下重新获取官方页面或人工核验。
3. EU 页面提及但未在快照内展开的法规、指南、标准及 AI Omnibus 最终文本细节；本摘要未访问这些链接，不作延伸结论。
