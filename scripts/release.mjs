import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const tauriRoot = join(repoRoot, "apps", "desktop-tauri");
const tauriConfigPath = join(tauriRoot, "src-tauri", "tauri.conf.json");
const releaseRoot = join(repoRoot, "release");

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

function run(command, args, cwd) {
  execFileSync(command, args, { cwd, stdio: "inherit" });
}

function capture(command, args, cwd) {
  try {
    return execFileSync(command, args, { cwd, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function targetRelease() {
  return process.env.CARGO_TARGET_DIR
    ? join(process.env.CARGO_TARGET_DIR, "release")
    : join(tauriRoot, "src-tauri", "target", "release");
}

function zipPortable(version, staging) {
  const target = targetRelease();
  const exe = join(target, "hearth_desktop.exe");
  const resources = join(target, "resources");
  if (!existsSync(exe) || !existsSync(resources)) {
    console.warn("portable: skipped because the release executable or resources directory is missing");
    return null;
  }
  const portableRoot = join(staging, `Hearth-${version}-portable`);
  mkdirSync(portableRoot, { recursive: true });
  copyFileSync(exe, join(portableRoot, "Hearth.exe"));
  execFileSync("powershell", ["-NoProfile", "-Command", `Copy-Item -LiteralPath '${resources.replaceAll("'", "''")}' -Destination '${join(portableRoot, "resources").replaceAll("'", "''")}' -Recurse -Force`]);
  const zip = join(staging, `Hearth-${version}-portable.zip`);
  execFileSync("powershell", ["-NoProfile", "-Command", `Compress-Archive -LiteralPath '${portableRoot.replaceAll("'", "''")}' -DestinationPath '${zip.replaceAll("'", "''")}' -Force`]);
  execFileSync("powershell", ["-NoProfile", "-Command", `Remove-Item -LiteralPath '${portableRoot.replaceAll("'", "''")}' -Recurse -Force`]);
  return zip;
}

function releaseNotes(version, staging) {
  const lastTag = capture("git", ["describe", "--tags", "--abbrev=0"], repoRoot);
  const range = lastTag ? `${lastTag}..HEAD` : "HEAD";
  const commits = capture("git", ["log", "--pretty=format:- %s (%h)", range, "--max-count=80"], repoRoot);
  const changelog = existsSync(join(repoRoot, "CHANGELOG.md")) ? readFileSync(join(repoRoot, "CHANGELOG.md"), "utf8") : "";
  const lines = [
    `# Hearth ${version}`,
    "",
    `Released ${new Date().toISOString()}`,
    "",
    "## Highlights",
    "",
    changelog.includes(`## ${version}`) ? "See the matching section in CHANGELOG.md." : "Summarize the user-visible changes before publishing.",
    "",
    "## Commits",
    "",
    commits || "- No commits found.",
    "",
    "## Install",
    "",
    `- Windows installer: Hearth_${version}_x64-setup.exe`,
    `- Portable: Hearth-${version}-portable.zip (extract, keep resources beside Hearth.exe, run Hearth.exe)`,
    "",
    "Verify every download against SHA256SUMS.txt. Builds without an updater signing key do not include update artifacts.",
    ""
  ];
  const path = join(staging, "RELEASE_NOTES.md");
  writeFileSync(path, lines.join("\n"), "utf8");
  return path;
}

function latestJson(version, staging, installer, signaturePath) {
  const baseUrl = process.env.HEARTH_RELEASE_BASE_URL;
  if (!baseUrl) {
    console.warn("updater: latest.json skipped because HEARTH_RELEASE_BASE_URL is missing");
    return null;
  }
  if (!existsSync(signaturePath)) {
    console.warn("updater: latest.json skipped because the installer has no .sig file; build with a signing key first");
    return null;
  }
  const body = {
    version,
    notes: `Hearth ${version}`,
    pub_date: new Date().toISOString(),
    platforms: {
      "windows-x86_64": {
        signature: readFileSync(signaturePath, "utf8").trim(),
        url: `${baseUrl.replace(/\/+$/, "")}/${encodeURIComponent(installer)}`
      }
    }
  };
  const path = join(staging, "latest.json");
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  return path;
}

function main() {
  const version = arg("version", JSON.parse(readFileSync(tauriConfigPath, "utf8")).version);
  if (!version || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`invalid version: ${version}`);
  }
  const skipBuild = process.argv.includes("--skip-build");
  if (!skipBuild) run(process.execPath, [join(repoRoot, "scripts", "build-tauri.mjs")], repoRoot);

  const staging = join(releaseRoot, version);
  mkdirSync(staging, { recursive: true });
  const installerName = `Hearth_${version}_x64-setup.exe`;
  const installer = join(staging, installerName);
  const stagedInstaller = join(releaseRoot, installerName);
  if (existsSync(stagedInstaller)) copyFileSync(stagedInstaller, installer);
  else if (!existsSync(installer)) throw new Error(`installer not found: ${installer}. Run npm run release:build first.`);

  const signatureSource = `${stagedInstaller}.sig`;
  const signature = `${installer}.sig`;
  if (existsSync(signatureSource)) copyFileSync(signatureSource, signature);

  const portable = zipPortable(version, staging);
  releaseNotes(version, staging);
  const latest = latestJson(version, staging, installerName, signature);

  const checksummed = readdirSync(staging)
    .filter((name) => !name.endsWith("SHA256SUMS.txt") && statSync(join(staging, name)).isFile())
    .sort();
  writeFileSync(join(staging, "SHA256SUMS.txt"), `${checksummed.map((name) => `${sha256(join(staging, name))}  ${name}`).join("\n")}\n`, "utf8");

  console.log(`\nrelease staged: ${staging}`);
  for (const name of checksummed) console.log(`- ${name} (${(statSync(join(staging, name)).size / 1048576).toFixed(1)} MiB)`);
  if (portable) console.log(`- portable zip: ${portable}`);
  if (latest) console.log(`- updater manifest: ${latest}`);
  console.log("\nnext: review RELEASE_NOTES.md, tag the commit, upload the staged files, then point the updater endpoint at latest.json");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
