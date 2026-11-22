#!/usr/bin/env node
/**
 * 单一版本真源（single source of truth for the Hearth version）。
 *
 * 根 package.json 的 "version" 是唯一权威。本脚本把其它所有版本声明对齐到它：
 *   - 每个 workspace package.json（apps/*、packages/*）的 "version" 与 "@hearth/*" 依赖声明
 *   - apps/desktop-tauri/src-tauri/Cargo.toml 的 [package] version
 *   - apps/desktop-tauri/src-tauri/tauri.conf.json 的 "version"
 *   - package-lock.json 的根/各 workspace 版本与 "@hearth/*" 依赖声明
 *
 * 用法：
 *   node scripts/sync-version.mjs            # 默认 check，发现漂移以退出码 1 失败
 *   node scripts/sync-version.mjs --check    # 同上
 *   node scripts/sync-version.mjs --write    # 把所有落点改写为与根 package.json 一致
 *
 * 只依赖 node 内置模块，可离线运行。
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const write = process.argv.slice(2).includes("--write");

const rootPkgPath = join(repoRoot, "package.json");
const lockPath = join(repoRoot, "package-lock.json");
const cargoPath = join(repoRoot, "apps", "desktop-tauri", "src-tauri", "Cargo.toml");
const tauriPath = join(repoRoot, "apps", "desktop-tauri", "src-tauri", "tauri.conf.json");

const DEP_SECTIONS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
const CARGO_REL = "apps/desktop-tauri/src-tauri/Cargo.toml";
const TAURI_REL = "apps/desktop-tauri/src-tauri/tauri.conf.json";

const rootVersion = JSON.parse(readFileSync(rootPkgPath, "utf8")).version;
if (!rootVersion) throw new Error("根 package.json 缺少 version");

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const writeJson = (p, v) => writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`, "utf8");

function listWorkspaces() {
  const out = [];
  for (const base of ["apps", "packages"]) {
    const dir = join(repoRoot, base);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const pkgPath = join(dir, name, "package.json");
      if (existsSync(pkgPath)) out.push({ base, name, pkgPath, rel: `${base}/${name}/package.json` });
    }
  }
  return out;
}

function hearthDepSpecs(pkg) {
  const out = [];
  for (const section of DEP_SECTIONS) {
    const deps = pkg[section];
    if (!deps) continue;
    for (const [name, spec] of Object.entries(deps)) {
      if (name.startsWith("@hearth/")) out.push({ section, name, spec });
    }
  }
  return out;
}

function cargoPackageVersion(text) {
  const m = text.match(/\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m);
  return m ? m[1] : null;
}

const workspaces = listWorkspaces();
const diffs = [];
const diff = (file, label, actual, expected) => {
  if (actual !== expected) diffs.push({ file, label, actual, expected });
};

// 收集所有漂移（只读，不写）
{
  const rootPkg = readJson(rootPkgPath);
  diff("package.json", 'version', rootPkg.version, rootVersion);

  for (const ws of workspaces) {
    const pkg = readJson(ws.pkgPath);
    diff(ws.rel, "version", pkg.version, rootVersion);
    for (const d of hearthDepSpecs(pkg)) {
      diff(ws.rel, `${d.section}["${d.name}"]`, d.spec, rootVersion);
    }
  }

  const cargoText = readFileSync(cargoPath, "utf8");
  diff(CARGO_REL, "[package].version", cargoPackageVersion(cargoText), rootVersion);

  const tauri = readJson(tauriPath);
  diff(TAURI_REL, "version", tauri.version, rootVersion);

  const lock = readJson(lockPath);
  diff("package-lock.json", 'version (top level)', lock.version, rootVersion);
  diff("package-lock.json", 'packages[""].version', lock.packages?.[""]?.version, rootVersion);
  for (const ws of workspaces) {
    const key = `${ws.base}/${ws.name}`;
    const entry = lock.packages?.[key];
    if (!entry) {
      diffs.push({ file: "package-lock.json", label: `packages["${key}"]`, actual: "<missing>", expected: rootVersion });
      continue;
    }
    diff("package-lock.json", `packages["${key}"].version`, entry.version, rootVersion);
    for (const section of DEP_SECTIONS) {
      const deps = entry[section];
      if (!deps) continue;
      for (const [name, spec] of Object.entries(deps)) {
        if (name.startsWith("@hearth/")) {
          diff("package-lock.json", `packages["${key}"].${section}["${name}"]`, spec, rootVersion);
        }
      }
    }
  }
}

if (!write) {
  if (diffs.length === 0) {
    console.log(`版本 ${rootVersion} 一致：${workspaces.length} 个 workspace + Cargo.toml + tauri.conf.json + package-lock.json`);
    process.exit(0);
  }
  console.error(`检测到版本漂移（根 package.json 为 ${rootVersion}）：`);
  for (const d of diffs) {
    console.error(`  - ${d.file} ${d.label}: 当前 ${JSON.stringify(d.actual)}，应为 ${JSON.stringify(d.expected)}`);
  }
  process.exit(1);
}

// 写入模式：按文件改写
let wroteFiles = 0;
for (const ws of workspaces) {
  const pkg = readJson(ws.pkgPath);
  let touched = false;
  if (pkg.version !== rootVersion) {
    pkg.version = rootVersion;
    touched = true;
  }
  for (const section of DEP_SECTIONS) {
    const deps = pkg[section];
    if (!deps) continue;
    for (const name of Object.keys(deps)) {
      if (name.startsWith("@hearth/") && deps[name] !== rootVersion) {
        deps[name] = rootVersion;
        touched = true;
      }
    }
  }
  if (touched) {
    writeJson(ws.pkgPath, pkg);
    wroteFiles += 1;
    console.log(`  改写 ${ws.rel}`);
  }
}

{
  const cargoText = readFileSync(cargoPath, "utf8");
  if (cargoPackageVersion(cargoText) !== rootVersion) {
    const next = cargoText.replace(/(\[package\][\s\S]*?^version\s*=\s*")[^"]+(")/m, `$1${rootVersion}$2`);
    writeFileSync(cargoPath, next, "utf8");
    wroteFiles += 1;
    console.log(`  改写 ${CARGO_REL}`);
  }
}

{
  const tauri = readJson(tauriPath);
  if (tauri.version !== rootVersion) {
    tauri.version = rootVersion;
    writeJson(tauriPath, tauri);
    wroteFiles += 1;
    console.log(`  改写 ${TAURI_REL}`);
  }
}

{
  const lock = readJson(lockPath);
  let touched = false;
  if (lock.version !== rootVersion) {
    lock.version = rootVersion;
    touched = true;
  }
  if (lock.packages?.[""] && lock.packages[""].version !== rootVersion) {
    lock.packages[""].version = rootVersion;
    touched = true;
  }
  for (const ws of workspaces) {
    const entry = lock.packages?.[`${ws.base}/${ws.name}`];
    if (!entry) continue;
    if (entry.version !== rootVersion) {
      entry.version = rootVersion;
      touched = true;
    }
    for (const section of DEP_SECTIONS) {
      const deps = entry[section];
      if (!deps) continue;
      for (const name of Object.keys(deps)) {
        if (name.startsWith("@hearth/") && deps[name] !== rootVersion) {
          deps[name] = rootVersion;
          touched = true;
        }
      }
    }
  }
  if (touched) {
    writeJson(lockPath, lock);
    wroteFiles += 1;
    console.log("  改写 package-lock.json");
  }
}

console.log(wroteFiles === 0 ? `版本 ${rootVersion} 已一致，无需改写` : `已同步 ${wroteFiles} 个文件到 ${rootVersion}`);
process.exit(0);