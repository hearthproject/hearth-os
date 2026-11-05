import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { EffectRecord } from "@hearth/core";
import { EffectUncertainError } from "./approvals.ts";

const execFileAsync = promisify(execFile);
const COMMAND_TIMEOUT_MS = 5 * 60 * 1000;

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  command: string,
  args: string[],
  options?: { cwd?: string; timeoutMs?: number }
) => Promise<CommandResult>;

export interface GitHubTaskSpec {
  repo: string;
  issue?: number;
  pull?: number;
  headSha?: string;
}

export interface RepositoryContext {
  path: string;
  repo: string;
  branch: string;
  base: string;
  baseSha: string;
  headSha: string;
  pull: number | null;
  issue: number | null;
  detached: boolean;
}

export interface GitHubContext {
  kind: "issue" | "pull";
  url: string;
  title: string;
  body: string;
  state: string;
  number: number;
  labels: string[];
  comments: Array<{ body: string; url?: string | undefined }>;
}

export interface PreparedGitHubWorkspace {
  repository: RepositoryContext;
  context: GitHubContext;
}

export class CommandError extends Error {
  readonly command: string;
  readonly stderr: string;

  constructor(command: string, stderr: string, message?: string) {
    super(message ?? `${command} 执行失败：${stderr}`.trim());
    this.name = "CommandError";
    this.command = command;
    this.stderr = stderr;
  }
}

export const runCommand: CommandRunner = async (command, args, options = {}) => {
  try {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd,
      timeout: options.timeoutMs ?? COMMAND_TIMEOUT_MS,
      maxBuffer: 20 * 1024 * 1024,
      windowsHide: true,
      encoding: "utf8",
      env: process.env
    });
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  } catch (error) {
    const failure = error as { stderr?: string; stdout?: string; message?: string };
    throw new CommandError(
      [command, ...args].join(" "),
      failure.stderr ?? failure.stdout ?? "",
      failure.message
    );
  }
};

export async function prepareGitHubWorkspace(options: {
  spec: GitHubTaskSpec;
  taskId: string;
  workspaceRoot: string;
  run?: CommandRunner | undefined;
}): Promise<PreparedGitHubWorkspace> {
  const run = options.run ?? runCommand;
  const repoPath = join(options.workspaceRoot, "repo");
  if (existsSync(repoPath)) throw new Error(`GitHub 工作区已存在：${repoPath}`);
  mkdirSync(options.workspaceRoot, { recursive: true });

  await run("gh", ["repo", "clone", options.spec.repo, repoPath, "--", "--depth", "50"], { timeoutMs: 10 * 60 * 1000 });
  await ensureGitIdentity(run, repoPath, options.spec.repo);
  const base = await defaultBranch(run, options.spec.repo);

  if (options.spec.issue) {
    const branch = `hearth/${options.taskId.toLowerCase().replace(/[^a-z0-9._-]+/g, "-")}`;
    await run("git", ["fetch", "origin", base, "--depth", "50"], { cwd: repoPath });
    await run("git", ["checkout", "-B", branch, `origin/${base}`], { cwd: repoPath });
    const context = await loadGitHubContext(run, options.spec.repo, "issue", options.spec.issue);
    const baseSha = (await run("git", ["rev-parse", "HEAD"], { cwd: repoPath })).stdout.trim();
    const headSha = baseSha;
    return {
      context,
      repository: {
        path: repoPath,
        repo: options.spec.repo,
        branch,
        base,
        baseSha,
        headSha,
        pull: null,
        issue: options.spec.issue,
        detached: false
      }
    };
  }

  if (!options.spec.pull) throw new Error("GitHub 任务必须指定 issue 或 pull 编号");
  await run("git", ["fetch", "origin", `refs/pull/${options.spec.pull}/head:refs/remotes/origin/pr-${options.spec.pull}`, "--depth", "200"], { cwd: repoPath });
  await run("git", ["checkout", "--detach", `refs/remotes/origin/pr-${options.spec.pull}`], { cwd: repoPath });
  const headSha = (await run("git", ["rev-parse", "HEAD"], { cwd: repoPath })).stdout.trim();
  if (options.spec.headSha && headSha !== options.spec.headSha) {
    throw new Error(`PR head 已变化：期望 ${options.spec.headSha}，实际 ${headSha}`);
  }
  const baseSha = (await run("git", ["rev-parse", `origin/${base}`], { cwd: repoPath })).stdout.trim();
  const context = await loadGitHubContext(run, options.spec.repo, "pull", options.spec.pull);
  return {
    context,
    repository: {
      path: repoPath,
      repo: options.spec.repo,
      branch: `detached-${headSha.slice(0, 12)}`,
      base,
      baseSha,
      headSha,
      pull: options.spec.pull,
      issue: null,
      detached: true
    }
  };
}

export async function inspectRepository(repository: RepositoryContext, run: CommandRunner = runCommand) {
  const status = (await run("git", ["status", "--porcelain"], { cwd: repository.path })).stdout.trim();
  const branch = (await run("git", ["branch", "--show-current"], { cwd: repository.path })).stdout.trim();
  const headSha = (await run("git", ["rev-parse", "HEAD"], { cwd: repository.path })).stdout.trim();
  const commits = repository.baseSha === headSha
    ? 0
    : Number((await run("git", ["rev-list", "--count", `${repository.baseSha}..${headSha}`], { cwd: repository.path })).stdout.trim());
  const diffStat = repository.baseSha === headSha
    ? ""
    : (await run("git", ["diff", "--stat", `${repository.baseSha}...${headSha}`], { cwd: repository.path })).stdout.trim();
  return { clean: status.length === 0, status, branch, headSha, commits, diffStat };
}

export function validatePullRequestPreview(value: unknown, repository: RepositoryContext): {
  title: string;
  body: string;
  branch: string;
  base: string;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("pr-preview.json 必须是对象");
  const preview = value as Record<string, unknown>;
  const title = requiredString(preview, "title");
  const body = requiredString(preview, "body");
  if (title.length > 160) throw new Error("PR 标题不能超过 160 个字符");
  if (body.length > 60_000) throw new Error("PR 正文过长");
  if (!/(?:closes|fixes|resolves)\s+#16\b/i.test(body) && !/#16\b/.test(body)) {
    throw new Error("PR 正文必须链接 Issue #16");
  }
  const branch = typeof preview.branch === "string" ? preview.branch : repository.branch;
  const base = typeof preview.base === "string" ? preview.base : repository.base;
  if (branch !== repository.branch || base !== repository.base) {
    throw new Error(`PR 预览的分支必须固定为 ${repository.branch} → ${repository.base}`);
  }
  return { title, body, branch, base };
}

export async function executeGitHubEffect(effect: EffectRecord, run: CommandRunner = runCommand): Promise<Record<string, unknown>> {
  if (effect.kind === "github.publish-pr") return publishPullRequest(effect, run);
  if (effect.kind === "github.comment") return postPullRequestComment(effect, run);
  throw new Error(`不支持的 GitHub 动作：${effect.kind}`);
}

async function publishPullRequest(effect: EffectRecord, run: CommandRunner): Promise<Record<string, unknown>> {
  const repo = requiredTargetString(effect.target, "repo");
  const repoPath = requiredTargetString(effect.target, "workspace");
  const branch = requiredTargetString(effect.target, "branch");
  const base = requiredTargetString(effect.target, "base");
  const expectedCommit = requiredTargetString(effect.target, "expectedCommit");
  const title = requiredTargetString(effect.target, "title");
  const body = requiredTargetString(effect.target, "body");
  if (branch === base || branch === "main" || branch === "master") throw new Error("不能从基础分支直接创建 PR");

  await verifyRepositoryState(repoPath, branch, expectedCommit, run);
  try {
    await run("git", ["push", "--set-upstream", "origin", branch], { cwd: repoPath, timeoutMs: 5 * 60 * 1000 });
  } catch (error) {
    const remote = await remoteBranchSha(repo, branch, run).catch(() => null);
    if (remote !== expectedCommit) {
      throw new EffectUncertainError(`推送分支失败，且无法确认远端状态：${errorMessage(error)}`);
    }
  }

  const existing = await findOpenPullRequest(repo, branch, run);
  if (existing) return { ...existing, headSha: expectedCommit, idempotent: true };

  const bodyPath = join(tmpdir(), `.hearth-pr-body-${effect.id}.md`);
  try {
    writeFileSync(bodyPath, `${body}\n`, "utf8");
    const created = await run("gh", ["pr", "create", "--repo", repo, "--base", base, "--head", branch, "--title", title, "--body-file", bodyPath], { cwd: repoPath });
    const url = created.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
    if (!url || !/^https:\/\/github\.com\//.test(url)) {
      throw new EffectUncertainError("gh pr create 已执行，但无法确认 PR 地址");
    }
    const details = await pullRequestDetails(repo, branch, run);
    return { ...details, url, headSha: expectedCommit };
  } catch (error) {
    const found = await findOpenPullRequest(repo, branch, run).catch(() => null);
    if (found) return { ...found, headSha: expectedCommit, idempotent: true };
    throw new EffectUncertainError(`创建 PR 可能已经产生部分影响，请先到仓库核对：${errorMessage(error)}`);
  } finally {
    rmSync(bodyPath, { force: true });
  }
}

async function postPullRequestComment(effect: EffectRecord, run: CommandRunner): Promise<Record<string, unknown>> {
  const repo = requiredTargetString(effect.target, "repo");
  const pull = requiredTargetNumber(effect.target, "pull");
  const expectedHead = requiredTargetString(effect.target, "headSha");
  const body = requiredTargetString(effect.target, "body");
  const marker = `<!-- hearth-effect:${effect.idempotencyKey} -->`;
  const markedBody = `${body.trim()}\n\n${marker}\n`;

  const current = await run("gh", ["pr", "view", String(pull), "--repo", repo, "--json", "headRefOid,url,state,comments"]);
  const details = JSON.parse(current.stdout) as { headRefOid: string; url: string; state: string; comments?: Array<{ body?: string; url?: string }> };
  if (details.headRefOid !== expectedHead) {
    throw new Error(`PR head 已变化：确认时 ${expectedHead}，当前 ${details.headRefOid}`);
  }
  if (details.state !== "OPEN") throw new Error(`PR 当前不是打开状态：${details.state}`);
  const existing = details.comments?.find((comment) => comment.body?.includes(marker));
  if (existing) return { url: details.url, pull, commentUrl: existing.url ?? null, idempotent: true };

  const bodyPath = join(tmpdir(), `.hearth-pr-comment-${effect.id}.md`);
  try {
    writeFileSync(bodyPath, markedBody, "utf8");
    await run("gh", ["pr", "comment", String(pull), "--repo", repo, "--body-file", bodyPath]);
    return { url: details.url, pull, headSha: expectedHead, posted: true };
  } catch (error) {
    const refreshed = await run("gh", ["pr", "view", String(pull), "--repo", repo, "--json", "comments"]);
    const comments = JSON.parse(refreshed.stdout) as { comments?: Array<{ body?: string; url?: string }> };
    const found = comments.comments?.find((comment) => comment.body?.includes(marker));
    if (found) return { url: details.url, pull, commentUrl: found.url ?? null, idempotent: true };
    throw new EffectUncertainError(`发布评论可能已经产生部分影响，请先核对 PR：${errorMessage(error)}`);
  } finally {
    rmSync(bodyPath, { force: true });
  }
}

async function loadGitHubContext(
  run: CommandRunner,
  repo: string,
  kind: "issue" | "pull",
  number: number
): Promise<GitHubContext> {
  if (kind === "issue") {
    const result = await run("gh", ["issue", "view", String(number), "--repo", repo, "--json", "number,title,body,state,url,labels,comments"]);
    const raw = JSON.parse(result.stdout) as {
      number: number;
      title: string;
      body: string;
      state: string;
      url: string;
      labels?: Array<{ name?: string }>;
      comments?: Array<{ body?: string; url?: string }>;
    };
    return {
      kind,
      number: raw.number,
      title: raw.title,
      body: raw.body ?? "",
      state: raw.state,
      url: raw.url,
      labels: (raw.labels ?? []).map((label) => label.name ?? "").filter(Boolean),
      comments: (raw.comments ?? []).map((comment) => ({ body: comment.body ?? "", url: comment.url }))
    };
  }
  const result = await run("gh", ["pr", "view", String(number), "--repo", repo, "--json", "number,title,body,state,url,labels,comments,headRefOid"]);
  const raw = JSON.parse(result.stdout) as {
    number: number;
    title: string;
    body: string;
    state: string;
    url: string;
    labels?: Array<{ name?: string }>;
    comments?: Array<{ body?: string; url?: string }>;
  };
  return {
    kind,
    number: raw.number,
    title: raw.title,
    body: raw.body ?? "",
    state: raw.state,
    url: raw.url,
    labels: (raw.labels ?? []).map((label) => label.name ?? "").filter(Boolean),
    comments: (raw.comments ?? []).map((comment) => ({ body: comment.body ?? "", url: comment.url }))
  };
}

async function defaultBranch(run: CommandRunner, repo: string): Promise<string> {
  const result = await run("gh", ["repo", "view", repo, "--json", "defaultBranchRef"]);
  const parsed = JSON.parse(result.stdout) as { defaultBranchRef?: { name?: string } };
  return parsed.defaultBranchRef?.name || "main";
}

async function ensureGitIdentity(run: CommandRunner, repoPath: string, repo: string): Promise<void> {
  const name = await run("git", ["config", "user.name"], { cwd: repoPath }).then((result) => result.stdout.trim()).catch(() => "");
  if (!name) await run("git", ["config", "user.name", "Hearth"], { cwd: repoPath });
  const email = await run("git", ["config", "user.email"], { cwd: repoPath }).then((result) => result.stdout.trim()).catch(() => "");
  if (!email) await run("git", ["config", "user.email", "hearth@users.noreply.github.com"], { cwd: repoPath });
  await run("git", ["remote", "get-url", "origin"], { cwd: repoPath }).catch(() => {
    throw new Error(`克隆仓库后缺少 origin：${repo}`);
  });
}

async function verifyRepositoryState(repoPath: string, branch: string, expectedCommit: string, run: CommandRunner): Promise<void> {
  const currentBranch = (await run("git", ["branch", "--show-current"], { cwd: repoPath })).stdout.trim();
  if (currentBranch !== branch) throw new Error(`本地分支已变化：期望 ${branch}，实际 ${currentBranch || "detached"}`);
  const head = (await run("git", ["rev-parse", "HEAD"], { cwd: repoPath })).stdout.trim();
  if (head !== expectedCommit) throw new Error(`本地提交已变化：期望 ${expectedCommit}，实际 ${head}`);
  const status = (await run("git", ["status", "--porcelain"], { cwd: repoPath })).stdout.trim();
  if (status) throw new Error("仓库存在未提交改动，拒绝推送");
}

async function remoteBranchSha(repo: string, branch: string, run: CommandRunner): Promise<string | null> {
  const result = await run("gh", ["api", `repos/${repo}/git/ref/heads/${branch}`, "--jq", ".object.sha"]);
  const sha = result.stdout.trim();
  return /^[a-f0-9]{40}$/i.test(sha) ? sha : null;
}

async function findOpenPullRequest(repo: string, branch: string, run: CommandRunner): Promise<Record<string, unknown> | null> {
  const result = await run("gh", ["pr", "list", "--repo", repo, "--head", branch, "--state", "open", "--json", "number,url,headRefOid"]);
  const pulls = JSON.parse(result.stdout) as Array<{ number: number; url: string; headRefOid: string }>;
  return pulls[0] ?? null;
}

async function pullRequestDetails(repo: string, branch: string, run: CommandRunner): Promise<{ number: number; url: string }> {
  const result = await run("gh", ["pr", "view", branch, "--repo", repo, "--json", "number,url"]);
  return JSON.parse(result.stdout) as { number: number; url: string };
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const result = value[key];
  if (typeof result !== "string" || !result.trim()) throw new Error(`PR 预览缺少字段：${key}`);
  return result.trim();
}

function requiredTargetString(target: Record<string, unknown>, key: string): string {
  const value = target[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`外部动作缺少参数：${key}`);
  return value.trim();
}

function requiredTargetNumber(target: Record<string, unknown>, key: string): number {
  const value = target[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) throw new Error(`外部动作缺少参数：${key}`);
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function readPrPreview(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}
