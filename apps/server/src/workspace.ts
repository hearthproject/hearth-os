import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { TaskRecord } from "@hearth/core";

export interface PreparedInput {
  label: string;
  kind: string;
  source: string | null;
  localPath: string;
  sha256: string;
}

export interface PreparedWorkspace {
  root: string;
  outDir: string;
  inputs: PreparedInput[];
}

export class UnsupportedInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedInputError";
  }
}

export function prepareWorkspace(options: {
  repoRoot: string;
  workspaceDir: string;
  task: TaskRecord;
}): PreparedWorkspace {
  const root = resolve(options.workspaceDir);
  const inputsDir = join(root, "inputs");
  const outDir = join(root, "out");
  mkdirSync(inputsDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });

  const prepared: PreparedInput[] = [];
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

    if (input.kind === "url" || input.kind === "github") {
      throw new UnsupportedInputError(`任务输入 ${input.kind} 尚未接入抓取器：${input.value}`);
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

  return { root, outDir, inputs: prepared };
}

export function buildTaskPrompt(
  task: TaskRecord,
  workspace: PreparedWorkspace,
  expectedOutputs: string[],
  acceptance: string[] = []
): string {
  const inputLines = workspace.inputs.map((input) => {
    const source = input.source ? `（原始位置：${input.source}）` : "";
    return `- ${input.label}：${input.localPath}${source}`;
  });
  const outputLines = expectedOutputs.map((output) => `- ${output}`);
  const acceptanceLines = acceptance.map((criterion, index) => `${index + 1}. ${criterion}`);

  return [
    "你是 Hearth 的任务执行器。现在独立完成一个真实工作交付，不要只给建议。",
    "",
    `任务：${task.title}`,
    `目标：${task.goal}`,
    "",
    "已准备的输入文件（只读快照）：",
    ...(inputLines.length > 0 ? inputLines : ["- 无文件输入"]),
    "",
    "输出目录：",
    workspace.outDir,
    "",
    "必须在该输出目录中生成以下内容：",
    ...outputLines,
    "",
    "硬性要求：",
    "1. 只把交付文件写入上面的输出目录；不要修改输入快照或仓库中的其他文件。",
    "2. 不得联网、不得使用网页搜索、不得访问输入中未提供的链接。",
    "3. 不得编造输入中没有的事实；信息不足时，在产物中明确标注“未知”或“待确认”。",
    "4. 保留可核查的来源索引、日期、数字和异常说明。",
    "5. 完成前逐条对照专项验收标准自查，并在产物中保留可核查依据。",
    "6. 最后用中文简短说明完成了什么、哪些内容仍需人工确认。",
    "",
    "专项验收标准（全部必须满足）：",
    ...(acceptanceLines.length > 0 ? acceptanceLines : ["- 按任务目标完整交付，不省略关键内容。"])
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
