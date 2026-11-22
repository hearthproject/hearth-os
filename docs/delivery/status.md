---
title: "当前交付状态"
description: "2026-11-21 的代码、自动测试、构建和明确留空项。"
outline: [2, 3]
---

# 当前交付状态

核对日期：2026-11-21。本文只写当前 `main` 代码和本机能复现的事实，不把页面存在当成闭环，也不把历史计划当成现状。

> 阶段二至六的路线页是历史计划，部分描述已被当前范围收缩取代。当前范围以本文和[2026-11 验收报告](/delivery/acceptance-2026-11)为准。

## 这一版做了什么

- **可信执行：** 任务详情增加逐轮时间线，显示每轮改了哪些文件、增删行数、测试与诊断结果；支持一键回退，回退前校验文件是否被改动，默认拒绝覆盖用户手改。
- **默认不卡手：** 新增 `workspace` 审批模式。工作区内的可逆文件写入自动执行；shell、删除、邮件、桌面、陌生域名、支付/提交类浏览器动作仍需审批。
- **浏览器：** 独立 Chrome profile、多标签页、页面元素快照、点击/输入/按键/等待/上传/下载/断言/站点配方，浏览器任务完成前必须有通过的页面断言。动作前后截图和页面摘要进入证据目录。
- **项目档案与工作方式：** 每个项目可编译一页 `PROJECT.md`（栈、命令、约定、决策、未完成任务、坑），另有一页可编辑的 `WORKSTYLE.md`；两者只注入 coding 任务提示词，不进入普通聊天。
- **首次真实任务：** 首次启动可让当前模型改一个临时文件、跑一次测试并返回 diff；只有验证通过才标记完成，也可明确跳过并保留警告。
- **主动监督：** “需要你”收件箱只放长任务、等待审批、预算停止和失败任务；每天 08:00 后生成昨日回顾；22:00–08:00 不生成新通知。
- **自用报告：** `npm run dogfood:report` 从本地事件账本汇总完成率、一次通过率、审批、轮次、工具调用和 token；运行控制台显示同一组 7 天数字。
- **自动更新与发版：** Tauri updater 作为可选 feature；三项签名变量齐全时才生成签名更新产物和 `latest.json`，缺一就禁用自动更新。发布脚本生成安装包、便携 zip、发布说明和 SHA256 校验和。
- **工程门禁：** commitlint + husky 拒绝不合规提交；PR 模板要求测试、数据迁移、安全影响和回滚说明。

## 自动验证

| 项目 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npm run typecheck` | 通过 |
| 单元/集成测试 | `npm test` | 130 个文件、876 个用例（861 通过、15 跳过；7 个超时项单独复跑通过） |
| Web 构建 | `npm run build` | 通过（JS 723.79 kB / CSS 130.23 kB） |
| 文档构建 | `npm run docs:build` | 通过，无死链 |
| 浏览器 fixture | `npm run test:browser` | 12 项检查通过，18 个证据文件 |
| UI 端到端（离线） | `HEARTH_E2E_OFFLINE=1 npm run test:e2e` | 18 项通过，0 失败 |
| Tauri updater 编译 | `cargo check --manifest-path apps/desktop-tauri/src-tauri/Cargo.toml --features updater` | 通过 |
| Tauri 构建配置 | `npx tauri build --debug --no-bundle --features updater --config <overlay>` | 通过 |
| 0.3.3 安装包 | `npm run release:build` | NSIS 安装包，内置 server 启动并通过 `/api/ready`；以 GitHub Pre-release 发布 |
| 发布整理 | `npm run release:prepare -- --skip-build` | 便携 zip、安装包、发布说明、SHA256 校验和 |

> 说明：Windows 本地跑 `npm test` 时，worktrees/subagents 等真实 git 测试较慢，曾触发默认 10 秒 hook 超时；已将 `vitest.config.ts` 的 `hookTimeout` 调到 30 秒。上表为 CI 与本地一致口径。`0.2.0` 验收快照仍保留在 [2026-11 验收报告](/delivery/acceptance-2026-11)，作为历史记录不再改写。

## 仍然明确留空

- **真实模型首跑未验收：** 当前 `.hearth/model-settings.json` 的 key 调用 `deepseek-v4.1-flash-1017` 返回 `Access to model denied`。代码路径有 fake-runner 测试，但没有用可用模型完成一次真实首跑。这是外部凭据问题，不是测试通过就能替代的验收。
- **日常 Chrome 扩展桥未实现：** 目前使用独立 Chrome profile，首次需要在该 profile 里登录站点；没有“直接接管已登录默认 Chrome”的 MV3 扩展。Chrome 136+ 默认 profile 禁止远程调试，因此没有走默认 profile 的捷径。
- **签名更新未实际发布：** 仓库没有更新签名私钥、公钥和发布地址，自动更新只能在配置齐全的发布机器上启用；本机只验证了编译和禁用路径。
- **安装包未做干净机安装/卸载：** 0.3.2 NSIS 安装包已在开发机构建成功，打包后的服务端也通过启动检查；但未在全新 Windows 用户环境执行安装、SmartScreen、启动、卸载和旧版本升级。
- **真实账户未验收：** 飞书租户、SMTP/IMAP 账户、桌面设备仍只有代码和本地测试闭环，没有真实账户/设备的人工验收。
- **Windows 代码签名证书未知：** 没有 Authenticode 证书，安装包会触发 SmartScreen；本轮未处理。

## 已移出当前范围

- 任务模板系统；
- 主动服务、注意力预算、常驻意图和预置动作集群；
- Goal contract 与自动完成判定；
- 多设备同步、远程节点和执行器插件市场。

这些能力如重新引入，需要单独设计和验收，不能从历史文档直接推断为“已可用”。
