import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TaskRecord } from "@hearth/core";

export interface DossierSections {
  overview: string[];
  stack: string[];
  commands: string[];
  conventions: string[];
  decisions: string[];
  openTasks: string[];
  pitfalls: string[];
  evidence: string[];
}

export interface ProjectDossier {
  projectId: string;
  projectName: string;
  projectPath: string;
  generatedAt: string;
  sections: DossierSections;
  markdown: string;
}

export interface CompileDossierInput {
  projectId: string;
  projectName: string;
  projectPath: string;
  tasks: TaskRecord[];
  now?: Date;
  maxItems?: number;
}

export interface ProjectLike {
  id: string;
  name: string;
  path: string;
}

export class DossierError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "DossierError";
    this.code = code;
  }
}

const MAX_ENTRY_CHARS = 280;
const MAX_CONVENTION_CHARS = 3_000;

/**
 * File-backed project dossier. It intentionally stays readable and
 * git-friendly: PROJECT.md is the human view and dossier.json keeps the
 * structured sections used by the coding prompt.
 */
export class DossierStore {
  private readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
  }

  read(projectId: string): ProjectDossier | null {
    const dir = this.projectDir(projectId);
    const jsonPath = join(dir, "dossier.json");
    if (!existsSync(jsonPath)) return null;
    try {
      const parsed = JSON.parse(readFileSync(jsonPath, "utf8")) as Partial<ProjectDossier>;
      if (!parsed.sections || typeof parsed.sections !== "object") return null;
      return normalizeDossier(parsed, projectId);
    } catch {
      return readMarkdownFallback(this.markdownPath(projectId), projectId);
    }
  }

  compile(input: CompileDossierInput): ProjectDossier {
    const now = input.now ?? new Date();
    const limit = Math.max(1, Math.min(20, input.maxItems ?? 8));
    const tasks = [...input.tasks].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const completed = tasks.filter((task) => task.status === "completed");
    const open = tasks.filter((task) => task.status !== "completed" && task.status !== "cancelled");
    const failed = tasks.filter((task) => task.status === "failed" || task.status === "recoverable");
    const sections: DossierSections = {
      overview: [
        `项目：${input.projectName}`,
        `路径：${input.projectPath}`,
        `任务：${tasks.length} 个，完成 ${completed.length} 个，未完成 ${open.length} 个`,
        completed[0] ? `最近完成：${completed[0].title}（${shortDate(completed[0].updatedAt)}）` : "还没有完成记录"
      ],
      stack: detectStack(input.projectPath),
      commands: detectCommands(input.projectPath),
      conventions: readConventions(input.projectPath),
      decisions: completed.slice(0, limit).map((task) =>
        `- ${task.title}：${clip(task.resultSummary || task.goal, MAX_ENTRY_CHARS)}（${shortDate(task.updatedAt)}，task:${task.id}）`
      ),
      openTasks: open.slice(0, limit).map((task) => `- [${task.status}] ${task.title}（${shortDate(task.updatedAt)}，task:${task.id}）`),
      pitfalls: failed.slice(0, limit).map((task) =>
        `- ${task.title}：${clip(task.error?.message || task.resultSummary || "未记录原因", MAX_ENTRY_CHARS)}（task:${task.id}）`
      ),
      evidence: completed.slice(0, limit).map((task) => `- ${task.title} → ${task.outputDir || "(无产物目录)"}（task:${task.id}）`)
    };
    const dossier: ProjectDossier = {
      projectId: input.projectId,
      projectName: input.projectName,
      projectPath: input.projectPath,
      generatedAt: now.toISOString(),
      sections,
      markdown: ""
    };
    dossier.markdown = renderMarkdown(dossier);
    const dir = this.projectDir(input.projectId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "dossier.json"), JSON.stringify(dossier, null, 2), "utf8");
    writeFileSync(join(dir, "PROJECT.md"), dossier.markdown, "utf8");
    return dossier;
  }

  private projectDir(projectId: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(projectId)) throw new DossierError("INVALID_PROJECT_ID", "项目 ID 格式不正确");
    return join(this.rootDir, projectId);
  }

  private markdownPath(projectId: string): string {
    return join(this.projectDir(projectId), "PROJECT.md");
  }
}

export function dossierPromptBlock(dossier: ProjectDossier | null, maxChars = 3_000): string | null {
  if (!dossier) return null;
  const content = dossier.markdown.trim();
  if (!content) return null;
  return `## Project dossier\n${clip(content, maxChars)}`;
}

export function renderMarkdown(dossier: ProjectDossier): string {
  return [
    `# 项目档案：${dossier.projectName}`,
    "",
    `> 自动编译于 ${dossier.generatedAt}。可以人工编辑，下次编译会覆盖自动分节。`,
    "",
    "## 概览",
    ...bulletOrEmpty(dossier.sections.overview),
    "",
    "## 技术栈",
    ...bulletOrEmpty(dossier.sections.stack),
    "",
    "## 命令",
    ...bulletOrEmpty(dossier.sections.commands),
    "",
    "## 约定",
    ...bulletOrEmpty(dossier.sections.conventions),
    "",
    "## 最近决策与结果",
    ...bulletOrEmpty(dossier.sections.decisions),
    "",
    "## 未完成任务",
    ...bulletOrEmpty(dossier.sections.openTasks),
    "",
    "## 坑与失败",
    ...bulletOrEmpty(dossier.sections.pitfalls),
    "",
    "## 证据入口",
    ...bulletOrEmpty(dossier.sections.evidence),
    ""
  ].join("\n");
}

function normalizeDossier(parsed: Partial<ProjectDossier>, projectId: string): ProjectDossier {
  const sections = parsed.sections as Partial<DossierSections>;
  const normalized: DossierSections = {
    overview: strings(sections.overview),
    stack: strings(sections.stack),
    commands: strings(sections.commands),
    conventions: strings(sections.conventions),
    decisions: strings(sections.decisions),
    openTasks: strings(sections.openTasks),
    pitfalls: strings(sections.pitfalls),
    evidence: strings(sections.evidence)
  };
  return {
    projectId,
    projectName: typeof parsed.projectName === "string" ? parsed.projectName : projectId,
    projectPath: typeof parsed.projectPath === "string" ? parsed.projectPath : "",
    generatedAt: typeof parsed.generatedAt === "string" ? parsed.generatedAt : new Date(0).toISOString(),
    sections: normalized,
    markdown: typeof parsed.markdown === "string" && parsed.markdown.trim()
      ? parsed.markdown
      : renderMarkdown({ projectId, projectName: parsed.projectName ?? projectId, projectPath: parsed.projectPath ?? "", generatedAt: parsed.generatedAt ?? "", sections: normalized, markdown: "" })
  };
}

function readMarkdownFallback(path: string, projectId: string): ProjectDossier | null {
  if (!existsSync(path)) return null;
  try {
    const markdown = readFileSync(path, "utf8");
    const sections = parseMarkdownSections(markdown);
    return {
      projectId,
      projectName: markdown.match(/^# 项目档案：(.+)$/m)?.[1]?.trim() ?? projectId,
      projectPath: "",
      generatedAt: new Date(statSync(path).mtimeMs).toISOString(),
      sections,
      markdown
    };
  } catch {
    return null;
  }
}

function parseMarkdownSections(markdown: string): DossierSections {
  const names: Array<[keyof DossierSections, string]> = [
    ["overview", "概览"],
    ["stack", "技术栈"],
    ["commands", "命令"],
    ["conventions", "约定"],
    ["decisions", "最近决策与结果"],
    ["openTasks", "未完成任务"],
    ["pitfalls", "坑与失败"],
    ["evidence", "证据入口"]
  ];
  const sections: DossierSections = {
    overview: [], stack: [], commands: [], conventions: [], decisions: [], openTasks: [], pitfalls: [], evidence: []
  };
  const blocks = markdown.split(/^## /m);
  for (const block of blocks) {
    const line = block.split("\n")[0]?.trim();
    const match = names.find(([, name]) => line === name);
    if (!match) continue;
    sections[match[0]] = block.split("\n").slice(1).map((item) => item.trim()).filter(Boolean);
  }
  return sections;
}

function detectStack(root: string): string[] {
  if (!existsSync(join(root, "package.json"))) return ["未识别到 package.json"];
  try {
    const parsed = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = Object.keys({ ...parsed.dependencies, ...parsed.devDependencies }).slice(0, 10);
    return deps.length ? deps.map((name) => `- ${name}`) : ["- 未声明依赖"];
  } catch {
    return ["package.json 无法解析"];
  }
}

function detectCommands(root: string): string[] {
  if (!existsSync(join(root, "package.json"))) return ["未识别到命令"];
  try {
    const parsed = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    const scripts = Object.entries(parsed.scripts ?? {}).slice(0, 12);
    return scripts.length ? scripts.map(([name, command]) => `- ${name}: ${command}`) : ["未声明脚本"];
  } catch {
    return ["package.json 无法解析"];
  }
}

function readConventions(root: string): string[] {
  const files = [join(root, "AGENTS.md"), join(root, ".hearth", "memory", "MEMORY.md")];
  for (const path of files) {
    if (!existsSync(path)) continue;
    try {
      return [clip(readFileSync(path, "utf8").trim(), MAX_CONVENTION_CHARS)].filter(Boolean);
    } catch {
      // Try the next convention file.
    }
  }
  return ["暂无仓库约定文件（AGENTS.md 或 .hearth/memory/MEMORY.md）"];
}

function bulletOrEmpty(items: string[]): string[] {
  if (!items.length) return ["- （暂无）"];
  return items.map((item) => item.startsWith("- ") || item.startsWith("```") ? item : `- ${item}`);
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function clip(value: string, max: number): string {
  const clean = value.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max)}…`;
}

function shortDate(value: string): string {
  return value.slice(0, 10);
}
