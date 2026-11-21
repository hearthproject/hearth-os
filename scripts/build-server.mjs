import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = join(repoRoot, "apps", "desktop-tauri", "src-tauri", "resources", "server");
const resourcesRoot = join(repoRoot, "apps", "desktop-tauri", "src-tauri", "resources");

rmSync(outputRoot, { recursive: true, force: true });
mkdirSync(outputRoot, { recursive: true });

const result = await build({
  entryPoints: [
    join(repoRoot, "apps", "server", "src", "index.ts"),
    join(repoRoot, "apps", "server", "src", "library", "mcp-main.ts")
  ],
  outdir: outputRoot,
  entryNames: "[name]",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  minify: true,
  // Split the graph into lazy chunks. playwright-core, the Feishu SDK, the
  // transformers runtime and the document extractors are only reached through
  // dynamic imports, so keeping them out of the startup module removes ~10 MiB
  // from the eager parse path.
  splitting: true,
  chunkNames: "chunk-[hash]",
  external: ["@openai/codex-win32-x64"],
  legalComments: "none",
  metafile: true,
  plugins: [stubBidiOnlyModules()],
  logLevel: "info"
});

renameSync(join(outputRoot, "index.mjs"), join(outputRoot, "server.mjs"));
renameSync(join(outputRoot, "mcp-main.mjs"), join(outputRoot, "library-mcp.mjs"));

// With `splitting: true`, esbuild hoists CJS interop into shared chunks. Only
// the entry used to receive the banner-provided `require`, so every chunk that
// touches a CJS dependency failed with "Dynamic require of ... is not
// supported". Give each emitted module its own module-scoped createRequire.
const REQUIRE_SHIM =
  'import{createRequire as __hearthCreateRequire}from"node:module";const require=__hearthCreateRequire(import.meta.url);\n';

function addRequireShim() {
  let patched = 0;
  for (const name of readdirSync(outputRoot)) {
    if (!name.endsWith(".mjs") || name === "pdf.worker.mjs") continue;
    const file = join(outputRoot, name);
    const source = readFileSync(file, "utf8");
    if (source.startsWith(REQUIRE_SHIM)) continue;
    writeFileSync(file, REQUIRE_SHIM + source, "utf8");
    patched += 1;
  }
  return patched;
}

const shimmed = addRequireShim();

// playwright-core ships an internal coreBundle that statically requires its
// optional WebDriver BiDi mapper. Hearth only speaks CDP to Chromium, and
// playwright-core does not declare chromium-bidi as a dependency, so bundling
// fails on a clean install. Resolve those two unused modules to inert stubs.
function stubBidiOnlyModules() {
  const modules = new Set([
    "chromium-bidi/lib/cjs/bidiMapper/BidiMapper",
    "chromium-bidi/lib/cjs/cdp/CdpConnection"
  ]);
  return {
    name: "stub-unused-playwright-bidi",
    setup(build) {
      build.onResolve({ filter: /^chromium-bidi\// }, (args) => {
        if (!modules.has(args.path)) return null;
        return { path: args.path, namespace: "hearth-bidi-stub" };
      });
      build.onLoad({ filter: /.*/, namespace: "hearth-bidi-stub" }, () => ({
        contents: "export const BidiMapper = class {}; export const CdpConnection = class {};",
        loader: "js"
      }));
    }
  };
}

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
const copiedPackages = new Set();
if (existsSync(sandboxPackageRoot)) {
  rmSync(sandboxRoot, { recursive: true, force: true });
  copyPackageTree("@deepseek-ai/dsh-sandbox-windows-acl");
} else {
  console.warn(`windows ACL runner package is not installed; packaged shell tasks will fail closed (${sandboxPackageRoot})`);
}

// Copy the package and its dependency closure into one flat node_modules.
// The previous implementation nested every dependency under its parent, which
// produced 300+ character paths that makensis cannot open on Windows.

function copyPackageTree(name, from = repoRoot, optional = false) {
  if (copiedPackages.has(name)) return;
  const source = resolvePackageRoot(name, from);
  if (!source) {
    if (!optional) console.warn(`sandbox dependency is not installed: ${name}`);
    return;
  }
  copiedPackages.add(name);
  const target = name === "@deepseek-ai/dsh-sandbox-windows-acl"
    ? sandboxRoot
    : join(sandboxRoot, "node_modules", name);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, {
    recursive: true,
    filter: (path) => path !== join(source, "node_modules") && !path.startsWith(`${join(source, "node_modules")}${sep}`)
  });
  const manifest = readJson(join(source, "package.json"));
  const required = {
    ...(manifest?.peerDependencies ?? {}),
    ...(manifest?.dependencies ?? {})
  };
  for (const dependency of Object.keys(required)) {
    if (dependency.startsWith("@hearth/") || dependency === "hearth") continue;
    copyPackageTree(dependency, source);
  }
  for (const dependency of Object.keys(manifest?.optionalDependencies ?? {})) {
    if (dependency.startsWith("@hearth/") || dependency === "hearth") continue;
    copyPackageTree(dependency, source, true);
  }
}

function resolvePackageRoot(name, from) {
  try {
    const manifestPath = createRequire(join(from, "package.json")).resolve(`${name}/package.json`);
    return dirname(manifestPath);
  } catch {
    const direct = join(repoRoot, "node_modules", name);
    return existsSync(join(direct, "package.json")) ? direct : null;
  }
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
