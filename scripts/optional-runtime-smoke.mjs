import { build } from "esbuild";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = mkdtempSync(join(tmpdir(), "hearth-optional-runtime-"));

try {
  const executorBundle = join(tempRoot, "deepseek-executor.mjs");
  await build({
    entryPoints: [join(repoRoot, "packages/deepseek-executor/src/index.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    outfile: executorBundle,
    external: ["@deepseek-ai/*"],
    logLevel: "silent"
  });

  const entry = join(tempRoot, "entry.mjs");
  writeFileSync(entry, `
import { runDeepSeekHarness } from ${JSON.stringify(pathToFileURL(executorBundle).href)};

try {
  await runDeepSeekHarness({
    settings: {
      protocol: "openai-chat",
      baseUrl: "http://127.0.0.1:1",
      model: "smoke",
      apiKey: "smoke"
    },
    dshHome: ".dsh",
    workingDirectory: ".",
    outDir: ".",
    prompt: "Reply with HEARTH_OK",
    mode: "necessary",
    maxTurns: 1,
    runBudgetSeconds: 30
  });
  console.error("expected EXECUTOR_RUNTIME_MISSING, but the runner completed");
  process.exit(1);
} catch (error) {
  console.log(JSON.stringify({
    name: error?.name ?? null,
    code: error?.code ?? null,
    message: error?.message ?? String(error)
  }));
  if (error?.code !== "EXECUTOR_RUNTIME_MISSING") process.exit(1);
}
`, "utf8");

  const child = spawn(process.execPath, [entry], {
    cwd: tempRoot,
    stdio: "inherit",
    env: { ...process.env, NODE_PATH: "" }
  });
  const code = await new Promise((resolve) => child.on("close", resolve));
  if (code !== 0) throw new Error(`optional runtime smoke failed with exit code ${code}`);
  console.log("optional runtime smoke ok");
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
