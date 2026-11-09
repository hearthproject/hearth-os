import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type {
  GitCheckSummary,
  GitCommitSummary,
  GitDiffScope,
  GitDiffView,
  GitFileChange,
  GitFileStatus,
  GitFileView,
  GitPullRequestView,
  GitRepositoryView
} from "@hearth/core";
import { runCommand, type CommandRunner } from "./github.ts";

const DEFAULT_MAX_DIFF_BYTES = 512 * 1024;
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
const COMMITS_LIMIT = 20;

export interface TaskGitOptions {
  workspaceRoot: string;
  run?: CommandRunner;
  maxDiffBytes?: number;
  maxFileBytes?: number;
}

interface RawStatusFile {
  path: string;
  oldPath: string | null;
  status: GitFileStatus;
  staged: boolean;
  unstaged: boolean;
}

interface NumStat {
  additions: number;
  deletions: number;
  binary: boolean;
}

export class TaskGitService {
  private readonly workspaceRoot: string;
  private readonly run: CommandRunner;
  private readonly maxDiffBytes: number;
  private readonly maxFileBytes: number;

  constructor(options: TaskGitOptions) {
    this.workspaceRoot = resolve(options.workspaceRoot);
    this.run = options.run ?? runCommand;
    this.maxDiffBytes = options.maxDiffBytes ?? DEFAULT_MAX_DIFF_BYTES;
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  }

  async view(taskId: string): Promise<GitRepositoryView> {
    const repoPath = this.repoPath(taskId);
    if (!existsSync(repoPath) || !existsSync(join(repoPath, ".git"))) {
      return unavailable("这个任务没有 Git 工作区");
    }
    try {
      const headSha = (await this.git(repoPath, ["rev-parse", "HEAD"])).trim();
      const branch = (await this.git(repoPath, ["branch", "--show-current"])).trim();
      const repo = await this.repositoryName(repoPath);
      const base = await this.baseBranch(repoPath, repo);
      const baseSha = base ? await this.revParse(repoPath, `origin/${base}`) : null;
      const statusRaw = await this.git(repoPath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
      const statusFiles = parsePorcelainStatus(statusRaw);
      const workingStats = await this.numStat(repoPath, ["diff", "--numstat", "HEAD", "--"], statusFiles);
      const workingFiles = statusFiles.map((file) => toChange(file, workingStats.get(file.path)));
      const branchFiles = baseSha && baseSha !== headSha
        ? await this.branchFiles(repoPath, baseSha, headSha)
        : [];
      const filesScope: GitDiffScope = workingFiles.length > 0 ? "working" : "branch";
      const commitsAhead = baseSha && baseSha !== headSha
        ? Number((await this.git(repoPath, ["rev-list", "--count", `${baseSha}..${headSha}`])).trim()) || 0
        : 0;
      const commits = baseSha && commitsAhead > 0 ? await this.commits(repoPath, baseSha, headSha) : [];
      const pullRequestResult = await this.pullRequest(repo, branch);
      return {
        available: true,
        reason: null,
        repo,
        branch: branch || null,
        base,
        baseSha,
        headSha,
        filesScope,
        clean: statusRaw.length === 0,
        statusText: statusRaw.replace(/\0/g, "\n").trim(),
        commitsAhead,
        additions: sumAdditions(workingFiles),
        deletions: sumDeletions(workingFiles),
        files: workingFiles,
        branchAdditions: sumAdditions(branchFiles),
        branchDeletions: sumDeletions(branchFiles),
        branchFiles,
        commits,
        pullRequest: pullRequestResult.pullRequest,
        pullRequestError: pullRequestResult.error
      };
    } catch (error) {
      return unavailable(error instanceof Error ? error.message : String(error));
    }
  }

  async diff(taskId: string, scope: GitDiffScope, path?: string | null): Promise<GitDiffView> {
    const repoPath = this.repoPath(taskId);
    if (!existsSync(repoPath) || !existsSync(join(repoPath, ".git"))) {
      throw new GitViewError("这个任务没有 Git 工作区", 404);
    }
    const safePath = path ? this.safePath(repoPath, path) : null;
    let patch = "";
    if (scope === "branch") {
      const base = await this.baseBranch(repoPath, await this.repositoryName(repoPath));
      const baseSha = base ? await this.revParse(repoPath, `origin/${base}`) : null;
      if (!baseSha) throw new GitViewError("无法确定任务分支的基线", 409);
      patch = await this.git(repoPath, ["diff", "--no-color", "--unified=3", `${baseSha}...HEAD`, ...(safePath ? ["--", safePath] : [])]);
    } else {
      patch = await this.workingDiff(repoPath, safePath);
    }
    const limited = truncateUtf8(patch, this.maxDiffBytes);
    return { scope, path: safePath, patch: limited.text, truncated: limited.truncated };
  }

  async file(taskId: string, path: string, fromHead = false): Promise<GitFileView> {
    const repoPath = this.repoPath(taskId);
    if (!existsSync(repoPath) || !existsSync(join(repoPath, ".git"))) {
      throw new GitViewError("这个任务没有 Git 工作区", 404);
    }
    const safePath = this.safePath(repoPath, path);
    if (fromHead) {
      try {
        const content = await this.git(repoPath, ["show", `HEAD:${safePath}`]);
        return this.fileView(safePath, true, true, Buffer.from(content, "utf8"));
      } catch {
        return { path: safePath, exists: false, fromHead: true, binary: false, truncated: false, bytes: 0, content: "" };
      }
    }
    const absolute = join(repoPath, safePath);
    if (!existsSync(absolute)) {
      return { path: safePath, exists: false, fromHead: false, binary: false, truncated: false, bytes: 0, content: "" };
    }
    const entry = lstatSync(absolute);
    if (entry.isSymbolicLink()) throw new GitViewError("不读取仓库内的符号链接", 400);
    if (!entry.isFile()) {
      return { path: safePath, exists: false, fromHead: false, binary: false, truncated: false, bytes: 0, content: "" };
    }
    const bytes = this.readWorkspaceFile(repoPath, safePath);
    if (!bytes) throw new GitViewError("文件路径超出任务仓库", 400);
    return this.fileView(safePath, true, false, bytes);
  }

  private fileView(path: string, exists: boolean, fromHead: boolean, bytes: Buffer): GitFileView {
    const binary = bytes.subarray(0, Math.min(bytes.length, 8_000)).includes(0);
    const sliced = bytes.subarray(0, this.maxFileBytes);
    return {
      path,
      exists,
      fromHead,
      binary,
      truncated: bytes.length > sliced.length,
      bytes: bytes.length,
      content: binary ? "" : sliced.toString("utf8")
    };
  }

  private async workingDiff(repoPath: string, safePath: string | null): Promise<string> {
    const tracked = await this.git(repoPath, ["diff", "--no-color", "--unified=3", "HEAD", ...(safePath ? ["--", safePath] : [])]);
    if (!safePath || tracked.trim()) return tracked;
    if (!existsSync(join(repoPath, safePath))) return tracked;
    const bytes = this.readWorkspaceFile(repoPath, safePath);
    if (!bytes) return `Symbolic link or unreadable file: ${safePath}\n`;
    if (bytes.subarray(0, 8_000).includes(0)) return `Binary file: ${safePath}\n`;
    const lines = bytes.toString("utf8").split(/\r?\n/);
    const content = lines.map((line) => `+${line}`).join("\n");
    return [
      `diff --git a/${safePath} b/${safePath}`,
      "new file mode 100644",
      "--- /dev/null",
      `+++ b/${safePath}`,
      `@@ -0,0 +1,${lines.length} @@`,
      content,
      ""
    ].join("\n");
  }

  private async branchFiles(repoPath: string, baseSha: string, headSha: string): Promise<GitFileChange[]> {
    const raw = await this.git(repoPath, ["diff", "--name-status", "--find-renames", `${baseSha}...${headSha}`]);
    const files: RawStatusFile[] = [];
    for (const line of raw.split(/\r?\n/).filter(Boolean)) {
      const [code = "", first = "", second = ""] = line.split("\t");
      const status = statusFromCode(code);
      if (!first) continue;
      files.push({
        path: code.startsWith("R") || code.startsWith("C") ? second : first,
        oldPath: code.startsWith("R") || code.startsWith("C") ? first : null,
        status,
        staged: false,
        unstaged: false
      });
    }
    const stats = await this.numStat(repoPath, ["diff", "--numstat", `${baseSha}...${headSha}`, "--"], files);
    return files.map((file) => toChange(file, stats.get(file.path)));
  }

  private async numStat(repoPath: string, args: string[], files: RawStatusFile[]): Promise<Map<string, NumStat>> {
    const stats = new Map<string, NumStat>();
    const raw = await this.git(repoPath, args).catch(() => "");
    for (const line of raw.split(/\r?\n/).filter(Boolean)) {
      const [added = "", removed = "", ...pathParts] = line.split("\t");
      const path = pathParts.join("\t");
      if (!path) continue;
      stats.set(path, {
        additions: added === "-" ? 0 : Number(added) || 0,
        deletions: removed === "-" ? 0 : Number(removed) || 0,
        binary: added === "-" || removed === "-"
      });
    }
    for (const file of files) {
      if (stats.has(file.path) || file.status !== "untracked") continue;
      try {
        const bytes = this.readWorkspaceFile(repoPath, file.path);
        if (!bytes) {
          stats.set(file.path, { additions: 0, deletions: 0, binary: false });
          continue;
        }
        if (bytes.subarray(0, 8_000).includes(0)) {
          stats.set(file.path, { additions: 0, deletions: 0, binary: true });
        } else {
          const text = bytes.toString("utf8");
          stats.set(file.path, { additions: text ? text.split(/\r?\n/).length - (text.endsWith("\n") ? 1 : 0) : 0, deletions: 0, binary: false });
        }
      } catch {
        stats.set(file.path, { additions: 0, deletions: 0, binary: false });
      }
    }
    return stats;
  }

  private async commits(repoPath: string, baseSha: string, headSha: string): Promise<GitCommitSummary[]> {
    const raw = await this.git(repoPath, [
      "log", `--max-count=${COMMITS_LIMIT}`, "--format=%H%x1f%h%x1f%s%x1f%an%x1f%aI", `${baseSha}..${headSha}`
    ]);
    return raw.split(/\r?\n/).filter(Boolean).map((line) => {
      const [sha = "", shortSha = "", subject = "", authorName = "", authoredAt = ""] = line.split("\x1f");
      return { sha, shortSha, subject, authorName, authoredAt };
    });
  }

  private async pullRequest(repo: string | null, branch: string): Promise<{ pullRequest: GitPullRequestView | null; error: string | null }> {
    if (!repo || !branch) return { pullRequest: null, error: null };
    try {
      const raw = await this.run("gh", [
        "pr", "list", "--repo", repo, "--head", branch, "--state", "all", "--limit", "1",
        "--json", "number,url,title,state,isDraft,mergeable,reviewDecision,headRefOid,updatedAt,statusCheckRollup"
      ]);
      const parsed = JSON.parse(raw.stdout) as Array<Record<string, unknown>>;
      const item = parsed[0];
      if (!item) return { pullRequest: null, error: null };
      const checks = Array.isArray(item.statusCheckRollup)
        ? item.statusCheckRollup.map((check): GitCheckSummary => {
            const value = check as Record<string, unknown>;
            return {
              name: typeof value.name === "string" ? value.name : typeof value.context === "string" ? value.context : "未命名检查",
              status: typeof value.status === "string" ? value.status : "UNKNOWN",
              conclusion: typeof value.conclusion === "string" ? value.conclusion : null,
              url: typeof value.detailsUrl === "string" ? value.detailsUrl : typeof value.targetUrl === "string" ? value.targetUrl : null
            };
          })
        : [];
      return {
        pullRequest: {
          number: Number(item.number),
          url: String(item.url ?? ""),
          title: String(item.title ?? ""),
          state: String(item.state ?? "UNKNOWN"),
          draft: Boolean(item.isDraft),
          mergeable: typeof item.mergeable === "string" ? item.mergeable : null,
          reviewDecision: typeof item.reviewDecision === "string" ? item.reviewDecision : null,
          headSha: typeof item.headRefOid === "string" ? item.headRefOid : null,
          updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : null,
          checks
        },
        error: null
      };
    } catch (error) {
      return { pullRequest: null, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async repositoryName(repoPath: string): Promise<string | null> {
    const remote = await this.git(repoPath, ["remote", "get-url", "origin"]).catch(() => "");
    const match = remote.trim().match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i);
    return match ? `${match[1]}/${match[2]}` : null;
  }

  private async baseBranch(repoPath: string, repo: string | null): Promise<string | null> {
    const symbolic = await this.revParse(repoPath, "refs/remotes/origin/HEAD", true);
    if (symbolic) return symbolic.replace(/^origin\//, "");
    if (repo) {
      try {
        const result = await this.run("gh", ["repo", "view", repo, "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"]);
        const branch = result.stdout.trim();
        if (branch) return branch;
      } catch {
        // Fall through to main when gh is unavailable.
      }
    }
    return "main";
  }

  private async revParse(repoPath: string, ref: string, symbolic = false): Promise<string | null> {
    try {
      const args = symbolic ? ["symbolic-ref", "--short", ref] : ["rev-parse", "--verify", "--quiet", ref];
      const value = (await this.git(repoPath, args)).trim();
      return value || null;
    } catch {
      return null;
    }
  }

  private repoPath(taskId: string): string {
    if (!/^[A-Za-z0-9._-]+$/.test(taskId) || taskId === "." || taskId === "..") {
      throw new GitViewError("任务标识不合法", 400);
    }
    const path = resolve(this.workspaceRoot, "tasks", taskId, "repo");
    const rel = relative(this.workspaceRoot, path);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new GitViewError("任务工作区超出允许范围", 400);
    return path;
  }

  private safePath(repoPath: string, path: string): string {
    if (!path.trim() || isAbsolute(path) || path.includes("\0")) throw new GitViewError("文件路径不合法", 400);
    const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");
    const absolute = resolve(repoPath, normalized);
    const rel = relative(repoPath, absolute).replace(/\\/g, "/");
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new GitViewError("文件路径超出任务仓库", 400);
    return rel;
  }

  private readWorkspaceFile(repoPath: string, path: string): Buffer | null {
    try {
      const absolute = join(repoPath, path);
      const entry = lstatSync(absolute);
      if (entry.isSymbolicLink() || !entry.isFile()) return null;
      const root = realpathSync(repoPath);
      const real = realpathSync(absolute);
      const rel = relative(root, real);
      if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
      return readFileSync(real);
    } catch {
      return null;
    }
  }

  private async git(repoPath: string, args: string[]): Promise<string> {
    const result = await this.run("git", args, { cwd: repoPath, timeoutMs: 30_000 });
    return result.stdout;
  }
}

export class GitViewError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "GitViewError";
    this.statusCode = statusCode;
  }
}

function unavailable(reason: string): GitRepositoryView {
  return {
    available: false,
    reason,
    repo: null,
    branch: null,
    base: null,
    baseSha: null,
    headSha: null,
    filesScope: "working",
    clean: true,
    statusText: "",
    commitsAhead: 0,
    additions: 0,
    deletions: 0,
    files: [],
    branchAdditions: 0,
    branchDeletions: 0,
    branchFiles: [],
    commits: [],
    pullRequest: null,
    pullRequestError: null
  };
}

function parsePorcelainStatus(raw: string): RawStatusFile[] {
  const parts = raw.split("\0").filter((entry) => entry.length > 0);
  const files: RawStatusFile[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const entry = parts[index] ?? "";
    if (entry.length < 4) continue;
    const x = entry[0] ?? " ";
    const y = entry[1] ?? " ";
    const status = statusFromCode(`${x}${y}`);
    const renamed = x === "R" || x === "C" || y === "R" || y === "C";
    const path = entry.slice(3);
    const oldPath = renamed ? parts[index + 1] ?? null : null;
    if (renamed) index += 1;
    files.push({
      path,
      oldPath,
      status,
      staged: x !== " " && x !== "?",
      unstaged: y !== " " || x === "?"
    });
  }
  return files;
}

function statusFromCode(code: string): GitFileStatus {
  if (code.includes("U") || code === "AA" || code === "DD") return "conflicted";
  if (code.includes("R")) return "renamed";
  if (code.includes("A") || code === "??") return code === "??" ? "untracked" : "added";
  if (code.includes("D")) return "deleted";
  return "modified";
}

function toChange(file: RawStatusFile, stat?: NumStat): GitFileChange {
  return {
    path: file.path,
    oldPath: file.oldPath,
    status: file.status,
    additions: stat?.additions ?? 0,
    deletions: stat?.deletions ?? 0,
    binary: stat?.binary ?? false,
    staged: file.staged,
    unstaged: file.unstaged
  };
}

function sumAdditions(files: GitFileChange[]): number {
  return files.reduce((sum, file) => sum + file.additions, 0);
}

function sumDeletions(files: GitFileChange[]): number {
  return files.reduce((sum, file) => sum + file.deletions, 0);
}

function truncateUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return { text: value, truncated: false };
  return { text: bytes.subarray(0, maxBytes).toString("utf8"), truncated: true };
}
