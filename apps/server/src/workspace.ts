import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { TaskRecord } from "@hearth/core";
import { getTemplate, type TaskTemplate } from "@hearth/templates";
import {
  prepareGitHubWorkspace,
  type CommandRunner,
  type RepositoryContext
} from "./github.ts";
import { fetchWebSnapshot, WebInputError, type WebSnapshot } from "./web-fetch.ts";
import type { RuntimePreparation } from "./runtime.ts";

export interface PreparedInput {
  label: string;
  kind: string;
  source: string | null;
  localPath: string;
  sha256: string;
  metadata?: Record<string, unknown>;
}

export interface PreparedWorkspace {
  root: string;
  outDir: string;
  inputs: PreparedInput[];
  repository?: RepositoryContext;
}

export class UnsupportedInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedInputError";
  }
}

export async function prepareWorkspace(options: {
  repoRoot: string;
  workspaceDir: string;
  task: TaskRecord;
  webFetch?: typeof fetchWebSnapshot;
  onWebFetch?: (snapshot: WebSnapshot) => void;
  githubRun?: CommandRunner | undefined;
  githubCacheRoot?: string | undefined;
}): Promise<PreparedWorkspace> {
  const root = resolve(options.workspaceDir);
  const inputsDir = join(root, "inputs");
  const outDir = join(root, "out");
  mkdirSync(inputsDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });

  const prepared: PreparedInput[] = [];
  let repository: RepositoryContext | undefined;
  for (const [index, input] of options.task.inputs.entries()) {
    const prefix = `${String(index + 1).padStart(2, "0")}-${slug(input.label)}`;

    if (input.kind === "text") {
      const localPath = join(inputsDir, `${prefix}.txt`);
      writeFileSync(localPath, input.value, "utf8");
      prepared.push({
        label: input.label,
        kind: input.kind,
        source: null,
        localPath,
        sha256: sha256Text(input.value)
      });
      continue;
    }

    if (input.kind === "url") {
      const inputDir = join(inputsDir, prefix);
      mkdirSync(inputDir, { recursive: true });
      let snapshot: WebSnapshot | null = null;
      let fetchFailure: { code: string; message: string; fetchedAt: string; status: number | null; finalUrl: string | null } | null = null;
      try {
        snapshot = await (options.webFetch ?? fetchWebSnapshot)(input.value, {
          allowedHosts: options.task.networkHosts
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const code = error instanceof WebInputError ? error.code : "unknown";
        if (isFatalWebInputError(code)) throw new UnsupportedInputError(`网页输入不可用：${message}`);
        fetchFailure = {
          code,
          message,
          fetchedAt: new Date().toISOString(),
          status: error instanceof WebInputError ? error.status : null,
          finalUrl: error instanceof WebInputError ? error.finalUrl : null
        };
      }
      const localPath = join(inputDir, "page.md");
      if (snapshot) {
        options.onWebFetch?.(snapshot);
        writeFileSync(localPath, snapshot.markdown, "utf8");
        writeFileSync(join(inputDir, "source.json"), `${JSON.stringify({
          requestedUrl: snapshot.requestedUrl,
          finalUrl: snapshot.finalUrl,
          fetchedAt: snapshot.fetchedAt,
          status: snapshot.status,
          contentType: snapshot.contentType,
          title: snapshot.title,
          bytes: snapshot.bytes,
          sha256: snapshot.sha256,
          ok: true
        }, null, 2)}\n`, "utf8");
      } else if (fetchFailure) {
        const failureMarkdown = [
          "# 网页抓取失败",
          "",
          `- 原始 URL：${input.value}`,
          `- 抓取时间：${fetchFailure.fetchedAt}`,
          `- 最终 URL：${fetchFailure.finalUrl ?? "未知（未到达最终页面）"}`,
          `- HTTP 状态：${fetchFailure.status ?? "未知"}`,
          `- 错误代码：${fetchFailure.code}`,
          `- 失败原因：${fetchFailure.message}`,
          "",
          "未获取到该网页正文。禁止根据标题、摘要或常识补写页面内容。"
        ].join("\n");
        writeFileSync(localPath, failureMarkdown, "utf8");
        writeFileSync(join(inputDir, "source.json"), `${JSON.stringify({
          requestedUrl: input.value,
          finalUrl: fetchFailure.finalUrl,
          fetchedAt: fetchFailure.fetchedAt,
          status: fetchFailure.status,
          contentType: null,
          title: null,
          bytes: 0,
          sha256: null,
          ok: false,
          errorCode: fetchFailure.code,
          errorMessage: fetchFailure.message
        }, null, 2)}\n`, "utf8");
      }
      prepared.push({
        label: input.label,
        kind: input.kind,
        source: input.value,
        localPath,
        sha256: sha256File(localPath),
        metadata: {
          ...(snapshot ? {
            ok: true,
            finalUrl: snapshot.finalUrl,
            fetchedAt: snapshot.fetchedAt,
            httpStatus: snapshot.status,
            title: snapshot.title,
            sourceSha256: snapshot.sha256
          } : {
            ok: false,
            finalUrl: fetchFailure?.finalUrl ?? null,
            fetchedAt: fetchFailure?.fetchedAt ?? null,
            httpStatus: fetchFailure?.status ?? null,
            title: null,
            sourceSha256: null,
            errorCode: fetchFailure?.code ?? "unknown",
            errorMessage: fetchFailure?.message ?? "网页抓取失败"
          })
        }
      });
      continue;
    }

    if (input.kind === "github") {
      if (repository) throw new UnsupportedInputError("一个任务只能包含一个 GitHub 仓库输入");
      const template = options.task.templateId ? getTemplate(options.task.templateId) : undefined;
      if (!template?.github) throw new UnsupportedInputError(`模板 ${options.task.templateId ?? "自定义"} 缺少 GitHub 仓库配置`);
      let preparedGitHub;
      try {
        preparedGitHub = await prepareGitHubWorkspace({
          spec: template.github,
          taskId: options.task.id,
          workspaceRoot: root,
          run: options.githubRun,
          cacheRoot: options.githubCacheRoot
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new UnsupportedInputError(`GitHub 输入不可用：${message}`);
      }
      repository = preparedGitHub.repository;
      const inputDir = join(inputsDir, prefix);
      mkdirSync(inputDir, { recursive: true });
      const localPath = join(inputDir, "context.md");
      writeFileSync(localPath, renderGitHubContext(preparedGitHub.context), "utf8");
      writeFileSync(join(inputDir, "context.json"), `${JSON.stringify(preparedGitHub.context, null, 2)}\n`, "utf8");
      prepared.push({
        label: input.label,
        kind: input.kind,
        source: input.value,
        localPath,
        sha256: sha256Text(JSON.stringify(preparedGitHub.context)),
        metadata: {
          repo: preparedGitHub.repository.repo,
          base: preparedGitHub.repository.base,
          branch: preparedGitHub.repository.branch,
          baseSha: preparedGitHub.repository.baseSha,
          headSha: preparedGitHub.repository.headSha
        }
      });
      continue;
    }

    const sourcePath = resolveInside(options.repoRoot, input.value);
    if (!existsSync(sourcePath)) throw new Error(`输入文件不存在：${input.value}`);
    const stat = lstatSync(sourcePath);
    if (!stat.isFile()) throw new Error(`输入必须是普通文件：${input.value}`);

    const inputDir = join(inputsDir, prefix);
    mkdirSync(inputDir, { recursive: true });
    const localPath = join(inputDir, basename(sourcePath));
    copyFileSync(sourcePath, localPath);
    prepared.push({
      label: input.label,
      kind: input.kind,
      source: input.value,
      localPath,
      sha256: sha256File(sourcePath)
    });
  }

  return { root, outDir, inputs: prepared, ...(repository ? { repository } : {}) };
}

export function buildTaskPrompt(
  task: TaskRecord,
  workspace: PreparedWorkspace,
  expectedOutputs: string[],
  acceptance: string[] = [],
  runtime?: RuntimePreparation | null,
  approvalKind?: TaskTemplate["approvalKind"]
): string {
  const inputLines = workspace.inputs.map((input) => {
    const source = input.source ? `（原始位置：${input.source}）` : "";
    return `- ${input.label}：${input.localPath}${source}`;
  });
  const outputLines = expectedOutputs.map((output) => `- ${output}`);
  const acceptanceLines = acceptance.map((criterion, index) => `${index + 1}. ${criterion}`);
  const repositoryLines = workspace.repository ? [
    "",
    "GitHub 隔离仓库：",
    `- 本地路径：${workspace.repository.path}`,
    `- 仓库：${workspace.repository.repo}`,
    `- 当前分支：${workspace.repository.branch}`,
    `- 基础分支：${workspace.repository.base}`,
    `- 检出提交：${workspace.repository.headSha}`,
    `- 这是隔离工作区。不得 push、不得创建 PR、不得评论、不得联网。`,
    workspace.repository.issue
      ? "- 这是实现任务：请在本地完成最小改动、运行相关测试，并创建本地 git commit。最终报告必须写明改动文件、测试命令和真实结果。"
      : "- 这是只读分析任务：不得修改仓库中的任何文件，只读取指定提交并生成报告。",
    workspace.repository.issue
      ? `- pr-preview.json 必须是 JSON 对象，字段 title、body、branch、base 必填；branch 必须为 ${workspace.repository.branch}，base 必须为 ${workspace.repository.base}，body 必须明确链接 Issue #${workspace.repository.issue}。`
      : ""
  ].filter((line) => line !== "") : [];
  const runtimeLines = runtime ? [
    "",
    "预装依赖环境（由 Hearth 宿主完成安装，Codex 不联网）：",
    ...(runtime.python ? [
      `- Python：${runtime.python.version}`,
      `- Python 解释器：${runtime.python.interpreter}`,
      `- Python 工作目录：${runtime.python.workingDirectory}`,
      `- 依赖文件：${runtime.python.requirements.join("、")}`
    ] : []),
    ...(runtime.node ? [
      `- Node 工作目录：${runtime.node.workingDirectory}`,
      `- Node 依赖安装命令：npm ${runtime.node.install}（已由宿主执行）`
    ] : []),
    runtime.ok
      ? "- 依赖已准备完成。直接使用上面的解释器或 node_modules 运行验证，不得再次联网安装。"
      : "- 依赖准备失败。不要尝试联网修复；按验收要求记录环境阻塞、未验证项和需要补充的信息。",
    ...runtime.errors.map((error) => `- 准备错误：${error}`),
    `- 环境记录：${runtime.recordPath}`,
    `- 安装日志：${runtime.logPath}`
  ] : [];
  const approvalLines = approvalKind === "github.comment" ? [
    "",
    "审批发布要求：",
    "- 这是需要用户审批的 GitHub 评论任务。",
    "- `pr-review.md` 中必须把准备发布的评论正文完整放在 `<!-- HEARTH_COMMENT_START -->` 与 `<!-- HEARTH_COMMENT_END -->` 之间。",
    "- 标记之外只放内部说明、证据核验和自查；Hearth 只会在审批卡片和发布动作中使用两个标记之间的正文。"
  ] : [];

  return [
    "你是 Hearth 的任务执行器。现在独立完成一个真实工作交付，不要只给建议。",
    "",
    `任务：${task.title}`,
    `目标：${task.goal}`,
    "",
    "已准备的输入文件（只读快照）：",
    ...(inputLines.length > 0 ? inputLines : ["- 无文件输入"]),
    ...repositoryLines,
    ...runtimeLines,
    ...approvalLines,
    "",
    "输出目录：",
    workspace.outDir,
    "",
    "必须在该输出目录中生成以下内容：",
    ...outputLines,
    "",
    "硬性要求：",
    "1. 交付文件只能写入上面的输出目录；输入快照只读。实现任务只允许修改隔离仓库内完成 Issue 所必需的文件并在本地提交；不得修改依赖目录、环境文件或无关文件。",
    "2. 不得联网、不得使用网页搜索、不得访问输入中未提供的链接。",
    "3. 不得编造输入中没有的事实；信息不足时，在产物中明确标注“未知”或“待确认”。",
    "4. 保留可核查的来源索引、日期、数字和异常说明。",
    "5. 如果网页输入带有 source.json 且 ok 为 false，必须在产物中保留失败状态和原因，不得伪造正文。",
    "6. 完成前逐条对照专项验收标准自查，并在产物中保留可核查依据。",
    "7. 最后用中文简短说明完成了什么、哪些内容仍需人工确认。",
    "",
    "专项验收标准（全部必须满足）：",
    ...(acceptanceLines.length > 0 ? acceptanceLines : ["- 按任务目标完整交付，不省略关键内容。"])
  ].join("\n");
}

export function buildDeliveryRepairPrompt(options: {
  task: TaskRecord;
  prepared: PreparedWorkspace;
  expectedOutputs: string[];
  missing: string[];
}): string {
  return [
    "上一轮执行已经结束，但任务要求的产物没有全部落盘。",
    "请接着当前工作区继续，不要重做已经完成且已验证的工作。",
    "",
    `任务：${options.task.title}`,
    `目标：${options.task.goal}`,
    `工作区：${options.prepared.root}`,
    `输出目录：${options.prepared.outDir}`,
    "",
    "当前缺失或无效的产物：",
    ...options.missing.map((item) => `- ${item}`),
    "",
    "必须补齐的产物：",
    ...options.expectedOutputs.map((item) => `- ${item}`),
    "",
    "补齐规则：",
    "1. 先检查工作区中的 repo、inputs 和 out，确认上一轮已完成哪些工作。",
    "2. 只补缺失产物和完成它们所需的验证；不要撤销正确的代码改动或测试。",
    "3. 产物必须写入上面的输出目录，内容必须来自当前输入和实际执行结果，不能编造。",
    "4. 仍不得联网、推送分支、创建 PR、发布评论或调用其他外部写操作。",
    "5. 完成前逐个确认缺失项已经存在且非空；最后用中文简短说明补了什么、还有哪些未知。"
  ].join("\n");
}

function isFatalWebInputError(code: string): boolean {
  return new Set([
    "invalid_url",
    "unsupported_protocol",
    "credentials_in_url",
    "host_not_allowed",
    "private_host",
    "private_address"
  ]).has(code);
}

function renderGitHubContext(context: Awaited<ReturnType<typeof prepareGitHubWorkspace>>["context"]): string {
  return [
    `# ${context.kind === "issue" ? "Issue" : "Pull Request"} #${context.number}: ${context.title}`,
    "",
    `- 状态：${context.state}`,
    `- 地址：${context.url}`,
    ...(context.labels.length > 0 ? [`- 标签：${context.labels.join("、")}`] : []),
    "",
    "## 正文",
    "",
    context.body || "（无正文）",
    ...(context.checks.length > 0 ? [
      "",
      "## CI 检查",
      "",
      ...context.checks.map((check) => `- ${check.name}：${check.conclusion ?? check.status}${check.url ? `（${check.url}）` : ""}`)
    ] : []),
    ...(context.comments.length > 0 ? [
      "",
      "## 评论",
      "",
      ...context.comments.flatMap((comment, index) => [`### 评论 ${index + 1}`, "", comment.body || "（空）", ""])
    ] : [])
  ].join("\n");
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function resolveInside(root: string, candidate: string): string {
  const resolvedRoot = resolve(root);
  const resolved = resolve(resolvedRoot, candidate);
  const rel = relative(resolvedRoot, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`路径越界：${candidate}`);
  return resolved;
}

function slug(value: string): string {
  return value.replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "input";
}
