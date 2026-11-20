import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = join(repoRoot, "apps", "desktop-tauri", "src-tauri", "resources", "server");
const resourcesRoot = join(repoRoot, "apps", "desktop-tauri", "src-tauri", "resources");

rmSync(outputRoot, { recursive: true, force: true });
mkdirSync(outputRoot, { recursive: true });

const result = await build({
  entryPoints: [join(repoRoot, "apps", "server", "src", "index.ts")],
  outfile: join(outputRoot, "server.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  minify: true,
  external: ["@openai/codex-win32-x64"],
  legalComments: "none",
  metafile: true,
  banner: {
    js: 'import { createRequire as __hearthCreateRequire } from "node:module"; const require = __hearthCreateRequire(import.meta.url);'
  },
  logLevel: "info"
});

const pdfjsRoot = join(repoRoot, "node_modules", "pdfjs-dist");
const workerSource = join(pdfjsRoot, "legacy", "build", "pdf.worker.min.mjs");
if (!existsSync(workerSource)) throw new Error(`missing pdf worker: ${workerSource}`);
cpSync(workerSource, join(outputRoot, "pdf.worker.mjs"));

const pdfjsAssets = join(outputRoot, "assets", "pdfjs");
for (const name of ["cmaps", "standard_fonts", "wasm"]) {
  const source = join(pdfjsRoot, name);
  if (!existsSync(source)) throw new Error(`missing pdfjs asset directory: ${source}`);
  cpSync(source, join(pdfjsAssets, name), { recursive: true });
}

const sandboxRoot = join(resourcesRoot, "sandbox", "windows-acl");
const sandboxPackageRoot = join(repoRoot, "node_modules", "@deepseek-ai", "dsh-sandbox-windows-acl");
if (existsSync(sandboxPackageRoot)) {
  rmSync(sandboxRoot, { recursive: true, force: true });
  copyPackageTree("@deepseek-ai/dsh-sandbox-windows-acl", sandboxRoot, new Set());
} else {
  console.warn(`windows ACL runner package is not installed; packaged shell tasks will fail closed (${sandboxPackageRoot})`);
}

function copyPackageTree(name, target, seen) {
  const source = join(repoRoot, "node_modules", name);
  if (!existsSync(source) || seen.has(name)) return;
  seen.add(name);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true });
  const manifest = readJson(join(source, "package.json"));
  const dependencies = {
    ...(manifest?.dependencies ?? {}),
    ...(manifest?.optionalDependencies ?? {}),
    ...(manifest?.peerDependencies ?? {})
  };
  for (const dependency of Object.keys(dependencies)) {
    if (dependency.startsWith("@hearth/") || dependency === "hearth") continue;
    copyPackageTree(dependency, join(target, "node_modules", dependency), seen);
  }
  seen.delete(name);
}

function findPackageRoot(file) {
  let current = dirname(join(repoRoot, file));
  while (true) {
    const manifest = join(current, "package.json");
    if (existsSync(manifest)) return current;
    const parent = dirname(current);
    if (parent === current || !current.startsWith(repoRoot)) return null;
    current = parent;
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function licenseText(root) {
  for (const name of ["LICENSE", "LICENSE.md", "LICENSE.txt", "LICENCE", "COPYING", "NOTICE"]) {
    const path = join(root, name);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8");
    return text.length > 200_000 ? `${text.slice(0, 200_000)}\n\n[license text truncated]\n` : text;
  }
  return "";
}

const packages = new Map();
for (const input of Object.keys(result.metafile.inputs)) {
  if (!input.startsWith("node_modules") && !input.startsWith(`node_modules${sep}`)) continue;
  const root = findPackageRoot(input);
  if (!root) continue;
  const manifest = readJson(join(root, "package.json"));
  if (!manifest?.name || !manifest.version) continue;
  if (manifest.name.startsWith("@hearth/") || manifest.name === "hearth") continue;
  const key = `${manifest.name}@${manifest.version}`;
  if (packages.has(key)) continue;
  packages.set(key, {
    name: manifest.name,
    version: manifest.version,
    license: typeof manifest.license === "string" ? manifest.license : "see license text",
    text: licenseText(root)
  });
}

const sorted = [...packages.values()].sort((a, b) => a.name.localeCompare(b.name));
const noticeLines = [
  "Hearth bundled third-party notices",
  "",
  "This file covers JavaScript packages bundled into resources/server/server.mjs.",
  "Node.js and npm retain their own license files under resources/.",
  ""
];
for (const item of sorted) {
  noticeLines.push("=".repeat(78));
  noticeLines.push(`${item.name} ${item.version}`);
  noticeLines.push(`License: ${item.license}`);
  noticeLines.push("");
  noticeLines.push(item.text.trim() || "No license file was shipped with this package.");
  noticeLines.push("");
}
writeFileSync(join(resourcesRoot, "THIRD_PARTY_NOTICES.txt"), `${noticeLines.join("\n")}\n`, "utf8");

const serverSize = statSync(join(outputRoot, "server.mjs")).size;
console.log(`server bundle: ${(serverSize / 1048576).toFixed(2)} MiB`);
console.log(`pdf worker:   ${(statSync(join(outputRoot, "pdf.worker.mjs")).size / 1048576).toFixed(2)} MiB`);
console.log(`notices:      ${sorted.length} packages`);
