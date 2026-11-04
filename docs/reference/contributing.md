---
title: '参与贡献与文档维护'
description: 'Hearth 的仓库结构、本地开发、文档写作约定、PR 检查清单、事实源与许可证。'
outline: [2, 3]
---

<p class="eyebrow">CONTRIBUTING</p>

# 参与贡献与文档维护

<p class="lead">Hearth 仍处于规格阶段。当前最有价值的贡献是澄清产品边界、补强协议、挑战风险假设，以及让文档更容易被实现者使用。</p>

## 仓库结构

```text
hearth-os/
├─ docs/
│  ├─ index.md                 # 中文首页
│  ├─ en/                      # 英文镜像
│  ├─ guide/                   # 开始阅读
│  ├─ product/                 # 产品定义与原则
│  ├─ architecture/            # 系统设计
│  ├─ delivery/                # 路线图、计划、工程与风险
│  ├─ reference/               # 边界、术语、FAQ、归档
│  └─ .vitepress/              # 站点配置与主题
├─ package.json
└─ README.md
```

## 本地开发

```bash
npm install
npm run docs:dev
```

构建与预览：

```bash
npm run docs:build
npm run docs:preview
```

## 文档写作约定

- 先写结论，再解释推理；避免把实现细节埋在长段落里。
- 使用明确的实体名：Task、Ticket、Run、Mandate、Receipt、Artifact、Memory、Skill。
- 区分“事实”“判断”“待验证假设”，不要把愿望写成已完成能力。
- 每个阶段都必须有用户可见界面、持久状态、验证证据和恢复路径。
- 外部副作用必须写清楚审批、幂等、回执和对账。
- 图表优先使用文本或 Mermaid，保证可 diff、可翻译。
- 中文与英文保持同构：路径、标题层级和导航位置一致。

## 提交 PR 前

1. 运行 `npm run docs:build`，确认没有死链或构建错误；
2. 检查中文页面和英文页面的路径是否对应；
3. 如果修改了事实、协议或阶段门槛，同步检查[完整路线图](/reference/full-roadmap)和相关 ADR；
4. 说明改动影响哪个阶段、哪个读者和哪个风险；
5. 不要提交 `.vitepress/dist`、缓存或本地密钥。

## 文档事实源

本站是原始路线图的可读版本；[完整路线图归档](/reference/full-roadmap)保留原始长文。若两者出现差异，以完整主文档和仓库提交历史为准，并在 PR 中说明重组理由。

## 许可证

项目使用 Apache-2.0。提交贡献即表示你同意按该许可证发布内容。
