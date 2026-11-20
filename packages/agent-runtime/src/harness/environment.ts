import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface ShellSpec {
  kind: "pwsh" | "bash" | "cmd" | "sh";
  executable: string;
  args: string[];
}

export function detectShell(platform = process.platform): ShellSpec {
  if (platform === "win32") {
    const pwsh = findOnPath("pwsh.exe") ?? findOnPath("pwsh");
    if (pwsh) return { kind: "pwsh", executable: pwsh, args: ["-NoProfile", "-NonInteractive", "-Command"] };
    const powershell = findOnPath("powershell.exe");
    if (powershell) return { kind: "pwsh", executable: powershell, args: ["-NoProfile", "-NonInteractive", "-Command"] };
    return { kind: "cmd", executable: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c"] };
  }
  const bash = findOnPath("bash") ?? "/bin/bash";
  if (existsSync(bash) || bash === "bash") return { kind: "bash", executable: bash, args: ["-lc"] };
  return { kind: "sh", executable: findOnPath("sh") ?? "/bin/sh", args: ["-lc"] };
}

export function shellLabel(shell: ShellSpec): string {
  return shell.kind === "pwsh" ? "powershell" : shell.kind;
}

function findOnPath(command: string): string | null {
  const path = process.env.PATH ?? "";
  const extensions = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  for (const directory of path.split(process.platform === "win32" ? ";" : ":")) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = join(directory, `${command}${extension}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export interface GitEnvironment {
  isRepository: boolean;
  root: string | null;
  branch: string | null;
  dirty: boolean;
  changedFiles: number;
  headSha?: string | null;
  headSubject?: string | null;
  defaultBranch?: string | null;
  recentCommits?: string[];
  userName?: string | null;
}

export function readGitEnvironment(cwd: string): GitEnvironment {
  const root = gitOutput(cwd, ["rev-parse", "--show-toplevel"]);
  if (!root) return { isRepository: false, root: null, branch: null, dirty: false, changedFiles: 0 };
  const branch = gitOutput(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const status = gitOutput(cwd, ["status", "--porcelain", "--untracked-files=no"]) ?? "";
  const changedFiles = status.split(/\r?\n/).filter(Boolean).length;
  const log = gitOutput(cwd, ["log", "-5", "--format=%h%x09%s"]) ?? "";
  const recentCommits = log.split(/\r?\n/).filter(Boolean);
  const head = recentCommits[0]?.split("\t") ?? [];
  const remoteHead = gitOutput(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  return {
    isRepository: true,
    root,
    branch: branch || null,
    dirty: changedFiles > 0,
    changedFiles,
    headSha: head[0] ?? null,
    headSubject: head.slice(1).join("\t") || null,
    defaultBranch: remoteHead ? remoteHead.replace(/^origin\//, "") : null,
    recentCommits,
    userName: gitOutput(cwd, ["config", "user.name"])
  };
}

function gitOutput(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"]
    }).trim() || null;
  } catch {
    return null;
  }
}

export function environmentBlock(input: {
  cwd: string;
  outDir: string;
  profile: "general" | "coding";
  mode: "build" | "plan";
  git?: GitEnvironment;
  project?: string;
  permissions?: { network: string[]; writeRoots: string[] };
}): string {
  const shell = detectShell();
  const git = input.git ?? readGitEnvironment(input.cwd);
  const lines = [
    "<environment>",
    `cwd: ${input.cwd}`,
    `output_dir: ${input.outDir}`,
    `platform: ${process.platform}`,
    `shell: ${shellLabel(shell)}`,
    `date: ${new Date().toISOString().slice(0, 10)}`,
    `profile: ${input.profile}`,
    `mode: ${input.mode}`,
    `git: ${git.isRepository ? `branch=${git.branch ?? "detached"}, dirty=${git.dirty}, changed_files=${git.changedFiles}` : "not_a_repository"}`,
    ...(git.isRepository && git.headSha
      ? [
          `git_head: ${git.headSha}${git.headSubject ? ` ${git.headSubject}` : ""}`,
          ...(git.defaultBranch ? [`git_default_branch: ${git.defaultBranch}`] : []),
          ...(git.userName ? [`git_user: ${git.userName}`] : []),
          ...(git.recentCommits && git.recentCommits.length > 0
            ? ["git_recent:", ...git.recentCommits.map((commit) => `- ${commit}`)]
            : [])
        ]
      : []),
    ...(input.project ? [`project: ${input.project}`] : []),
    ...(input.permissions
      ? [`network: ${input.permissions.network.length ? input.permissions.network.join(",") : "disabled"}`, `write_roots: ${input.permissions.writeRoots.join(", ")}`]
      : []),
    "</environment>"
  ];
  return lines.join("\n");
}
