# 归档验收自查

- 自查时间（UTC）：`2026-11-05T10:01:47Z`
- 结论：**全部通过（4/4）**
- 范围：3 个指定 URL；仅使用本地只读快照，未联网。

## 专项验收标准

| # | 验收标准 | 结果 | 可核查依据 |
| --- | --- | --- | --- |
| 1 | 三个 URL 的访问状态、最终 URL、抓取时间、HTTP 状态和内容摘要 | 通过 | manifest.json 的 pages 数组逐项记录上述字段；对应归档页的抓取证据表亦重复展示。 |
| 2 | 每个页面为可阅读 Markdown，并保留标题、表格、代码块和链接 | 通过 | 每页均有 H1、抓取证据表、source.json fenced code block 和可点击 URL；MDN 正文另保留 2 个 HTTP 报文代码块与 5 张图片。 |
| 3 | manifest.json 记录原始 URL、最终 URL、抓取时间、状态、标题、文件路径和 SHA-256 | 通过 | manifest.json 每个页面对象均含 requestedUrl、finalUrl、fetchedAt、httpStatus、accessStatus、title、filePath、sha256；构建后已重算文件 SHA-256 并核对。 |
| 4 | 访问失败记录失败原因，不伪造正文 | 通过 | WCAG 页面记录 access_challenge 与原始 errorMessage，正文仅保留输入中的失败说明；source.json 的 title、contentType、sha256 保持 null，bytes 保持 0。 |

## 页面级证据

| 页面 | H1 | 表格数 | 代码块数 | 链接标记数 | SHA-256 已核对 |
| --- | --- | --- | --- | --- | --- |
| `pages/01-mdn-http-overview.md` | Overview of HTTP | 1 | 3 | 65 | 是 |
| `pages/02-github-about-issues.md` | About issues | 1 | 1 | 37 | 是 |
| `pages/03-wcag22-quickref.md` | 网页抓取失败 | 1 | 1 | 2 | 是 |

## 输入快照校验

| 快照 | 字节数 | SHA-256 |
| --- | --- | --- |
| `inputs/01-MDN-HTTP-指南/page.md` | 19504 | `8fd966d10cf3b7e3d80a2ca97787b81cb83996d5d508f1345917f2e6829a5774` |
| `inputs/02-GitHub-Issues-文档/page.md` | 8141 | `89b9bbb1d98f7e9922ffb3be99ea7afa25bfa0841caf717eea9f06f60c90b3da` |
| `inputs/03-WCAG-2.2-快速参考/page.md` | 424 | `c7f0bf98d9c437988724f2905b72c092683a6b3b49ba8c51eee05aad05e6a84f` |

## 异常与待确认

- WCAG 2.2 快速参考：`source.json` 的 `ok` 为 `false`，`errorCode` 为 `access_challenge`；HTTP 状态虽为 200，但网页要求登录、验证码或浏览器验证，因此没有可用正文；标题、内容类型、原始 HTML SHA-256 为 null，原始 HTML 字节数保留为 0。
- 源快照未发现 Markdown 表格：MDN 为 0，GitHub 为 0；归档页中的抓取证据表是本次为核验新增的元数据表，不是网页正文表格。
- 源快照未发现 GitHub 页面代码块；归档页中唯一的代码块是 source.json 证据块。MDN 正文保留 2 个原始 HTTP 报文代码块。
- 源快照中的页脚、导航或 UI 文本（如 MDN footer、GitHub 的 “In this article” / “Copy markdown”）按原样保留，未做内容删改。
