---
title: "当前交付状态"
description: "2026-11-23 的代码、自动测试、构建和明确留空项。"
outline: [2, 3]
---

# 当前交付状态

核对日期：2026-11-23，目标版本 `0.3.4`。本文只写当前 `main` 代码和本机能复现的事实，不把页面存在当成闭环，也不把历史计划当成现状。

> 阶段二至六的路线页是历史计划，部分描述已被当前范围收缩取代。当前范围以本文和[2026-11 验收报告](/delivery/acceptance-2026-11)为准。

## 这一版做了什么

- **运行时稳定：** 工具副作用拆成业务结算与物理清理两条账；`settled` 不再等于“已经清干净”，终态 run 会真正终止已登记的 shell 进程并把 `confirmed / failed` 写回 `run_operations`。恢复闸门沿父 run 链检查 prepared/dispatched 操作、运行中后台进程和 checkpoint proof，未知副作用不再自动重放。
- **单一事实源：** 服务端不再写 JSONL journal，消息、工具结算、检查点和 run 边界统一写入 SQLite `events`（schema v40）；checkpoint 文件降级为物化视图，损坏时从事件按 `event_seq` 回放重建。
- **宿主生命周期：** `HostKernel` 持有数据目录的唯一租约，按 `lease → store → operations → runs → tasks → background → ready` 推进；恢复完成前 `/api/ready` 返回 503，任务写路由返回 `HOST_NOT_READY`。
- **Windows 原生沙箱：** `hearth-native.exe` 用 AppContainer package SID、workspace/temp ACL、kill-on-close Job Object 和父进程 watchdog 启动子进程；网络只支持 `deny | open`，声明域名白名单或 helper 缺失时 fail-closed。
- **交互式 shell 与后台进程：** `shell` 支持 `pty: true` 与 `cols` / `rows`，经 ConPTY 在 AppContainer 内运行；`shell_input` / `shell_resize` 可输入与调整；每个会话写入 SQLite `background_processes`，重启时按 PID + 创建时间判定，活的杀进程树、复用的只标 `lost`。
- **证据与回收：** 每个终态 run 输出 `run-evidence.json`；长跑矩阵从 12 扩到 18 个崩溃点，各重复 3 次；新增 `npm run storage:prune` 预演式回收旧 run 与未引用工具输出。
- **界面收缩：** 任务列表、任务详情和“需要你”收件箱页面已下线，执行轨迹改为对话内联运行卡；主导航为聊天、资料库、Context，邮件/定时任务/连接收在“更多”。

## 自动验证

| 项目 | 命令 | 结果 |
|---|---|---|
| 版本一致 | `npm run version:check` | 0.3.4：7 个 workspace + Cargo + Tauri + lockfile |
| 类型检查 | `npm run typecheck` | 0 错误 |
| 单元/集成测试 | `npm test` | 140 个文件、946 个用例（931 通过、15 跳过、0 失败） |
| 长跑矩阵 | `npm run test:longrun` | 18/18 通过 |
| Web 构建 | `npm run build` | 通过（JS 643.06 kB / CSS 158.97 kB） |
| 文档构建 | `npm run docs:build` | 通过，无死链 |
| 首跑离线自检 | `npm run first:run -- --fake` | 通过（只验证脚本与任务链路，不代表模型可用） |
| 0.3.4 安装包 | `npm run release:build` | NSIS 安装包 30.5 MiB、便携 zip 47.2 MiB；以 GitHub Pre-release 发布 |
| Windows 沙箱 | `npm run test:sandbox` | 12 项真实测试：越界写、只读、junction 逃逸、密钥过滤、网络拒绝、PTY 与 Job 关闭 |

> 说明：Windows 本地跑 `npm test` 时，worktrees/subagents/沙箱等真实进程测试较慢；`vitest.config.ts` 将单测超时设为 20 秒、hook 超时设为 30 秒。上表为 2026-11-23 在本机 `main` 工作树上实际复跑的结果。0.2.0 与 0.3.3 的验收快照仍保留在 [2026-11 验收报告](/delivery/acceptance-2026-11)，作为历史记录不再改写。

## 仍然明确留空

- **自动更新签名未发布：** 仓库没有更新签名私钥、公钥和发布地址；0.3.4 安装包不包含自动更新产物。
- **Windows 代码签名未处理：** 没有 Authenticode 证书，安装包首次运行可能触发 SmartScreen。
- **干净机安装/卸载未验收：** 0.3.4 已在开发机完成安装包全新安装与启动验证，但未在全新 Windows 用户环境执行卸载、旧版本升级和企业策略检查。
- **真实模型首跑未验收：** 仍取决于本机模型配置和供应商权限；没有可用 key 时只能用 `first:run --fake` 验证脚本自身。
- **日常 Chrome 扩展桥未实现：** 目前使用独立 Chrome profile，首次需要在该 profile 里登录站点；Chrome 136+ 默认 profile 禁止远程调试。
- **真实账户未验收：** 飞书租户、SMTP/IMAP 账户、桌面设备仍只有代码和本地测试闭环。
- **长期崩溃恢复未做真实演练：** 18 个崩溃点由自动化长跑矩阵覆盖，但没有数周真实使用中的断电、蓝屏和强制结束进程记录。
- **清理覆盖面有限：** cleanup 目前对已登记 shell 进程执行真实终止；subagent/worktree/browser 等资源暂无清理 handler 时会明确记 `failed` 并留下原因。

## 已移出当前范围

- 任务列表、任务详情和“需要你”收件箱页面；
- 任务模板系统；
- 主动服务、注意力预算、常驻意图和预置动作集群；
- Goal contract 与自动完成判定；
- 方法学习与任务绑定；
- 多设备同步、远程节点和执行器插件市场。

这些能力如重新引入，需要单独设计和验收，不能从历史文档直接推断为“已可用”。
