import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function collectExternalDependencies() {
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
      dependencies.set(name, version);
    }
  }
  return [...dependencies.keys()]
    .filter((name) => !name.startsWith("@hearth/"))
    .filter((name) => !name.startsWith("@deepseek-ai/"))
    .filter((name) => name !== "@openai/codex-win32-x64")
    .sort();
}

export function externalDependencies() {
  return collectExternalDependencies();
}

const outputRoot = join(repoRoot, "apps", "desktop", "resources", "server");
rmSync(outputRoot, { recursive: true, force: true });
mkdirSync(outputRoot, { recursive: true });

await build({
  entryPoints: [join(repoRoot, "apps", "server", "src", "index.ts")],
  outfile: join(outputRoot, "server.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: [...collectExternalDependencies(), "@deepseek-ai/*"],
  legalComments: "none",
  logLevel: "info"
});

const pdfjsRoot = join(repoRoot, "node_modules", "pdfjs-dist");
const pdfjsAssets = join(outputRoot, "assets", "pdfjs");
for (const name of ["cmaps", "standard_fonts", "wasm"]) {
  const source = join(pdfjsRoot, name);
  if (existsSync(source)) {
    cpSync(source, join(pdfjsAssets, name), { recursive: true });
  }
}

console.log(`server bundle: ${join(outputRoot, "server.mjs")}`);
