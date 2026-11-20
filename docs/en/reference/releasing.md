# Build, Sign and Release

The desktop app is a Tauri application; the server and web bundle ship with the installer. A release has three steps: build, sign, stage.

## 1. Build

```bash
npm run release:build
```

`scripts/build-tauri.mjs` prepares the bundled Node runtime, server bundle and web assets, then calls `tauri build` and copies the NSIS installer into `release/` at the repository root.

When signing variables are absent the script warns and produces a normal installer **without auto-update**. It does not create an installer that looks signed but cannot update.

## 2. Updater signing

Auto-update requires all three:

| Variable | Purpose |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | Signs updater artifacts; a file path or the key itself |
| `HEARTH_UPDATER_PUBKEY` | Public key embedded in the client |
| `HEARTH_UPDATER_ENDPOINT` | `latest.json` endpoint the client checks |

With all three, the build script writes a temporary `src-tauri/updater.build.json`, enables `createUpdaterArtifacts` and the `updater` Cargo feature, and produces a `.sig` file. With any missing, auto-update stays off.

Keep the private key on the release machine or in CI secrets, never in the repository. The public key is safe to publish.

## 3. Stage release artifacts

```bash
npm run release:prepare
# or reuse an existing installer without rebuilding
npm run release:prepare -- --skip-build
```

The script writes into `release/<version>/`:

- `Hearth_<version>_x64-setup.exe`: the Windows installer;
- `Hearth-<version>-portable.zip`: extract, keep `resources/` beside `Hearth.exe`, run;
- `RELEASE_NOTES.md`: version, commit list and install notes;
- `SHA256SUMS.txt`: checksums for the installer, portable archive and notes;
- `latest.json` (optional): generated when `HEARTH_RELEASE_BASE_URL` and a `.sig` file exist.

The download URL in `latest.json` is `HEARTH_RELEASE_BASE_URL` plus the installer filename, so upload both to the same version directory.

## Before publishing

- `npm run typecheck && npm test && npm run build && npm run docs:build`
- `cargo check --manifest-path apps/desktop-tauri/src-tauri/Cargo.toml --features updater`
- install, launch and uninstall once on a clean machine;
- verify downloads against `SHA256SUMS.txt`;
- verify one auto-update from an older build.

The release script never tags, pushes or uploads by itself. Those steps need a human decision.
