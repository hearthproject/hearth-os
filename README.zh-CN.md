<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/public/brand/hearth-os-logo-reverse.png">
    <source media="(prefers-color-scheme: light)" srcset="docs/public/brand/hearth-os-logo.png">
    <img src="docs/public/brand/hearth-os-logo.png" alt="Hearth OS" width="420">
  </picture>
</p>

**一个单用户、自托管的个人 Agent OS，让数字工作可持久、可审计、可恢复。**

[English](README.md) | [简体中文](README.zh-CN.md)

[![文档](https://img.shields.io/badge/文档-中文%20%7C%20English-b8471d)](https://hearthproject.github.io/hearth-os/)
[![状态](https://img.shields.io/badge/状态-规格与规划阶段-8c8378)](#项目状态)
[![许可证](https://img.shields.io/badge/license-Apache--2.0-1b1815)](LICENSE)

Hearth 把用户意图变成可持久、可审计、可恢复的任务。它协调 Codex、连接器、浏览器、桌面 Agent 等专用执行器，并把所有外部副作用放在明确审批、幂等、回执和恢复机制之后。

Hearth 不是另一个 Coding Agent，也不是聊天套壳。它是一个以任务为中心的个人数字劳动控制面：用户看到任务和结果，系统负责状态、权限、证据、预算和失败处理。

## 为什么需要 Hearth

- **默认持久。** 任务不会随聊天窗口关闭而消失，进程重启、断线或部分失败后仍可恢复。
- **先有证据，再谈完成。** 只有同时具备用户可见结果、持久状态、验证证据和恢复路径，任务才算完成。
- **外部副作用必须显式受控。** 邮件、日历、文件、浏览器和桌面动作都要经过审批、幂等、回执与对账。
- **执行器可以替换。** Codex、Native、Connector、Browser、GUI、Document/Data 和 Human 按能力与风险路由。
- **单用户、本地优先。** 个人数据、凭据、记忆和执行历史由用户自己掌控。
- **安静的任务卡体验。** 产品围绕任务和注意力组织，而不是把内部 Agent 活动堆成仪表盘。

## 项目状态

Hearth 当前处于**规格与规划阶段**。仓库已经包含完整的产品、架构、安全、评估和交付计划，但实现尚未开始。

| 项目 | 状态 |
|---|---|
| 文档 | 由 `docs/` 直接构建的中英双语文档站 |
| 阶段 | 规格与规划 |
| 实现 | 尚未开始 |
| 下一个里程碑 | Stage 0：产品真相、可点击原型、协议契约与评测基线 |
| 许可证 | Apache-2.0 |

### 已经定义

- 产品定义、目标用户、非目标与设计原则；
- 八类任务、自主级别和可执行的“完成”定义；
- 七个平面、领域实体、事件、执行器、审批与回执；
- 持久执行、人工接管、Sandbox、凭据、记忆与进化；
- 安全、隐私、威胁模型、评估体系与阶段门槛；
- Stage 0–6 产品路线图、35 个开发增量和 140 个工作包；
- 工程结构、风险、Kill Criteria、ADR 与运行边界。

### 尚未开始

- 可运行的 `hearthd`、`hearth` CLI 和 Web 界面；
- Stage 0 可点击原型与真实任务 fixtures；
- 第一个 Codex Executor 纵向切片；
- Connector、Browser、GUI 和 Document/Data 执行器；
- Memory OS、Evolution OS 与多设备同步。

## 文档

完整文档发布在 **<https://hearthproject.github.io/hearth-os/>**。

所有正式文档只存放在一个地方：[`docs/`](docs/)。文档站直接由该目录构建，中文页面是默认文档源，`docs/en/` 是结构对应的英文镜像。仓库不再保留第二份 `sources/` 文档目录，因此仓库内容和线上站点不会各自演化成不同版本。README 只是仓库入口，负责概括和导航，不复制正文。

- [中文文档](https://hearthproject.github.io/hearth-os/)
- [English documentation](https://hearthproject.github.io/hearth-os/en/)
- [完整路线图归档](https://hearthproject.github.io/hearth-os/reference/full-roadmap.html) — 同一份 `docs/` 源中的长文参考。
- [文档地图与维护](https://hearthproject.github.io/hearth-os/reference/source-map.html) — 目录结构、阅读层级和维护规则。

### 从这里开始

1. [认识 Hearth](https://hearthproject.github.io/hearth-os/guide/what-is-hearth.html) — 定位、目标用户、边界，以及为什么不是 Codex 套壳。
2. [产品定义](https://hearthproject.github.io/hearth-os/product/definition.html) — Hearth 做什么、不做什么、为谁服务。
3. [系统设计](https://hearthproject.github.io/hearth-os/architecture/) — 控制面、领域协议、执行器、安全、记忆和评估。
4. [产品路线图](https://hearthproject.github.io/hearth-os/delivery/roadmap.html) — Stage 0–6 的范围、出口与推迟项。
5. [从 0 到 100 开发计划](https://hearthproject.github.io/hearth-os/delivery/development-plan.html) — 七个模块、35 个增量和 140 个工作包。

### 文档地图

| 区域 | 内容 | 入口 |
|---|---|---|
| 开始阅读 | 项目介绍、阅读路径与当前状态 | [打开](https://hearthproject.github.io/hearth-os/guide/) |
| 产品 | 定义、原则、任务覆盖与完成标准 | [打开](https://hearthproject.github.io/hearth-os/product/) |
| 系统设计 | 架构、协议、控制面、执行器、安全、记忆、进化与评估 | [打开](https://hearthproject.github.io/hearth-os/architecture/) |
| 交付路线 | 路线图、开发计划、Stage 模块、工程、风险与 ADR | [打开](https://hearthproject.github.io/hearth-os/delivery/) |
| 开发日志 | 每日概述、提交、具体修改与作者 | [打开](https://hearthproject.github.io/hearth-os/log/day-02.html) |
| 参考 | 边界、术语、清单、FAQ、贡献与完整归档 | [打开](https://hearthproject.github.io/hearth-os/reference/) |

## 交付全貌

产品路线图是总纲；开发计划把它拆成七个连续模块；每个模块包含 D 增量；每个增量再拆成四个实施工作包，并固定给出工程落点、接口、验收步骤和失败恢复。

| 阶段 | 模块 | 阶段出口 |
|---|---|---|
| Stage 0 | 定义与原型 | 可点击原型、稳定契约、真实任务与评测基线 |
| Stage 1 | 持久内核与 MVP | 本地每天可用的 MVP，包含真实 Codex 执行、审批、产物与恢复 |
| Stage 2 | Personal Operator | 连接器、文档/数据与浏览器闭环，写入需审批并产生回执 |
| Stage 3 | Computer Operator | 桌面观察、人工接管与按风险分级的 GUI 动作 |
| Stage 4 | 主动个人 Agent | Trigger、注意力预算、手机审批与随时暂停 |
| Stage 5 | 记忆与进化 | 可解释记忆、遗忘/导出、技能评估、晋升与回滚 |
| Stage 6 | 多设备与长期运行 | 同步、离线队列、设备撤销、备份迁移与长期审计 |

**MVP-1 是 Stage 1 的早期出口。** 它必须包含真实执行、持久任务、Web 任务卡、产物、审批演练和失败恢复，而不是后期阶段的演示。

## 本地运行

要求：Node.js 20 或更高版本、npm。

安装依赖并启动本地文档站：

```bash
npm ci
npm run docs:dev
```

构建并预览生产版本：

```bash
npm run docs:build
npm run docs:preview
```

构建结果写入 `docs/.vitepress/dist`，不要提交该目录。

## 仓库结构

```text
docs/                  正式文档的唯一来源，也是文档站的构建目录
  guide/               项目介绍、阅读指南与状态
  product/             产品定义、原则与任务覆盖
  architecture/        控制面、协议、执行器、安全与记忆
  delivery/            路线图、开发计划、Stage 模块、工程、风险与 ADR
  log/                 按日开发日志
  reference/           边界、术语、清单、FAQ、贡献与完整归档
  en/                  所有文档页面的英文镜像
  .vitepress/          站点配置与主题
scripts/               交付页生成脚本
README.md              英文仓库入口
README.zh-CN.md        中文仓库入口
package.json           文档构建脚本与依赖
```

## 文档规则

- **只有一个文档源：** 正式文档只放在 `docs/`，不要新增第二个文档根目录或归档目录。
- **只有一个站点：** 线上站点直接由 `docs/` 构建，不再单独维护同一份正文。
- **中英同构：** 每个中文页面都有路径、标题层级和结构一致的英文镜像。
- **归档也在站内：** 完整路线图是 `docs/reference/full-roadmap.md` 这个页面，不是另一棵文档树。
- **不提前标版本：** 文档不是产品发布；版本徽章和发版说明等到真正有可安装版本后再维护。
- **推送前先构建：** 运行 `npm run docs:build`，检查站内链接和中英结构后再提交。

## 参与贡献

Hearth 仍处于规格阶段。当前最有价值的贡献是澄清产品边界、补强协议、挑战风险假设、完善真实任务样本，以及让文档更容易被实现者使用。

- 先读[参与贡献与文档维护](https://hearthproject.github.io/hearth-os/reference/contributing.html)。
- 修改范围或阶段门槛前，先查阅[完整路线图归档](https://hearthproject.github.io/hearth-os/reference/full-roadmap.html)。
- 影响产品边界、架构不变量或交付出口的改动，请先通过 Issue 讨论。

## 许可证

Apache-2.0。见 [LICENSE](LICENSE)。
