# T04 输入：网页资料归档

## 目标文件夹

`eval/runs/T04/pages/`

## URL 清单

1. `https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Overview`
2. `https://docs.github.com/en/issues/tracking-your-work-with-issues/learning-about-issues/about-issues`
3. `https://www.w3.org/WAI/WCAG22/quickref/`

## 提取要求

- 每个成功页面生成一个 Markdown 文件，文件名使用 `01-<slug>.md`、`02-<slug>.md`、`03-<slug>.md`。
- 文件开头保留来源 URL、最终 URL、HTTP 状态、抓取时间（ISO 8601）和页面标题。
- 保留正文的标题层级、列表、表格、代码块和指向其他页面的原始链接；链接应转换为绝对 URL。
- 删除导航、广告、Cookie 横幅、页脚推荐和重复目录。
- 生成 `eval/runs/T04/manifest.json`，逐条记录 URL、最终 URL、HTTP 状态、抓取时间、输出文件、字符数和失败原因。
- 遇到登录、验证码、付费墙或访问限制时停止该页并记录，不绕过限制。
- 不要为无法访问的页面生成正文或摘要。

