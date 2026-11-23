# 构建、签名与发版

桌面版是 Tauri 应用，服务端、Web 产物和原生沙箱 helper 随安装包一起分发。发布分三步：构建、签名、整理产物。当前 0.3.4 只完成构建与整理，自动更新签名仍未配置。

## 1. 构建

```bash
npm run release:build
```

`scripts/build-tauri.mjs` 会编译 `apps/native/hearth-native.cs`（调用系统 `csc.exe`），准备内置 Node、服务端 bundle 和 Web 产物，再调用 `tauri build`，最终把 NSIS 安装包复制到仓库根目录的 `release/`。

没有签名环境变量时，脚本会打印一条警告并生成**不带自动更新**的普通安装包。它不会生成一个签名无效、装上就无法更新的坏包。

0.3.4 的实际产物：`Hearth_0.3.4_x64-setup.exe` 30.5 MiB、`Hearth-0.3.4-portable.zip` 47.2 MiB，已作为 GitHub Pre-release 发布并附 SHA256 校验和。

## 2. 自动更新签名

自动更新需要三项一起提供：

| 变量 | 用途 |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | 给更新产物签名；可以是文件路径或密钥内容 |
| `HEARTH_UPDATER_PUBKEY` | 客户端内置的公钥，用来验证更新 |
| `HEARTH_UPDATER_ENDPOINT` | 客户端检查更新的 `latest.json` 地址 |

三项齐全时，构建脚本会生成临时 `src-tauri/updater.build.json`，打开 `createUpdaterArtifacts` 并启用 `updater` Cargo feature，然后产出 `.sig` 文件。三项缺一，自动更新关闭。

私钥只放在发布机器或 CI secret 中，不进入仓库。公钥可以公开。

## 3. 整理发布产物

```bash
npm run release:prepare
# 或使用已有安装包，不重新构建
npm run release:prepare -- --skip-build
```

脚本会在 `release/<version>/` 生成：

- `Hearth_<version>_x64-setup.exe`：Windows 安装包；
- `Hearth-<version>-portable.zip`：解压后保持 `resources/` 与 `Hearth.exe` 同级，直接运行；
- `RELEASE_NOTES.md`：版本、提交列表、安装说明；
- `SHA256SUMS.txt`：安装包、便携包和发布说明的校验和；
- `latest.json`（可选）：设置 `HEARTH_RELEASE_BASE_URL` 且有 `.sig` 时生成，供 Tauri updater 使用。

`latest.json` 里的下载地址由 `HEARTH_RELEASE_BASE_URL` 加安装包文件名拼成，所以要把安装包和 `latest.json` 上传到同一版本目录。

## 发布前检查

- `npm run version:check && npm run typecheck && npm test && npm run test:longrun && npm run build && npm run docs:build`
- `npm run test:sandbox`（Windows 真实 AppContainer 测试）
- `npm run first:run -- --fake`（离线自检任务链路）
- `cargo check --manifest-path apps/desktop-tauri/src-tauri/Cargo.toml --features updater`
- 安装包在干净机器上安装、启动、卸载各一次；
- 下载后核对 `SHA256SUMS.txt`；
- 至少在一台旧版本机器上验证一次自动更新。

发布脚本不会自动打 tag、推远端或上传文件。这些步骤需要人确认后执行。

## 当前缺口

0.3.4 没有 `TAURI_SIGNING_PRIVATE_KEY`、`HEARTH_UPDATER_PUBKEY` 和 `HEARTH_UPDATER_ENDPOINT`，所以不会生成 `.sig` 或 `latest.json`，客户端也没有可用的更新源。Windows Authenticode、干净机卸载重装和企业策略检查同样未验收；发布前检查中的后三项仍是人工留空项。
