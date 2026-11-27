import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const tauriRoot = join(repoRoot, "apps", "desktop-tauri");
const resources = join(tauriRoot, "src-tauri", "resources");
const cacheRoot = join(tauriRoot, ".cache");
const cargoBin = process.env.HEARTH_CARGO_BIN?.trim() || "";
const NODE_VERSION = "v22.23.2";
const NODE_ZIP = `node-${NODE_VERSION}-win-x64.zip`;
const NODE_URL = `https://nodejs.org/dist/${NODE_VERSION}/${NODE_ZIP}`;
const NODE_SHA = "1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97";

function run(command, args, cwd = repoRoot) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      windowsHide: true,
      shell: process.platform === "win32",
      env: {
        ...process.env,
        PATH: [
          ...(cargoBin ? [cargoBin] : []),
          process.env.PATH ?? ""
        ].join(";")
      }
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
    });
  });
}

function copyTree(source, target) {
  if (!existsSync(source)) throw new Error(`missing build output: ${source}`);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true });
}

function sizeOf(path) {
  if (!existsSync(path)) return 0;
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.size;
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    total += entry.isDirectory() ? sizeOf(child) : statSync(child).size;
  }
  return total;
}

async function ensurePinnedNode() {
  const override = process.env.HEARTH_NODE_PATH;
  if (override) {
    if (!existsSync(override)) throw new Error(`HEARTH_NODE_PATH does not exist: ${override}`);
    const version = (await runCapture(override, ["-v"])).trim();
    if (!version.startsWith("v22.")) throw new Error(`HEARTH_NODE_PATH must be official Node v22.x, got ${version}`);
    return { nodeExe: override, npmRoot: join(dirname(override), "node_modules", "npm"), version, license: null };
  }

  const extracted = join(cacheRoot, `node-${NODE_VERSION}-win-x64`);
  const nodeExe = join(extracted, "node.exe");
  const npmRoot = join(extracted, "node_modules", "npm");
  const license = join(extracted, "LICENSE");
  if (existsSync(nodeExe) && existsSync(join(npmRoot, "bin", "npm-cli.js"))) {
    const version = (await runCapture(nodeExe, ["-v"])).trim();
    if (version === NODE_VERSION) return { nodeExe, npmRoot, version, license };
  }

  mkdirSync(cacheRoot, { recursive: true });
  const zipPath = join(cacheRoot, NODE_ZIP);
  if (!existsSync(zipPath)) {
    console.log(`downloading ${NODE_URL}`);
    const response = await fetch(NODE_URL);
    if (!response.ok) throw new Error(`node download failed: HTTP ${response.status}`);
    writeFileSync(zipPath, Buffer.from(await response.arrayBuffer()));
  }
  const actual = createHash("sha256").update(readFileSync(zipPath)).digest("hex");
  if (actual !== NODE_SHA) throw new Error(`node zip checksum mismatch: ${actual}`);

  rmSync(extracted, { recursive: true, force: true });
  await run("tar", ["-xf", zipPath, "-C", cacheRoot]);
  if (!existsSync(nodeExe)) throw new Error(`node extraction failed: ${nodeExe}`);
  const version = (await runCapture(nodeExe, ["-v"])).trim();
  if (version !== NODE_VERSION) throw new Error(`unexpected node version: ${version}`);
  return { nodeExe, npmRoot, version, license };
}

function runCapture(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let output = "";
    let error = "";
    child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk) => { error += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(`${command} ${args.join(" ")} exited with ${code}: ${error}`));
    });
  });
}

function pruneNpm(root) {
  const keep = (name) => /^(license|licence|copying|notice)/i.test(name);
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "docs" || entry.name === "man") {
          rmSync(path, { recursive: true, force: true });
          continue;
        }
        walk(path);
        continue;
      }
      if (!keep(entry.name) && (entry.name.endsWith(".md") || entry.name.endsWith(".map"))) {
        rmSync(path, { force: true });
      }
    }
  };
  walk(root);
}

async function main() {
  await run("npm", ["run", "build", "-w", "@hearth/web"]);
  await run("node", ["scripts/build-server.mjs"]);

  const webResources = join(resources, "web");
  rmSync(webResources, { recursive: true, force: true });
  copyTree(join(repoRoot, "apps", "web", "dist"), webResources);

  const node = await ensurePinnedNode();
  copyTree(node.nodeExe, join(resources, "node.exe"));
  rmSync(join(resources, "node_modules"), { recursive: true, force: true });
  mkdirSync(join(resources, "node_modules"), { recursive: true });
  copyTree(node.npmRoot, join(resources, "node_modules", "npm"));
  pruneNpm(join(resources, "node_modules", "npm"));
  if (node.license) {
    mkdirSync(join(resources, "licenses"), { recursive: true });
    cpSync(node.license, join(resources, "licenses", "node-LICENSE.txt"));
  }

  writeFileSync(join(resources, "npm.cmd"), [
    "@echo off",
    "setlocal",
    '"%~dp0node.exe" "%~dp0node_modules\\npm\\bin\\npm-cli.js" %*',
    ""
  ].join("\r\n"), "utf8");

  const helperSource = join(repoRoot, "tools", "windows-helper");
  const helperTarget = join(resources, "helper");
  rmSync(helperTarget, { recursive: true, force: true });
  mkdirSync(helperTarget, { recursive: true });
  cpSync(join(helperSource, "helper.mjs"), join(helperTarget, "helper.mjs"));
  cpSync(join(helperSource, "windows.ps1"), join(helperTarget, "windows.ps1"));
  writeFileSync(join(helperTarget, "helper.cmd"), [
    "@echo off",
    "setlocal",
    '"%~dp0..\\node.exe" "%~dp0helper.mjs" %*',
    "pause",
    ""
  ].join("\r\n"), "utf8");

  const npmVersion = (await runCapture(node.nodeExe, [join(resources, "node_modules", "npm", "bin", "npm-cli.js"), "--version"])).trim();
  if (npmVersion !== "10.9.8") throw new Error(`unexpected npm version: ${npmVersion}`);

  console.log(`node ${node.version}; npm ${npmVersion}`);
  console.log(`resources: ${(sizeOf(resources) / 1048576).toFixed(1)} MiB`);

  const updaterReady = Boolean(
    process.env.TAURI_SIGNING_PRIVATE_KEY
    && process.env.HEARTH_UPDATER_PUBKEY
    && process.env.HEARTH_UPDATER_ENDPOINT
  );
  const versionOverride = process.env.HEARTH_BUILD_VERSION?.trim();
  const tauriConfig = JSON.parse(readFileSync(join(tauriRoot, "src-tauri", "tauri.conf.json"), "utf8"));
  const tauriVersion = versionOverride || tauriConfig.version;
  const targetRelease = process.env.CARGO_TARGET_DIR
    ? join(process.env.CARGO_TARGET_DIR, "release")
    : join(tauriRoot, "src-tauri", "target", "release");
  const stagedResources = join(targetRelease, "resources");
  if (existsSync(stagedResources)) {
    rmSync(stagedResources, { recursive: true, force: true });
    console.log("cleared stale staged resources");
  }
  const tauriArgs = ["build"];
  const overlay = {};
  if (versionOverride) overlay.version = versionOverride;
  if (updaterReady) {
    overlay.bundle = { createUpdaterArtifacts: true };
    overlay.plugins = {
      updater: {
        pubkey: process.env.HEARTH_UPDATER_PUBKEY,
        endpoints: [process.env.HEARTH_UPDATER_ENDPOINT]
      }
    };
    console.log("updater: signed build enabled");
  } else {
    console.warn("updater: disabled because TAURI_SIGNING_PRIVATE_KEY, HEARTH_UPDATER_PUBKEY or HEARTH_UPDATER_ENDPOINT is missing");
  }
  if (Object.keys(overlay).length > 0) {
    const overlayPath = join(tauriRoot, "src-tauri", "build-overrides.json");
    writeFileSync(overlayPath, JSON.stringify(overlay, null, 2), "utf8");
    tauriArgs.push("--config", overlayPath);
    if (updaterReady) tauriArgs.push("--features", "updater");
  }
  if (versionOverride) console.log(`version override: ${tauriVersion}`);

  await run(join(repoRoot, "node_modules", ".bin", "tauri.cmd"), tauriArgs, tauriRoot);

  const bundleDir = join(targetRelease, "bundle", "nsis");
  if (existsSync(bundleDir)) {
    const releaseDir = join(repoRoot, "release");
    mkdirSync(releaseDir, { recursive: true });
    for (const name of readdirSync(bundleDir).filter((entry) => entry === `Hearth_${tauriVersion}_x64-setup.exe`)) {
      copyFileSync(join(bundleDir, name), join(releaseDir, name));
      console.log(`installer: ${join(releaseDir, name)}`);
    }
  }
  console.log(`staged Tauri resources: ${resources}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
