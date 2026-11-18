import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const tauriRoot = join(repoRoot, "apps", "desktop-tauri");
const resources = join(tauriRoot, "src-tauri", "resources");
const desktopResources = join(repoRoot, "apps", "desktop", "resources");

function run(command, args, cwd = repoRoot) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      windowsHide: true,
      shell: process.platform === "win32",
      env: {
        ...process.env,
        CARGO_HOME: process.env.CARGO_HOME ?? "D:\\DevTools\\.cargo",
        RUSTUP_HOME: process.env.RUSTUP_HOME ?? "D:\\DevTools\\.rustup",
        PATH: [
          "D:\\DevTools\\.cargo\\bin",
          "C:\\Program Files (x86)\\Microsoft Visual Studio\\18\\BuildTools\\VC\\Tools\\MSVC\\14.51.36231\\bin\\Hostx64\\x64",
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

await run("npm", ["run", "build", "-w", "@hearth/web"]);
await run("node", ["scripts/build-server.mjs"]);
await run("node", ["scripts/stage-server-deps.mjs"]);

copyTree(join(desktopResources, "server"), join(resources, "server"));
copyTree(join(repoRoot, "apps", "web", "dist"), join(resources, "web"));

const nodeExe = process.env.HEARTH_NODE_PATH ?? process.execPath;
if (!existsSync(nodeExe)) throw new Error(`missing node runtime: ${nodeExe}`);
copyTree(nodeExe, join(resources, "node.exe"));

const npmRoot = [
  join(dirname(nodeExe), "node_modules", "npm"),
  "C:\\Program Files\\nodejs\\node_modules\\npm"
].find((path) => existsSync(join(path, "bin", "npm-cli.js")));
if (!npmRoot) throw new Error("missing npm runtime next to node.exe; managed executor installs would fail");
copyTree(npmRoot, join(resources, "node_modules", "npm"));

function pruneServerResources(serverRoot) {
  const modules = join(serverRoot, "node_modules");
  const removable = [
    join(modules, "@types"),
    join(modules, "pdfjs-dist", "build"),
    join(modules, "pdfjs-dist", "web"),
    join(modules, "pdfjs-dist", "image_decoders")
  ];
  for (const path of removable) {
    rmSync(path, { recursive: true, force: true });
  }
}
pruneServerResources(join(resources, "server"));

if (existsSync(join(desktopResources, "helper"))) {
  copyTree(join(desktopResources, "helper"), join(resources, "helper"));
}

console.log("staged Tauri resources:", resources);
await run(join(repoRoot, "node_modules", ".bin", "tauri.cmd"), ["build"], tauriRoot);
