import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const desktopRoot = join(repoRoot, "apps", "desktop");
const webDist = join(repoRoot, "apps", "web", "dist");
const resourcesWeb = join(desktopRoot, "resources", "web");

process.env.ELECTRON_MIRROR ??= "https://npmmirror.com/mirrors/electron/";
process.env.ELECTRON_BUILDER_BINARIES_MIRROR ??= "https://npmmirror.com/mirrors/electron-builder-binaries/";

function run(command, args, cwd = repoRoot) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      windowsHide: true,
      shell: process.platform === "win32" && /\.cmd$/i.test(command)
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
    });
  });
}

await run(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build", "-w", "@hearth/web"]);
await run(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "desktop:build:shell"]);
await run(process.execPath, [join(repoRoot, "scripts", "make-icon.mjs")]);
await run(process.execPath, [join(repoRoot, "scripts", "build-server.mjs")]);
await run(process.execPath, [join(repoRoot, "scripts", "stage-server-deps.mjs")]);

if (!existsSync(join(webDist, "index.html"))) throw new Error(`missing web build: ${join(webDist, "index.html")}`);
rmSync(resourcesWeb, { recursive: true, force: true });
mkdirSync(resourcesWeb, { recursive: true });
cpSync(webDist, resourcesWeb, { recursive: true });

const builder = join(
  repoRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "electron-builder.cmd" : "electron-builder"
);
if (!existsSync(builder)) throw new Error("electron-builder is not installed; run npm install");

await run(builder, process.argv.includes("--dir") ? ["--dir"] : [], desktopRoot);
console.log(process.argv.includes("--dir")
  ? `win-unpacked: ${join(repoRoot, "release", "win-unpacked")}`
  : `artifacts: ${join(repoRoot, "release")}`);
