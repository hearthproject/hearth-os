<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/public/brand/hearth-os-logo-reverse.png">
    <source media="(prefers-color-scheme: light)" srcset="docs/public/brand/hearth-os-logo.png">
    <img src="docs/public/brand/hearth-os-logo.png" alt="Hearth OS" width="420">
  </picture>
</p>

**单用户、自托管，把数字劳动变成持久、可审计、可恢复的任务。**

[English](README.md) | [简体中文](README.zh-CN.md)

[![文档](https://img.shields.io/badge/%E6%96%87%E6%A1%A3-%E4%B8%AD%E6%96%87%20%7C%20English-b8471d)](https://hearthproject.github.io/hearth-os/)
[![状态](https://img.shields.io/badge/%E7%8A%B6%E6%80%81-%E7%AC%AC%E4%B8%80%E9%98%B6%E6%AE%B5%20MVP-b8471d)](#项目状态)
[![许可](https://img.shields.io/badge/license-Apache--2.0-1b1815)](LICENSE)

Hearth 把用户意图变成持久、可审计、可恢复的任务。它协调 Codex、连接器、浏览器和桌面代理等专用执行器，并让所有外部副作用都经过明确审批、幂等检查和可验证回执。

它不是另一个编码代理或聊天壳，而是面向长期个人数字工作的任务控制面：用户看到任务和结果，系统负责状态、权限、证据、预算和失败恢复。

## 文档

完整文档发布在 **<https://hearthproject.github.io/hearth-os/>**。中文是默认语言，每个页面都有对应的英文版本。

- [设计说明](https://hearthproject.github.io/hearth-os/design/)——项目定位、总体设计、技术选型与九个模块的设计取舍。
- [交付路线与实施计划](https://hearthproject.github.io/hearth-os/delivery/)——六个阶段、24 个小阶段与 MVP 位置。
- [开发日志](https://hearthproject.github.io/hearth-os/log/day-03.html)——每天一段概述，加上提交、具体修改和作者。
- [附录](https://hearthproject.github.io/hearth-os/reference/)——工程、风险、决策、自研边界、术语、清单与维护资料。

## 项目状态

Hearth 已进入**第一阶段（MVP）实现**。仓库现在包含可运行的本机控制面（TypeScript + React）、原生 Codex 执行器适配、只追加的 SQLite 事件日志、审批门控的外部动作，以及 15 个真实任务评测集。第一阶段的出口是至少 10 个任务通过验收；逐项证据和验收报告见 `eval/phase-1-acceptance.md`。

## 仓库结构

```text
apps/                  可运行的本机控制面
  server/              Fastify API、调度器、审批、工作区与产物
  web/                 任务、审批、产物与设置界面
packages/              共享核心、事件日志、任务模板与 Codex 执行器
eval/                  15 个真实任务、输入、验收标准和运行记录
docs/                  正式文档的唯一来源，也是 VitePress 构建目录
  design/              项目总体设计、技术选型与九个模块的设计取舍
  delivery/            交付路线与六个阶段实施计划
  log/                 按日开发日志
  reference/           附录：工程、风险、决策与维护资料
  en/                  所有中文页面的英文镜像
  .vitepress/          站点配置与主题
scripts/               交付页生成辅助脚本
```

## 本地运行

要求 Node.js 22.13 或更高版本（服务端使用内置的 `node:sqlite` 模块），以及 npm。

### 启动 Hearth

```bash
npm ci
npm run dev
```

打开 <http://127.0.0.1:5173>。Vite 开发服务器会把 `/api` 代理到本机 `127.0.0.1:4317` 服务。

以生产模式在本机运行：

```bash
npm run build
npm start
```

打开 <http://127.0.0.1:4317>。

### 不登录 Codex，使用自己的模型

Hearth 通过 Codex SDK 调用执行器，会读取你现有的 `~/.codex/config.toml`。只要配置了 `model_provider` 和对应的 `env_key`，就不需要 `codex login`；密钥只需要存在于启动 Hearth 的终端环境中。设置页会显示当前 Provider、模型和认证来源，密钥不会进入浏览器。

### 数据、备份与停止

- `.hearth/hearth.sqlite` 保存任务、运行、审批、外部动作和事件。
- `.hearth/workspaces/` 保存隔离的任务工作区。
- `eval/runs/` 保存已验收的任务产物。
- 侧栏提供全局停止/恢复开关；停止会把正在执行的运行转入可恢复状态，同时保留队列和审批。
- 设置页可以下载一致的 SQLite 备份，并把全部任务记录导出为 JSON。完整归档还需一并复制 `eval/runs/` 与 `.hearth/artifacts/`。

### 构建文档站

```bash
npm run docs:dev
```

构建并预览生产版本：

```bash
npm run docs:build
npm run docs:preview
```

构建结果写入 `docs/.vitepress/dist`，不要提交该目录。

## 参与贡献

Hearth 仍处于规格阶段。当前最有价值的贡献是澄清产品边界、补强协议、挑战风险假设、完善真实任务样本，以及让文档更容易被实现者使用。

- 先读[参与贡献与文档维护](https://hearthproject.github.io/hearth-os/reference/contributing.html)。
- 修改范围或阶段目标前，先阅读[交付路线](https://hearthproject.github.io/hearth-os/delivery/)。
- 影响产品边界、设计不变量或交付出口的改动，请先通过 Issue 讨论。

## 许可证

Apache-2.0。见 [LICENSE](LICENSE)。
