import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = join(repoRoot, "apps", "desktop", "resources", "server");

function collectDependencies() {
  const packages = [
    "apps/server/package.json",
    ...["agent-runtime", "codex-executor", "core", "deepseek-executor", "eventlog", "templates"].map(
      (name) => `packages/${name}/package.json`
    )
  ];
  const dependencies = new Map();
  for (const relative of packages) {
    const path = join(repoRoot, relative);
    if (!existsSync(path)) continue;
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
      if (name.startsWith("@hearth/")) continue;
      if (name.startsWith("@deepseek-ai/")) continue;
      if (name === "@openai/codex-win32-x64") continue;
      dependencies.set(name, version);
    }
  }
  return Object.fromEntries([...dependencies.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      windowsHide: true,
      shell: process.platform === "win32"
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
    });
  });
}

function packageSize(path) {
  if (!existsSync(path)) return null;
  return statSync(path).size;
}

const stage = mkdtempSync(join(tmpdir(), "hearth-server-deps-"));
try {
  const dependencies = collectDependencies();
  writeFileSync(join(stage, "package.json"), JSON.stringify({
    name: "hearth-server-runtime",
    private: true,
    dependencies
  }, null, 2), "utf8");

  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  await run(npm, [
    "install",
    "--omit=dev",
    "--omit=optional",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--loglevel=error"
  ], stage);

  const stageModules = join(stage, "node_modules");
  const required = join(stageModules, "@openai", "codex-sdk", "package.json");
  if (!existsSync(required)) throw new Error("staged dependencies are missing @openai/codex-sdk");
  if (existsSync(join(stageModules, "@openai", "codex-win32-x64"))) {
    throw new Error("staged dependencies unexpectedly include @openai/codex-win32-x64");
  }
  if (existsSync(join(stageModules, "@deepseek-ai"))) {
    throw new Error("staged dependencies unexpectedly include @deepseek-ai");
  }

  const target = join(outputRoot, "node_modules");
  rmSync(target, { recursive: true, force: true });
  mkdirSync(outputRoot, { recursive: true });
  cpSync(stageModules, target, { recursive: true });
  console.log(`staged node_modules: ${target}`);
  console.log(`codex-sdk: ${packageSize(join(stageModules, "@openai", "codex-sdk"))} bytes`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
