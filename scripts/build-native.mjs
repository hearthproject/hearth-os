import { existsSync, mkdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(repoRoot, "apps", "native", "hearth-native.cs");
const output = join(repoRoot, "apps", "native", "bin", "hearth-native.exe");

if (process.platform !== "win32") {
  console.warn("hearth-native is Windows-only; skipping native helper build");
  process.exit(0);
}
if (!existsSync(source)) throw new Error(`missing native helper source: ${source}`);

const candidates = [
  process.env.HEARTH_CSC,
  "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe",
  "C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe"
].filter(Boolean);
const compiler = candidates.find((candidate) => existsSync(candidate));
if (!compiler) throw new Error("找不到 csc.exe；请安装 .NET Framework 4.x 或设置 HEARTH_CSC");

mkdirSync(dirname(output), { recursive: true });
const result = spawnSync(compiler, [
  "/nologo",
  "/target:exe",
  "/platform:x64",
  `/out:${output}`,
  source
], { stdio: "inherit" });
if (result.status !== 0) throw new Error(`csc failed with exit ${result.status}`);
console.log(`hearth-native.exe ${statSync(output).size} bytes`);
