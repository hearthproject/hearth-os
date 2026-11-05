<!-- 归档生成时间：2026-11-05T17:39:42+08:00；仅使用输入快照，未联网。 -->

# 归档失败：WCAG 2.2 快速参考

> **说明**：此 H1 是归档状态标题，不是网页标题；页面标题未知。
> **归档状态**：失败；未获取网页正文。
> **内容摘要**：未知（未获取网页正文）。`source.json` 记录访问失败，错误码 `access_challenge`；失败原因为网页要求登录、验证码或浏览器验证。未根据 URL、标题或常识补写正文。
> **抓取时间**：`2026-11-05T09:31:52.408Z`
> **原始 URL**：[https://www.w3.org/WAI/WCAG22/quickref/](https://www.w3.org/WAI/WCAG22/quickref/)
> **最终 URL**：未知（`source.json.finalUrl` 为 `null`；未到达最终页面）。
> **HTTP 状态**：未知（`source.json.status` 为 `null`）。

## 抓取证据

| 字段 | 值 |
| --- | --- |
| 原始 URL | [https://www.w3.org/WAI/WCAG22/quickref/](https://www.w3.org/WAI/WCAG22/quickref/) |
| 最终 URL | 未知（source.json 为 `null`；未到达最终页面） |
| 抓取时间 | `2026-11-05T09:31:52.408Z` |
| 访问状态 | `failed` |
| HTTP 状态 | 未知（source.json 为 `null`） |
| 来源 `ok` | `false` |
| 内容类型 | 未知（null） |
| 来源字节数 | 0 |
| 页面标题（`source.json`） | 未知（未获取页面标题） |
| 正文标题（快照 H1） | 网页抓取失败 |
| 来源正文快照 | `inputs/03-WCAG-2.2-快速参考/page.md` |
| 来源元数据 | `inputs/03-WCAG-2.2-快速参考/source.json` |
| 来源 SHA-256（抓取 HTML） | 未知（`source.json.sha256` 为 `null`） |
| 快照 Markdown 文件 SHA-256 | `9b4ceba8de1efadbe8a15a6b8f698c9dc9b7ebe0a2e7e1626207918b5bf11a56` |
| 归档文件 SHA-256 | 见 `manifest.json` 中的 `sha256`（避免文件自引用） |
| 快照结构 | 标题 1；表格 0；代码块 0；链接 0 |
| 内容中日期 | 未知（未获取页面） |
| 异常说明 | 抓取失败：access_challenge；未获取正文。 |

## 失败详情

- 错误代码：`access_challenge`
- 失败原因：网页要求登录、验证码或浏览器验证：https://www.w3.org/WAI/WCAG22/quickref/
- 来源状态：`source.json.ok=false`。
- 处理规则：未根据 URL、任务名称、常识或标题推断并补写网页正文。

## 未获取正文

未获取到该网页正文。禁止根据标题、摘要或常识补写页面内容。

### 输入 `page.md` 原文（抓取失败说明，不是网页正文）

```text
# 网页抓取失败

- 原始 URL：https://www.w3.org/WAI/WCAG22/quickref/
- 抓取时间：2026-11-05T09:31:52.408Z
- 错误代码：access_challenge
- 失败原因：网页要求登录、验证码或浏览器验证：https://www.w3.org/WAI/WCAG22/quickref/

未获取到该网页正文。禁止根据标题、摘要或常识补写页面内容。
```

### `source.json` 原始内容（去除 UTF-8 BOM 后原样嵌入）

```json
{
  "requestedUrl": "https://www.w3.org/WAI/WCAG22/quickref/",
  "finalUrl": null,
  "fetchedAt": "2026-11-05T09:31:52.408Z",
  "status": null,
  "contentType": null,
  "title": null,
  "bytes": 0,
  "sha256": null,
  "ok": false,
  "errorCode": "access_challenge",
  "errorMessage": "网页要求登录、验证码或浏览器验证：https://www.w3.org/WAI/WCAG22/quickref/"
}
```

## 待人工确认

- 页面标题：未知。
- 最终 URL：未知。
- HTTP 状态：未知。
- 页面正文、表格、代码块与链接：未获取，无法确认或保留。
- 后续处理：需要在允许联网且通过浏览器验证的环境中重新抓取；本次未尝试绕过验证。
