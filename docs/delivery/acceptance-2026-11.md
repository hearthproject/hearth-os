---
title: "2026-11 验收报告"
description: "Hearth 0.2.0 的测试矩阵、手动检查、未完成项和回退说明。"
outline: [2, 3]
---

# 2026-11 验收报告

日期：2026-11-20。目标版本：`0.2.0`。范围：把 Hearth 推进到可日常使用、可回退、可对外证明，并用自动测试和真实构建验证。

## 结论

**代码与自动验证完成；真实用户验收未全部完成。** 本轮新增的可信执行、浏览器、项目档案、首次任务验证、监督收件箱、自用报告、自动更新和发布脚本均已进入 `main`，782 个自动测试和 18 项离线 UI 端到端通过。真实模型首跑因当前 key 无权限失败，已签名更新和干净机安装未执行，因此不能宣称“装完就能用”已经对真实用户验收。

## 测试矩阵

| 项目 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npm run typecheck` | 0 error |
| 单元/集成 | `npm test` | 110 个文件、782 个用例全部通过 |
| Web 构建 | `npm run build` | 通过，JS 723.79 kB / CSS 130.23 kB |
| 文档构建 | `npm run docs:build` | 通过，无死链 |
| 浏览器 fixture | `npm run test:browser` | 12 项检查通过，18 个证据文件 |
| UI 端到端 | `HEARTH_E2E_OFFLINE=1 npm run test:e2e` | 18 项通过，0 失败 |
| Tauri updater 编译 | `cargo check --manifest-path apps/desktop-tauri/src-tauri/Cargo.toml --features updater` | 通过 |
| Tauri 配置构建 | `npx tauri build --debug --no-bundle --features updater --config <overlay>` | 通过 |
| 0.2.0 安装包 | `npm run release:build` | 通过；NSIS 安装包 30.5 MiB，内置 `server.mjs` 启动后 `/api/ready` 返回 200 |
| 发布整理 | `npm run release:prepare -- --skip-build` | 通过；安装包、123.2 MiB 便携 zip、发布说明和 SHA256 校验和 |

UI 端到端覆盖：首次向导跳过、聊天壳、会话操作、连接状态、导航、需要你收件箱、逐轮接口空状态与 rewind 错误、缺失模型首跑保护、IME、会话切换/删除、执行器设置、模型密钥遮罩、任务详情标签、窄视口和浏览器控制台错误。浏览器 fixture 覆盖打开/读取/输入/上传/危险点击拒绝/断言/配方/提交/下载/双标签/暂停恢复/完成门禁/证据文件。

## 手动检查

- **Chrome 真实启动：** 使用 `C:\Users\Jason\AppData\Local\Google\Chrome\Application\chrome.exe`，独立 profile 启动成功，标题 `Hearth smoke`，引擎 `chrome`。
- **发布产物：** `release/0.2.0/` 生成 30.5 MiB NSIS 安装包、123.2 MiB 便携 zip、`RELEASE_NOTES.md` 和 `SHA256SUMS.txt`；便携 zip 内保持 `Hearth.exe` 与 `resources/` 同级。用打包后的 `resources/server/server.mjs` 启动独立服务，`/api/ready` 返回 `{"ok":true,"name":"Hearth"}`；打包后的 ACL sandbox 包可以正常导入。
- **构建修复：** Playwright 的未声明 BiDi 依赖在打包时被替换为惰性桩，不影响 Chromium CDP 路径；sandbox 依赖改为扁平 `node_modules`，最长路径从 300+ 字符降到 167 字符，满足 makensis 限制。
- **自用报告：** 本机 30 天事件账本汇总 341 个任务、290 个完成、24 个失败或可恢复，成功率 92.4%，一次通过率与 token 汇总同时生成。该数据包含历史任务，只说明本机使用，不作为 v0.2 质量证明。
- **Tauri 签名禁用路径：** 三项签名变量不全时构建脚本打印警告并继续普通构建，不生成 `.sig` 或 `latest.json`。

## 未完成

| 项目 | 原因 | 影响 |
|---|---|---|
| 真实模型首跑 | 当前 key 调用 `deepseek-v4.1-flash-1017` 返回 `Access to model denied` | 首次任务验证代码有 fake-runner 测试，但没有可用模型的真实成功记录 |
| 日常 Chrome 扩展桥 | 本轮未实现 MV3 扩展；独立 profile 需要首次登录 | 不能直接接管用户默认 Chrome 的已登录会话 |
| 签名自动更新 | 缺少签名私钥、公钥和发布地址 | 只能发布手动更新包，不能验证旧版本自动升级 |
| 干净机安装/卸载 | 未准备全新 Windows 用户环境 | 安装器行为、SmartScreen、卸载残留未验收 |
| 真实账户/设备 | 没有飞书租户、SMTP/IMAP 账户和配对设备 | 相关能力只有本地测试闭环 |
| Windows 代码签名 | 没有 Authenticode 证书 | 安装包会触发 SmartScreen 警告 |

## 回退

- 代码回退：`git revert <commit>`；本轮按闭环拆分提交，可按功能单独回退。
- 任务文件回退：任务详情逐轮时间线点“回退”，默认拒绝覆盖用户手改；需要强制时使用 `force` 并留事件。
- 数据库：升级前按设置页“数据与备份”创建加密备份；恢复是回滚式事务，失败不留下半恢复状态。
- 发布：删除 `release/<version>/` 和对应上传文件；自动更新回退需要发布一个更高版本，不能把客户端降到旧版。

## 引用

- 当前能力与留空项：[当前交付状态](/delivery/status)
- 浏览器设计与边界：[浏览器自动化](/design/browser)
- 日常使用与自用报告：[日常使用](/reference/daily-use)
- 发版流程：[构建、签名与发版](/reference/releasing)
- 历史 Native 30 题评测：[评测与结果](/evaluation/)
