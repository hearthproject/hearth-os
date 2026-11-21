import { exec as execCallback, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import picomatch from "picomatch";
import { RE2JS } from "re2js";
import type { TaskPermissions } from "@hearth/core";
import type { DocumentBlockInput, SpreadsheetSheetInput } from "./documents.ts";
import type { AgentTool, AgentToolContext, AgentToolResult } from "./types.ts";
import { fetchWebSnapshot } from "./web-fetch.ts";
import { applyEdit, findEditMatch, normalizeFile, restoreFile } from "./harness/edit-match.ts";
import { omissionPlaceholderError } from "./harness/omission.ts";
import { createMemoryTools } from "./harness/memory.ts";
import { createGoalTools } from "./harness/goal.ts";
import { searchFiles } from "./harness/search.ts";
import { fileReadState, hashContent, rangesCover, recordCommand, recordFileModified, recordFileRead, requireReadBeforeWrite } from "./harness/file-state.ts";
import { recordCreatedFile, recordSnapshotAfterMutation, rewindTool, rewindTurnTool, snapshotBeforeMutation } from "./harness/snapshots.ts";
import { killShellSession, runShellSession, shellOutput, shellSessionInfo, startShellSession, waitShellSession } from "./harness/shell-session.ts";
import { truncateToolOutput, writeFullToolOutput } from "./harness/tool-output.ts";
import { commandPolicyIssue } from "./harness/command-policy.ts";
import { todoReadTool, todoWriteTool } from "./harness/todo.ts";
import { submitPlanTool } from "./harness/plan.ts";
import { diagnosticsTool, runTestsTool } from "./harness/verification.ts";
import { finishActiveWork, runningActiveWork, startActiveWork } from "./harness/active-work.ts";

const MAX_READ_BYTES = 2 * 1024 * 1024;
const MAX_LIST_ENTRIES = 500;
const MAX_SEARCH_RESULTS = 100;
const MAX_GLOB_RESULTS = 500;
const MAX_GREP_PATTERN_LENGTH = 500;
const MAX_SCAN_MS = 10_000;
const MAX_SHELL_OUTPUT_CHARS = 8_000;
const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;
const MAX_DOCUMENT_OUTPUT_CHARS = 200_000;
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "coverage", ".next", ".cache", ".turbo"]);


//模型能使用的工具和实现
export function createBuiltinTools(): AgentTool[] {
  return [readFileTool, readToolOutputTool, readDocumentTool, listFilesTool, searchTextTool, globTool, grepTool, writeFileTool, writeSpreadsheetTool, writeDocumentTool, editFileTool, applyPatchTool, shellTool, shellOutputTool, shellWaitTool, shellKillTool, todoWriteTool, todoReadTool, runTestsTool, diagnosticsTool, submitPlanTool, rewindTool, rewindTurnTool, captureScreenTool, fetchUrlTool, askUserTool, finishTaskTool, ...createMemoryTools(), ...createGoalTools()];
}

export function defaultTaskPermissions(options: {
  workspaceRoot: string;
  outDir: string;
  networkHosts: string[];
  extraTools?: string[];
  writeRoots?: string[];
}): TaskPermissions {
  const tools = [
    "read_file",
    "read_document",
    "list_files",
    "search_text",
    "glob",
    "grep",
    "write_file",
    "write_spreadsheet",
    "write_document",
    "edit_file",
    "apply_patch",
    "ask_user",
    "finish_task",
    ...(options.networkHosts.length > 0 ? ["fetch_url"] : []),
    ...(options.extraTools ?? [])
  ];
  return {
    readRoots: [options.workspaceRoot],
    writeRoots: options.writeRoots ?? [options.outDir],
    networkHosts: [...options.networkHosts],
    tools: [...new Set(tools)]
  };
}

const readFileTool: AgentTool = {
  definition: {
    name: "read_file",
    description: "读取工作区内一个文本文件的内容。返回带行号的文本，适合查看输入材料、代码和已有产物。",
    executionMode: "parallel",
    effect: "read",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件路径，相对于工作区根目录" },
        offset: { type: "number", description: "起始行，从 1 开始" },
        limit: { type: "number", description: "最多读取多少行，默认 400" },
        force: { type: "boolean", description: "即使与上次读取内容相同也重新返回正文" }
      },
      required: ["path"],
      additionalProperties: false
    }
  },
  async execute(input, context) {
    const args = objectArgs(input);
    const path = stringArg(args, "path");
    const target = resolveSafe(path, context.workspaceRoot, context.permissions.readRoots);
    assertReadable(target, context.permissions.readRoots);
    if (!existsSync(target)) throw new Error(missingPathError(path, target, context.workspaceRoot));
    const stat = lstatSync(target);
    if (!stat.isFile()) throw new Error(`不是普通文件：${path}`);
    if (stat.size > MAX_READ_BYTES) throw new Error(`文件过大，请先用 search_text 定位：${path}`);
    const buffer = readFileSync(target);
    if (looksBinary(buffer)) throw new Error(`文件疑似二进制内容，read_file 只返回文本：${path}。如需解析文档请用 read_document，或先用 list_files 确认路径。`);
    const content = buffer.toString("utf8");
    const lines = content.replace(/\uFEFF/, "").split(/\r?\n/);
    const offset = Math.max(1, intArg(args, "offset", 1));
    const limit = Math.min(2_000, Math.max(1, intArg(args, "limit", 400)));
    const selected = lines.slice(offset - 1, offset - 1 + limit);
    const endLine = offset + selected.length - 1;
    const previous = fileReadState(context, target);
    if (args.force !== true && selected.length > 0 && previous?.hash === hashContent(content) && rangesCover(previous.ranges, offset, endLine)) {
      return {
        content: `${path} 自上次读取后未变化，第 ${offset}-${endLine} 行已在上下文中。如需重新查看正文，请传 force=true；如需其他片段，请调整 offset/limit。`,
        metadata: { unchanged: true }
      };
    }
    recordFileRead(context.state, target, content, selected.length > 0 ? [{ start: offset, end: endLine }] : []);
    const body = selected.map((line, index) => `${offset + index}: ${line}`).join("\n");
    const more = endLine < lines.length ? `\n... 共 ${lines.length} 行，继续读取请调大 offset` : "";
    return { content: body + more, ...(more ? { metadata: { truncated: true } } : {}) };
  }
};

const readToolOutputTool: AgentTool = {
  definition: {
    name: "read_tool_output",
    description: "分段读取被截断的工具完整输出。可传 callId 或 tool-results 目录下的 path；每次最多返回 8000 字符。",
    executionMode: "parallel",
    effect: "read",
    parameters: {
      type: "object",
      properties: {
        callId: { type: "string", description: "产生该输出的 tool call ID" },
        path: { type: "string", description: "完整输出路径，通常由工具结果中的 full output 提示给出" },
        offset: { type: "number", description: "从第几个字符开始，默认 0" },
        limit: { type: "number", description: "最多读取多少字符，默认 8000，上限 16000" }
      },
      additionalProperties: false
    }
  },
  async execute(input, context) {
    const args = objectArgs(input);
    const callId = typeof args.callId === "string" ? args.callId.trim() : "";
    const explicitPath = typeof args.path === "string" ? args.path.trim() : "";
    const tracked = callId ? context.state?.toolOutputs?.[callId]?.path : undefined;
    const path = explicitPath || tracked;
    if (!path) throw new Error("read_tool_output 需要 path 或已知的 callId");
    const root = resolve(context.outDir, ".hearth", "tool-results");
    const target = isAbsolute(path) ? resolve(path) : resolve(context.outDir, path);
    const rootKey = root.toLowerCase();
    const targetKey = target.toLowerCase();
    if (targetKey !== rootKey && !targetKey.startsWith(`${rootKey}${sep}`)) {
      throw new Error(`read_tool_output 只能读取 ${root} 下的工具输出`);
    }
    if (!existsSync(target)) throw new Error(`工具输出不存在或已被清理：${path}`);
    const content = readFileSync(target, "utf8");
    const offset = Math.max(0, intArg(args, "offset", 0));
    const limit = Math.min(16_000, Math.max(1, intArg(args, "limit", 8_000)));
    if (offset >= content.length) return { content: `offset ${offset} 已超过总长度 ${content.length}`, metadata: { eof: true, totalChars: content.length } };
    const end = Math.min(content.length, offset + limit);
    const body = content.slice(offset, end);
    return {
      content: `${body}${end < content.length ? `\n... 已读取 ${offset}-${end} / ${content.length} 字符，继续时 offset=${end}` : ""}`,
      metadata: { offset, end, totalChars: content.length, ...(end < content.length ? { truncated: true } : {}) }
    };
  }
};

const readDocumentTool: AgentTool = {
  definition: {
    name: "read_document",
    description: "读取 PDF、DOCX、XLSX、CSV、JSON、HTML 或文本资料并返回 Markdown。支持页码、工作表和覆盖缺口说明。",
    executionMode: "parallel",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件路径，相对于工作区根目录" },
        maxChars: { type: "number", description: "最多返回多少字符，默认 80000，最大 200000" }
      },
      required: ["path"],
      additionalProperties: false
    }
  },
  async execute(input, context) {
    const args = objectArgs(input);
    const path = stringArg(args, "path");
    const target = resolveSafe(path, context.workspaceRoot, context.permissions.readRoots);
    assertReadable(target, context.permissions.readRoots);
    if (!existsSync(target)) throw new Error(`文件不存在：${path}`);
    const stat = lstatSync(target);
    if (!stat.isFile()) throw new Error(`不是普通文件：${path}`);
    if (stat.size > MAX_DOCUMENT_BYTES) throw new Error(`文档过大，最大支持 ${MAX_DOCUMENT_BYTES / 1024 / 1024}MB：${path}`);
    const { extractSourceBytes } = await import("./documents.ts");
    const extracted = await extractSourceBytes(readFileSync(target), basename(target));
    const maxChars = Math.min(MAX_DOCUMENT_OUTPUT_CHARS, Math.max(1_000, intArg(args, "maxChars", 80_000)));
    const markdown = extracted.markdown.length > maxChars
      ? `${extracted.markdown.slice(0, maxChars)}\n\n... 文档内容已截断，请缩小资料范围或分段处理`
      : extracted.markdown;
    const gaps = extracted.coverage.gaps.length > 0 ? `\n覆盖缺口：${extracted.coverage.gaps.join("；")}` : "";
    return { content: `文档：${extracted.title ?? basename(target)}${gaps}\n\n${markdown}` };
  }
};

const listFilesTool: AgentTool = {
  definition: {
    name: "list_files",
    description: "列出工作区内的文件和目录。用于了解工作区结构，默认跳过依赖和构建目录。",
    executionMode: "parallel",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "起始目录，默认工作区根目录" },
        depth: { type: "number", description: "递归深度，默认 3，最大 6" }
      },
      additionalProperties: false
    }
  },
  async execute(input, context) {
    const args = objectArgs(input);
    const path = optionalStringArg(args, "path") ?? ".";
    const target = resolveSafe(path, context.workspaceRoot, context.permissions.readRoots);
    assertReadable(target, context.permissions.readRoots);
    if (!existsSync(target)) throw new Error(`目录不存在：${path}`);
    const depth = Math.min(6, Math.max(1, intArg(args, "depth", 3)));
    const entries: string[] = [];
    walk(target, target, depth, entries);
    return { content: entries.length > 0 ? entries.join("\n") : "（目录为空）" };
  }
};

const searchTextTool: AgentTool = {
  definition: {
    name: "search_text",
    description: "在工作区文本文件中搜索关键词，返回文件路径、行号和匹配行。",
    executionMode: "parallel",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "要搜索的文字，不区分大小写" },
        path: { type: "string", description: "搜索目录，默认工作区根目录" },
        maxResults: { type: "number", description: "最多返回多少条，默认 50" }
      },
      required: ["query"],
      additionalProperties: false
    }
  },
  async execute(input, context) {
    const args = objectArgs(input);
    const query = stringArg(args, "query").toLowerCase();
    const path = optionalStringArg(args, "path") ?? ".";
    const target = resolveSafe(path, context.workspaceRoot, context.permissions.readRoots);
    assertReadable(target, context.permissions.readRoots);
    const maxResults = Math.min(MAX_SEARCH_RESULTS, Math.max(1, intArg(args, "maxResults", 50)));
    try {
      const result = searchFiles({
        pattern: stringArg(args, "query"),
        root: context.workspaceRoot,
        path: target,
        literal: true,
        ignoreCase: true,
        maxResults,
        timeoutMs: MAX_SCAN_MS
      });
      if (result.matches.length === 0) return { content: `没有找到包含“${stringArg(args, "query")}”的内容`, metadata: { truncated: result.truncated } };
      const rendered = result.matches.map((match) => `${match.file}:${match.line}: ${match.text}`);
      return {
        content: `${rendered.join("\n")}${result.truncated ? `\n... 已达到 ${maxResults} 条上限` : ""}`,
        metadata: { truncated: result.truncated }
      };
    } catch (error) {
      throw new Error(`搜索失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
};

const globTool: AgentTool = {
  definition: {
    name: "glob",
    description: "按 glob 模式查找工作区文件，返回相对工作区路径。自动跳过依赖、构建和隐藏目录，适合先定位代码或资料。",
    executionMode: "parallel",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "glob 模式，例如 **/*.ts 或 docs/**/*.md" },
        path: { type: "string", description: "搜索起始目录，默认工作区根目录" },
        maxResults: { type: "number", description: "最多返回多少条，默认 200，最大 500" }
      },
      required: ["pattern"],
      additionalProperties: false
    }
  },
  async execute(input, context) {
    const args = objectArgs(input);
    const pattern = stringArg(args, "pattern");
    if (pattern.length > MAX_GREP_PATTERN_LENGTH) throw new Error(`glob 模式过长，最多 ${MAX_GREP_PATTERN_LENGTH} 个字符`);
    const path = optionalStringArg(args, "path") ?? ".";
    const target = resolveSafe(path, context.workspaceRoot, context.permissions.readRoots);
    assertReadable(target, context.permissions.readRoots);
    if (!existsSync(target)) throw new Error(`路径不存在：${path}`);
    const stat = lstatSync(target);
    if (!stat.isFile() && !stat.isDirectory()) throw new Error(`不是普通文件或目录：${path}`);
    const maxResults = Math.min(MAX_GLOB_RESULTS, Math.max(1, intArg(args, "maxResults", 200)));
    const matcher = toGlobMatcher(pattern);
    const deadline = Date.now() + MAX_SCAN_MS;
    const results: string[] = [];
    walkFiles(target, deadline, (file) => {
      const matchPath = stat.isFile() ? basename(file) : relative(target, file).replace(/\\/g, "/");
      if (matcher(matchPath)) {
        results.push(relative(context.workspaceRoot, file).replace(/\\/g, "/"));
      }
      return results.length < maxResults;
    });
    results.sort((left, right) => left.localeCompare(right));
    const suffix = results.length >= maxResults ? `\n... 已达到 ${maxResults} 条上限` : "";
    return { content: results.length > 0 ? `${results.join("\n")}${suffix}` : `没有文件匹配：${pattern}` };
  }
};

const grepTool: AgentTool = {
  definition: {
    name: "grep",
    description: "用 RE2 兼容正则或字面量搜索工作区文本文件，支持 include/exclude glob 过滤。返回相对工作区路径、行号和匹配行。",
    executionMode: "parallel",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "要搜索的文本或 RE2 正则，不支持反向引用和环视" },
        path: { type: "string", description: "搜索起始目录或文件，默认工作区根目录" },
        mode: { type: "string", enum: ["regex", "literal"], description: "匹配模式，默认 regex" },
        include: { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }], description: "只搜索匹配这些 glob 的文件" },
        exclude: { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }], description: "排除匹配这些 glob 的文件" },
        caseSensitive: { type: "boolean", description: "是否区分大小写，默认 false" },
        maxResults: { type: "number", description: "最多返回多少条，默认 50，最大 100" }
      },
      required: ["pattern"],
      additionalProperties: false
    }
  },
  async execute(input, context) {
    const args = objectArgs(input);
    const pattern = stringArg(args, "pattern");
    if (pattern.length > MAX_GREP_PATTERN_LENGTH) throw new Error(`搜索模式过长，最多 ${MAX_GREP_PATTERN_LENGTH} 个字符`);
    const mode = optionalStringArg(args, "mode") ?? "regex";
    if (mode !== "regex" && mode !== "literal") throw new Error(`不支持的匹配模式：${mode}`);
    const path = optionalStringArg(args, "path") ?? ".";
    const target = resolveSafe(path, context.workspaceRoot, context.permissions.readRoots);
    assertReadable(target, context.permissions.readRoots);
    if (!existsSync(target)) throw new Error(`路径不存在：${path}`);
    const stat = lstatSync(target);
    if (!stat.isFile() && !stat.isDirectory()) throw new Error(`不是普通文件或目录：${path}`);
    const includes = stringArrayArg(args, "include");
    const excludes = stringArrayArg(args, "exclude");
    const maxResults = Math.min(MAX_SEARCH_RESULTS, Math.max(1, intArg(args, "maxResults", 50)));
    let result;
    try {
      result = searchFiles({
        pattern,
        root: context.workspaceRoot,
        path: target,
        ...(includes.length ? { include: includes } : {}),
        ...(excludes.length ? { exclude: excludes } : {}),
        literal: mode === "literal",
        ignoreCase: args.caseSensitive !== true,
        maxResults,
        timeoutMs: MAX_SCAN_MS
      });
    } catch (error) {
      throw new Error(`无效的 RE2 正则：${error instanceof Error ? error.message : String(error)}`);
    }
    const rendered = result.matches.map((match) => `${match.file}:${match.line}: ${match.text}`).sort((left, right) => left.localeCompare(right));
    const suffix = result.truncated ? `\n... 已达到 ${maxResults} 条上限（${result.backend}）` : "";
    return {
      content: rendered.length > 0 ? `${rendered.join("\n")}${suffix}` : `没有找到匹配“${pattern}”的内容`,
      metadata: { truncated: result.truncated }
    };
  }
};

const writeFileTool: AgentTool = {
  definition: {
    name: "write_file",
    description: "在授权目录内创建或覆盖一个文本文件。创建用户需要的最终产物时使用。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件路径，相对于工作区根目录" },
        content: { type: "string", description: "完整文件内容" },
        overwrite: { type: "boolean", description: "已存在且未读取的文件必须显式覆盖；默认 false" }
      },
      required: ["path", "content"],
      additionalProperties: false
    }
  },
  async execute(input, context) {
    const args = objectArgs(input);
    const path = stringArg(args, "path");
    const content = stringArg(args, "content", true);
    const target = resolveSafe(path, context.workspaceRoot, context.permissions.writeRoots);
    assertWritable(target, context.permissions.writeRoots);
    const existed = existsSync(target);
    if (existed && args.overwrite !== true) {
      const issue = requireReadBeforeWrite(context, target);
      if (issue) throw new Error(issue);
    }
    const snapshotId = existed ? snapshotBeforeMutation(context, target) : null;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
    recordFileModified(context.state, target, content);
    if (snapshotId) recordSnapshotAfterMutation(context, target, snapshotId);
    else recordCreatedFile(context, target, !existed);
    return {
      content: `已写入 ${relative(context.workspaceRoot, target).replace(/\\/g, "/")}（${Buffer.byteLength(content)} 字节）`,
      metadata: { filesChanged: [relative(context.workspaceRoot, target).replace(/\\/g, "/")], ...(snapshotId ? { snapshotId } : {}) }
    };
  }
};

const writeSpreadsheetTool: AgentTool = {
  definition: {
    name: "write_spreadsheet",
    description: "生成 XLSX 表格。每个工作表提供名称和二维行数据，第一行作为表头并加粗。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "输出 .xlsx 路径，相对于工作区根目录" },
        sheets: {
          type: "array",
          description: "工作表列表",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "工作表名称" },
              rows: {
                type: "array",
                items: { type: "array", items: { type: ["string", "number", "boolean", "null"] } }
              }
            },
            required: ["name", "rows"],
            additionalProperties: false
          }
        }
      },
      required: ["path", "sheets"],
      additionalProperties: false
    }
  },
  async execute(input, context) {
    const args = objectArgs(input);
    const path = stringArg(args, "path");
    if (!path.toLowerCase().endsWith(".xlsx")) throw new Error("表格输出必须使用 .xlsx 扩展名");
    const target = resolveSafe(path, context.workspaceRoot, context.permissions.writeRoots);
    assertWritable(target, context.permissions.writeRoots);
    const { writeSpreadsheetBytes } = await import("./documents.ts");
    const bytes = await writeSpreadsheetBytes(spreadsheetSheetsArg(args.sheets));
    writeFileAtomic(target, bytes);
    return { content: `已生成表格 ${relative(context.workspaceRoot, target).replace(/\\/g, "/")}（${bytes.byteLength} 字节）` };
  }
};

const writeDocumentTool: AgentTool = {
  definition: {
    name: "write_document",
    description: "生成 DOCX 文档。支持标题、段落、项目符号和编号列表；标题层级为 1-6。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "输出 .docx 路径，相对于工作区根目录" },
        title: { type: "string", description: "文档标题" },
        blocks: {
          type: "array",
          description: "文档段落列表",
          items: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["heading", "paragraph", "bullet", "numbered"] },
              text: { type: "string" },
              level: { type: "number", description: "标题或列表层级" }
            },
            required: ["type", "text"],
            additionalProperties: false
          }
        }
      },
      required: ["path", "blocks"],
      additionalProperties: false
    }
  },
  async execute(input, context) {
    const args = objectArgs(input);
    const path = stringArg(args, "path");
    if (!path.toLowerCase().endsWith(".docx")) throw new Error("文档输出必须使用 .docx 扩展名");
    const target = resolveSafe(path, context.workspaceRoot, context.permissions.writeRoots);
    assertWritable(target, context.permissions.writeRoots);
    const { writeDocumentBytes } = await import("./documents.ts");
    const bytes = await writeDocumentBytes(optionalStringArg(args, "title") ?? null, documentBlocksArg(args.blocks));
    writeFileAtomic(target, bytes);
    return { content: `已生成文档 ${relative(context.workspaceRoot, target).replace(/\\/g, "/")}（${bytes.byteLength} 字节）` };
  }
};

const editFileTool: AgentTool = {
  definition: {
    name: "edit_file",
    description: "Edit a text file with one or more replacements. Matching tolerates CRLF, indentation and minor whitespace drift; all edits are atomic and the original is snapshotted.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件路径，相对于工作区根目录" },
        oldText: { type: "string", description: "要被替换的原文（单次编辑时使用）" },
        newText: { type: "string", description: "替换后的内容（单次编辑时使用）" },
        edits: {
          type: "array",
          description: "多次替换；按顺序应用，任一失败则全部不写盘",
          items: {
            type: "object",
            properties: {
              oldText: { type: "string" },
              newText: { type: "string" },
              replaceAll: { type: "boolean" }
            },
            required: ["oldText", "newText"],
            additionalProperties: false
          }
        },
        replaceAll: { type: "boolean", description: "单次编辑时替换所有精确匹配" },
        dryRun: { type: "boolean", description: "只返回差异预览，不修改文件" },
        expectedHash: { type: "string", description: "可选：读取时的内容哈希前缀；文件已被外部修改时拒绝" }
      },
      required: ["path"],
      additionalProperties: false
    }
  },
  async execute(input, context) {
    const args = objectArgs(input);
    const path = stringArg(args, "path");
    const target = resolveSafe(path, context.workspaceRoot, context.permissions.writeRoots);
    assertWritable(target, context.permissions.writeRoots);
    if (!existsSync(target)) throw new Error(`文件不存在：${path}`);
    const issue = requireReadBeforeWrite(context, target);
    if (issue) throw new Error(issue);
    const raw = readFileSync(target, "utf8");
    if (typeof args.expectedHash === "string" && args.expectedHash && !hashContent(raw).startsWith(args.expectedHash)) {
      throw new Error(`文件内容与 expectedHash 不匹配，可能已被外部修改：${path}`);
    }
    const normalized = normalizeFile(raw);
    const edits = editRequests(args);
    if (edits.length === 0) throw new Error("没有提供 oldText/newText 或 edits");
    let next = normalized.text;
    let applied = 0;
    for (const edit of edits) {
      const placeholderIssue = omissionPlaceholderError(edit.oldText);
      if (placeholderIssue) throw new Error(placeholderIssue);
      if (edit.replaceAll) {
        const count = countOccurrences(next, edit.oldText);
        if (count === 0) throw new Error(editFailure(next, edit.oldText));
        next = next.split(edit.oldText).join(edit.newText.replace(/\r\n/g, "\n"));
        applied += count;
        continue;
      }
      const match = findEditMatch(next, edit.oldText);
      if (!("start" in match)) throw new Error(match.error);
      next = applyEdit(next, match, edit.newText);
      applied += 1;
    }
    const nextRaw = restoreFile({ ...normalized, text: next });
    const diff = previewDiff(path, raw, nextRaw);
    if (args.dryRun === true) return { content: `差异预览（未写入）：\n${diff}` };
    const snapshotId = snapshotBeforeMutation(context, target);
    writeFileAtomic(target, nextRaw);
    recordFileModified(context.state, target, nextRaw);
    if (snapshotId) recordSnapshotAfterMutation(context, target, snapshotId);
    const relativePath = relative(context.workspaceRoot, target).replace(/\\/g, "/");
    return {
      content: `已更新 ${relativePath}（${applied} 处）\n${diff}`,
      metadata: {
        filesChanged: [relativePath],
        diff,
        ...(snapshotId ? { snapshotId } : {})
      }
    };
  }
};

function editRequests(args: Record<string, unknown>): Array<{ oldText: string; newText: string; replaceAll: boolean }> {
  const edits: Array<{ oldText: string; newText: string; replaceAll: boolean }> = [];
  if (Array.isArray(args.edits)) {
    for (const value of args.edits) {
      if (!value || typeof value !== "object") continue;
      const record = value as Record<string, unknown>;
      if (typeof record.oldText !== "string" || typeof record.newText !== "string") continue;
      edits.push({ oldText: record.oldText, newText: record.newText, replaceAll: record.replaceAll === true });
    }
    return edits;
  }
  if (typeof args.oldText === "string" && typeof args.newText === "string") {
    edits.push({ oldText: args.oldText, newText: args.newText, replaceAll: args.replaceAll === true });
  }
  return edits;
}

function editFailure(content: string, oldText: string): string {
  const match = findEditMatch(content, oldText);
  return "start" in match ? "没有唯一匹配" : match.error;
}

function missingPathError(path: string, target: string, workspaceRoot: string): string {
  const suggestions: string[] = [];
  try {
    const directory = dirname(target);
    const wanted = basename(target).toLowerCase();
    const wantedStem = basename(target, extname(target)).toLowerCase();
    for (const name of readdirSync(directory)) {
      const candidate = name.toLowerCase();
      const stem = basename(name, extname(name)).toLowerCase();
      if (candidate === wanted || editDistance(wanted, candidate) <= 2 || (wantedStem.length >= 3 && stem === wantedStem)) {
        suggestions.push(relative(workspaceRoot, join(directory, name)).replace(/\\/g, "/"));
      }
    }
  } catch {
    // The parent may not exist; fall through to the generic hint.
  }
  if (suggestions.length > 0) {
    return `文件不存在：${path}。是否想找：${[...new Set(suggestions)].slice(0, 5).join("、")}？`;
  }
  return `文件不存在：${path}。请先用 list_files 或 glob 确认工作区内的真实路径，不要猜测文件名。`;
}

function editDistance(left: string, right: string): number {
  if (left === right) return 0;
  if (left.length === 0) return right.length;
  if (right.length === 0) return left.length;
  let previous = Array.from({ length: right.length + 1 }, (_value, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= right.length; column += 1) {
      const cost = left[row - 1] === right[column - 1] ? 0 : 1;
      current[column] = Math.min(
        (current[column - 1] ?? 0) + 1,
        (previous[column] ?? 0) + 1,
        (previous[column - 1] ?? 0) + cost
      );
    }
    previous = current;
  }
  return previous[right.length] ?? 0;
}

function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 4_096);
  if (sample.length === 0) return false;
  if (sample.includes(0)) return true;
  let control = 0;
  for (const byte of sample) {
    if (byte < 7 || (byte > 13 && byte < 32)) control += 1;
  }
  return control / sample.length > 0.3;
}

const applyPatchTool: AgentTool = {
  definition: {
    name: "apply_patch",
    description: "按补丁格式修改一个或多个文本文件。支持 *** Update File、*** Move to、*** Add File、*** Delete File；全部操作预校验通过后才原子提交。",
    parameters: {
      type: "object",
      properties: {
        patch: { type: "string", description: "补丁正文；行首用 + / - / 空格表示新增、删除和上下文" },
        dryRun: { type: "boolean", description: "只返回差异预览，不修改文件" }
      },
      required: ["patch"],
      additionalProperties: false
    }
  },
  async execute(input, context) {
    const args = objectArgs(input);
    const patch = stringArg(args, "patch", true);
    const operations = parsePatch(patch);
    if (operations.length === 0) throw new Error("补丁没有包含任何文件操作");
    const current = new Map<string, string | null>();
    const originals = new Map<string, string | null>();
    const readState = (target: string, displayPath: string): string | null => {
      if (!current.has(target)) {
        let value: string | null = null;
        if (existsSync(target)) {
          const stat = lstatSync(target);
          if (!stat.isFile()) throw new Error(`不是普通文件：${displayPath}`);
          value = readFileSync(target, "utf8");
        }
        current.set(target, value);
        originals.set(target, value);
      }
      return current.get(target) ?? null;
    };
    const writeState = (target: string, content: string): void => {
      readState(target, target);
      current.set(target, content);
    };
    for (const operation of operations) {
      const target = resolveSafe(operation.path, context.workspaceRoot, context.permissions.writeRoots);
      assertWritable(target, context.permissions.writeRoots);
      if (operation.type === "add") {
        if (readState(target, operation.path) !== null) throw new Error(`文件已存在，不能重复添加：${operation.path}`);
        writeState(target, operation.content);
        continue;
      }
      if (operation.type === "delete") {
        if (readState(target, operation.path) === null) throw new Error(`文件不存在：${operation.path}`);
        current.set(target, null);
        continue;
      }
      const original = readState(target, operation.path);
      if (original === null) throw new Error(`文件不存在：${operation.path}`);
      const issue = requireReadBeforeWrite(context, target);
      if (issue) throw new Error(issue);
      let content = original;
      for (const hunk of operation.hunks) content = applyHunk(content, hunk);
      if (operation.moveTo) {
        const destination = resolveSafe(operation.moveTo, context.workspaceRoot, context.permissions.writeRoots);
        assertWritable(destination, context.permissions.writeRoots);
        if (readState(destination, operation.moveTo) !== null) throw new Error(`移动目标已存在：${operation.moveTo}`);
        writeState(destination, content);
        current.set(target, null);
      } else {
        current.set(target, content);
      }
    }
    const changes = [...current.entries()]
      .filter(([target, content]) => content !== (originals.get(target) ?? null))
      .map(([target, content]) => ({ target, content, previous: originals.get(target) ?? null }));
    const preview = changes.map((change) => {
      const path = relative(context.workspaceRoot, change.target).replace(/\\/g, "/");
      return previewDiff(path, change.previous ?? "", change.content ?? "");
    }).join("\n");
    if (changes.length === 0) return { content: "补丁没有产生文件变化" };
    if (args.dryRun === true) return { content: `差异预览（未写入，${changes.length} 个文件）：\n${preview}` };
    const snapshotIds: string[] = [];
    const snapshotByTarget = new Map<string, string>();
    for (const change of changes) {
      if (change.previous !== null) {
        const snapshotId = snapshotBeforeMutation(context, change.target);
        if (snapshotId) {
          snapshotIds.push(snapshotId);
          snapshotByTarget.set(change.target, snapshotId);
        }
      }
    }
    commitFileChanges(changes);
    for (const change of changes) {
      recordFileModified(context.state, change.target, change.content ?? "");
      const snapshotId = snapshotByTarget.get(change.target);
      if (snapshotId) recordSnapshotAfterMutation(context, change.target, snapshotId);
      else recordCreatedFile(context, change.target, change.previous === null);
    }
    return {
      content: `补丁已应用，修改 ${changes.length} 个文件\n${preview}`,
      metadata: {
        filesChanged: changes.map((change) => relative(context.workspaceRoot, change.target).replace(/\\/g, "/")),
        diff: preview,
        ...(snapshotIds.length ? { snapshotIds } : {})
      }
    };
  }
};

const shellTool: AgentTool = {
  definition: {
    name: "shell",
    description: "Run a shell command in the workspace. Use background=true for servers, watchers and long builds; use shell_output to inspect and shell_kill to stop. Foreground timeouts are migrated to a background session instead of being killed.",
    executionMode: "sequential",
    timeoutMs: 10 * 60_000,
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "要运行的命令" },
        cwd: { type: "string", description: "工作目录，默认为工作区根目录" },
        timeoutMs: { type: "number", description: "前台等待超时，默认 120000；超时后进程转后台，不会被杀掉" },
        yieldMs: { type: "number", description: "前台等待多少毫秒后返回增量输出，默认等待到退出或超时" },
        background: { type: "boolean", description: "立即后台启动，返回 sessionId" },
        env: { type: "object", description: "附加环境变量", additionalProperties: { type: "string" } },
        stdin: { type: "string", description: "写入 stdin 后关闭（用于交互式命令）" }
      },
      required: ["command"],
      additionalProperties: false
    }
  },
  async execute(input, context) {
    const args = objectArgs(input);
    const command = stringArg(args, "command");
    assertSafeCommand(command, context.permissions.networkHosts.length > 0);
    const policy = commandPolicyIssue(command, { fullAccess: context.fullAccess === true, planMode: context.mode === "plan" });
    if (policy) throw new Error(policy);
    const cwd = resolveSafe(optionalStringArg(args, "cwd") ?? ".", context.workspaceRoot, context.permissions.readRoots);
    assertReadable(cwd, context.permissions.readRoots);
    const env = stringRecord(args.env);
    const stdin = optionalStringArg(args, "stdin");
    const sandbox = context.sandbox;
    const unsafeNoSandbox = !sandbox && context.permissions.sandboxMode === "danger-full-access";
    if (!sandbox && !unsafeNoSandbox) throw new Error("native shell 缺少沙箱配置；请检查任务执行策略");
    const shellOptions = {
      command,
      cwd,
      outDir: context.outDir,
      ...(env ? { env } : {}),
      ...(stdin !== undefined ? { stdin } : {}),
      ...(sandbox ? { sandbox } : {}),
      ...(unsafeNoSandbox ? { unsafeNoSandbox: true } : {}),
      onStarted: ({ sessionId }: { sessionId: string }) => {
        startActiveWork(context.state, { id: sessionId, kind: "shell", label: command });
      },
      onExit: ({ sessionId, exitCode }: { sessionId: string; exitCode: number | null }) => {
        finishActiveWork(context.state, sessionId, exitCode === 0 ? "completed" : "failed", exitCode);
      }
    };
    if (args.background === true) {
      const started = await startShellSession(shellOptions);
      recordCommand(context.state, command, null, isTestCommand(command));
      return {
        content: `已在后台启动：${command}\nsessionId=${started.sessionId}\noutput=${started.outputPath}${started.sandbox ? `\nsandbox=${started.sandbox.backend}/${started.sandbox.enforcement}` : ""}`,
        metadata: { sessionId: started.sessionId, background: true, fullOutputPath: started.outputPath, ...(started.sandbox ? { sandbox: started.sandbox } : {}) }
      };
    }
    const timeoutMs = Math.min(10 * 60_000, Math.max(1_000, intArg(args, "timeoutMs", 120_000)));
    const yieldMs = Math.min(timeoutMs, Math.max(0, intArg(args, "yieldMs", timeoutMs)));
    const result = await runShellSession({ ...shellOptions, timeoutMs: yieldMs });
    recordCommand(context.state, command, result.exitCode, isTestCommand(command));
    const truncated = truncateToolOutput(result.output, { maxChars: MAX_SHELL_OUTPUT_CHARS, maxLines: 240, label: "use shell_output or a narrower command" });
    const fullPath = truncated.truncated ? result.outputPath : undefined;
    const status = result.running
      ? `still running in background (session ${result.sessionId}); use shell_output to inspect, shell_kill to stop`
      : `exit ${result.exitCode ?? "unknown"}`;
    const sandboxFailure = result.sandboxFailure;
    const failureNote = sandboxFailure === "denied"
      ? "\n\n[SANDBOX_DENIED] 路径不在任务写入范围；请调整项目/任务范围后重新发起任务，不要重试该命令。"
      : sandboxFailure === "runner_failure"
        ? "\n\n[SANDBOX_UNAVAILABLE] Windows ACL runner 失败；任务需要重新发起或检查打包资源。"
        : "";
    return {
      content: `$ ${command}\n${status} (${result.durationMs}ms)\n\n${truncated.content}${failureNote}${fullPath ? `\n\n[full output: ${fullPath.replace(/\\/g, "/")}]` : ""}`,
      isError: result.running ? false : result.exitCode !== 0 || sandboxFailure !== null,
      metadata: {
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        sessionId: result.sessionId,
        background: result.running,
        truncated: truncated.truncated,
        ...(fullPath ? { fullOutputPath: fullPath } : {}),
        ...(result.sandbox ? { sandbox: result.sandbox } : {}),
        ...(sandboxFailure ? { sandboxFailure } : {})
      }
    };
  }
};

const shellOutputTool: AgentTool = {
  definition: {
    name: "shell_output",
    description: "Read incremental output from a background or still-running shell session.",
    executionMode: "parallel",
    parameters: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "shell 返回的 sessionId" },
        offset: { type: "number", description: "从第几个字符开始读取；默认 0 返回全部缓冲" }
      },
      required: ["sessionId"],
      additionalProperties: false
    }
  },
  async execute(input) {
    const args = objectArgs(input);
    const sessionId = stringArg(args, "sessionId");
    const output = shellOutput(sessionId, intArg(args, "offset", 0));
    if (!output) throw new Error(`找不到 shell session：${sessionId}`);
    const truncated = truncateToolOutput(output.output, { maxChars: MAX_SHELL_OUTPUT_CHARS, maxLines: 240, label: "read with a larger offset or narrower output" });
    return {
      content: `session ${sessionId}: ${output.running ? "running" : `exit ${output.exitCode ?? "unknown"}`}\n\n${truncated.content}`,
      metadata: { sessionId, background: output.running, exitCode: output.exitCode, truncated: truncated.truncated, ...(output.outputPath ? { fullOutputPath: output.outputPath } : {}) }
    };
  }
};

const shellWaitTool: AgentTool = {
  definition: {
    name: "shell_wait",
    description: "Wait for a background shell to exit, match output, or time out instead of busy-polling.",
    executionMode: "sequential",
    parameters: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "shell 返回的 sessionId" },
        timeoutSeconds: { type: "number", description: "最长等待秒数，默认 30，最大 600" },
        match: { type: "string", description: "可选的正则或字面文本；出现即提前返回" }
      },
      required: ["sessionId"],
      additionalProperties: false
    }
  },
  async execute(input) {
    const args = objectArgs(input);
    const sessionId = stringArg(args, "sessionId");
    const timeoutSeconds = Math.min(600, Math.max(1, intArg(args, "timeoutSeconds", 30)));
    const match = typeof args.match === "string" && args.match.length > 0 ? args.match : undefined;
    const result = await waitShellSession(sessionId, { timeoutMs: timeoutSeconds * 1_000, ...(match ? { match } : {}) });
    if (!result) throw new Error(`找不到 shell session：${sessionId}`);
    const status = result.running
      ? result.matched ? "running (match found)" : `running (timeout after ${timeoutSeconds}s)`
      : `exit ${result.exitCode ?? "unknown"}`;
    const truncated = truncateToolOutput(result.output, { maxChars: MAX_SHELL_OUTPUT_CHARS, maxLines: 240, label: "use shell_output for the full buffer" });
    const failureNote = result.sandboxFailure === "denied"
      ? "\n\n[SANDBOX_DENIED] 路径不在任务写入范围；不要重试该命令。"
      : result.sandboxFailure === "runner_failure"
        ? "\n\n[SANDBOX_UNAVAILABLE] Windows ACL runner 失败。"
        : "";
    return {
      content: `session ${sessionId}: ${status}\n\n${truncated.content}${failureNote}`,
      isError: result.sandboxFailure !== null || (!result.running && result.exitCode !== 0),
      metadata: { sessionId, background: result.running, exitCode: result.exitCode, truncated: truncated.truncated, matched: result.matched, timedOut: result.timedOut, ...(result.sandbox ? { sandbox: result.sandbox } : {}), ...(result.sandboxFailure ? { sandboxFailure: result.sandboxFailure } : {}), ...(result.outputPath ? { fullOutputPath: result.outputPath } : {}) }
    };
  }
};

const shellKillTool: AgentTool = {
  definition: {
    name: "shell_kill",
    description: "Stop a background shell session and its process tree.",
    executionMode: "sequential",
    parameters: {
      type: "object",
      properties: { sessionId: { type: "string" } },
      required: ["sessionId"],
      additionalProperties: false
    }
  },
  async execute(input) {
    const args = objectArgs(input);
    const sessionId = stringArg(args, "sessionId");
    const info = shellSessionInfo(sessionId);
    if (!info) throw new Error(`找不到 shell session：${sessionId}`);
    killShellSession(sessionId);
    return { content: `已停止 session ${sessionId}（${info.command}）。`, metadata: { sessionId } };
  }
};

const captureScreenTool: AgentTool = {
  definition: {
    name: "capture_screen",
    description: "截取当前电脑桌面并保存为 PNG。仅支持 Windows，默认保存到输出目录的 desktop.png。",
    parameters: {
      type: "object",
      properties: {
        fileName: { type: "string", description: "输出文件名，必须位于输出目录且以 .png 结尾，默认 desktop.png" }
      },
      additionalProperties: false
    }
  },
  async execute(input, context) {
    if (process.platform !== "win32") throw new Error("桌面截图目前只支持 Windows");
    const args = objectArgs(input);
    const fileName = optionalStringArg(args, "fileName") ?? "desktop.png";
    if (!fileName.toLowerCase().endsWith(".png")) throw new Error("截图文件名必须以 .png 结尾");
    const target = resolveSafe(fileName, context.outDir, context.permissions.writeRoots);
    assertWritable(target, context.permissions.writeRoots);
    mkdirSync(dirname(target), { recursive: true });
    await captureWindowsScreen(target, context.signal);
    const saved = relative(context.outDir, target).replace(/\\/g, "/");
    return { content: `桌面截图已保存：${saved}` };
  }
};

const fetchUrlTool: AgentTool = {
  definition: {
    name: "fetch_url",
    description: "读取一个已授权域名下的网页并返回 Markdown。服务端会校验重定向、DNS 和内网地址；网络默认关闭。",
    executionMode: "parallel",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "http 或 https 网址" }
      },
      required: ["url"],
      additionalProperties: false
    }
  },
  async execute(input, context) {
    const args = objectArgs(input);
    const url = stringArg(args, "url");
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("只支持 http 或 https 网址");
    if (!hostAllowed(parsed.hostname, context.permissions.networkHosts)) {
      throw new Error(`域名未授权：${parsed.hostname}`);
    }
    const snapshot = await fetchWebSnapshot(url, {
      allowedHosts: context.permissions.networkHosts,
      timeoutMs: 30_000,
      signal: context.signal
    });
    return { content: `# ${snapshot.title}\n\n来源：${snapshot.finalUrl}\n\n${snapshot.markdown}` };
  }
};

const askUserTool: AgentTool = {
  definition: {
    name: "ask_user",
    description: "只有在缺少无法自行合理假设的关键信息时才使用。会暂停任务并等待用户补充。",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "用中文提出一个具体问题" }
      },
      required: ["question"],
      additionalProperties: false
    }
  },
  async execute(input) {
    const args = objectArgs(input);
    const question = stringArg(args, "question");
    return { content: `需要用户补充：${question}`, action: "ask_user", question };
  }
};

const finishTaskTool: AgentTool = {
  definition: {
    name: "finish_task",
    description: "任务真正完成时调用。summary 写给用户看的中文结果，outputs 列出已生成的产物相对路径。",
    parameters: {
      type: "object",
      properties: {
        summary: { type: "string", description: "面向用户的完成结果，简洁说明完成了什么" },
        outputs: { type: "array", items: { type: "string" }, description: "产物文件路径列表" }
      },
      required: ["summary"],
      additionalProperties: false
    }
  },
  async execute(input, context) {
    const active = runningActiveWork(context.state);
    if (active.length > 0) {
      throw new Error([
        "还有后台工作未结束，不能调用 finish_task。",
        ...active.map((work) => `- ${work.kind} ${work.id}${work.label ? `：${work.label}` : ""}`),
        "请先用 shell_wait / shell_kill / agent_wait / agent_kill 处理，或等待它们结束。"
      ].join("\n"));
    }
    const args = objectArgs(input);
    const summary = stringArg(args, "summary");
    const outputs = Array.isArray(args.outputs) ? args.outputs.filter((item): item is string => typeof item === "string") : [];
    return { content: summary, action: "finish", summary, outputs };
  }
};

function resolveSafe(candidate: string, base: string, roots: string[]): string {
  const target = isAbsolute(candidate) ? resolve(candidate) : resolve(base, candidate);
  for (const root of roots) {
    const resolvedRoot = resolve(root);
    if (target === resolvedRoot || target.startsWith(resolvedRoot + sep)) return target;
  }
  throw new Error(`路径不在授权范围内：${candidate}`);
}

function assertReadable(target: string, roots: string[]): void {
  if (!roots.length) throw new Error("没有读取权限");
  const root = roots.find((item) => target === resolve(item) || target.startsWith(resolve(item) + sep));
  if (!root) throw new Error(`路径不在读取范围内：${target}`);
  const realRoot = canonicalPath(root);
  const realTarget = canonicalPath(target);
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + sep)) throw new Error(`路径通过符号链接越界：${target}`);
}

function assertWritable(target: string, roots: string[]): void {
  if (!roots.length) throw new Error("没有写入权限");
  const root = roots.find((item) => target === resolve(item) || target.startsWith(resolve(item) + sep));
  if (!root) throw new Error(`路径不在写入范围内：${target}`);
  const realRoot = canonicalPath(root);
  const realTarget = canonicalPath(target);
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + sep)) throw new Error(`路径通过符号链接越界：${target}`);
}

function canonicalPath(path: string): string {
  let probe = resolve(path);
  const tail: string[] = [];
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) break;
    tail.unshift(basename(probe));
    probe = parent;
  }
  const real = existsSync(probe) ? realpathSync(probe) : probe;
  return resolve(real, ...tail);
}

function objectArgs(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("工具参数必须是对象");
  return input as Record<string, unknown>;
}

function stringArg(args: Record<string, unknown>, key: string, allowEmpty = false): string {
  const value = args[key];
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) throw new Error(`缺少参数：${key}`);
  return value;
}

function optionalStringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function intArg(args: Record<string, unknown>, key: string, fallback: number): number {
  const value = Number(args[key]);
  return Number.isFinite(value) ? Math.trunc(value) : fallback;
}

function stringArrayArg(args: Record<string, unknown>, key: string): string[] {
  const value = args[key];
  const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return values.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
}

function spreadsheetSheetsArg(value: unknown): SpreadsheetSheetInput[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("sheets 必须是非空数组");
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`第 ${index + 1} 个工作表参数无效`);
    const sheet = entry as Record<string, unknown>;
    const name = stringArg(sheet, "name");
    if (!Array.isArray(sheet.rows)) throw new Error(`工作表 ${name} 缺少 rows 数组`);
    const rows = sheet.rows.map((row, rowIndex) => {
      if (!Array.isArray(row)) throw new Error(`工作表 ${name} 第 ${rowIndex + 1} 行必须是数组`);
      return row.map((cell, columnIndex) => {
        if (cell === null || typeof cell === "string" || typeof cell === "number" || typeof cell === "boolean") return cell;
        throw new Error(`工作表 ${name} 第 ${rowIndex + 1} 行第 ${columnIndex + 1} 列类型不受支持`);
      });
    });
    return { name, rows };
  });
}

function documentBlocksArg(value: unknown): DocumentBlockInput[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("blocks 必须是非空数组");
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`第 ${index + 1} 个文档段落参数无效`);
    const block = entry as Record<string, unknown>;
    const type = stringArg(block, "type");
    if (type !== "heading" && type !== "paragraph" && type !== "bullet" && type !== "numbered") throw new Error(`不支持的文档段落类型：${type}`);
    return {
      type,
      text: stringArg(block, "text", true),
      ...(block.level === undefined ? {} : { level: intArg(block, "level", 1) })
    };
  });
}

function toGlobMatcher(pattern: string): (candidate: string) => boolean {
  if (pattern.length > MAX_GREP_PATTERN_LENGTH) throw new Error(`glob 模式过长，最多 ${MAX_GREP_PATTERN_LENGTH} 个字符`);
  return picomatch(pattern.replace(/\\/g, "/"), { dot: false, nocase: process.platform === "win32" });
}

function walkFiles(root: string, deadline: number, visit: (file: string) => boolean): void {
  const ensureTime = () => {
    if (Date.now() > deadline) throw new Error(`文件扫描超过 ${MAX_SCAN_MS / 1_000} 秒预算，请缩小搜索范围`);
  };
  ensureTime();
  const rootStat = lstatSync(root);
  if (rootStat.isFile()) {
    visit(root);
    return;
  }
  if (!rootStat.isDirectory()) throw new Error(`不是普通文件或目录：${root}`);
  const visitDirectory = (directory: string): boolean => {
    ensureTime();
    let children;
    try {
      children = readdirSync(directory, { withFileTypes: true });
    } catch {
      return true;
    }
    for (const child of children) {
      ensureTime();
      if (child.name.startsWith(".") || SKIP_DIRS.has(child.name)) continue;
      const absolute = resolve(directory, child.name);
      if (child.isDirectory()) {
        if (!visitDirectory(absolute)) return false;
      } else if (child.isFile() && !visit(absolute)) {
        return false;
      }
    }
    return true;
  };
  visitDirectory(root);
}

function grepFile(file: string, root: string, regex: RE2JS, maxResults: number, results: string[]): void {
  if (!isTextExtension(extname(file).toLowerCase())) return;
  try {
    if (statSync(file).size > MAX_READ_BYTES) return;
    const content = readFileSync(file, "utf8");
    if (content.includes("\u0000")) return;
    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length && results.length < maxResults; index += 1) {
      const line = lines[index] ?? "";
      if (regex.matcher(line).find()) {
        results.push(`${relative(root, file).replace(/\\/g, "/")}:${index + 1}: ${line.trim().slice(0, 240)}`);
      }
    }
  } catch {
    // Ignore unreadable files during search.
  }
}

function walk(root: string, directory: string, depth: number, entries: string[]): void {
  if (entries.length >= MAX_LIST_ENTRIES) return;
  let children;
  try {
    children = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const child of children) {
    if (entries.length >= MAX_LIST_ENTRIES) return;
    if (child.name.startsWith(".") || SKIP_DIRS.has(child.name)) continue;
    const absolute = resolve(directory, child.name);
    const rel = relative(root, absolute).replace(/\\/g, "/");
    if (child.isDirectory()) {
      entries.push(`${rel}/`);
      if (depth > 1) walk(root, absolute, depth - 1, entries);
    } else if (child.isFile()) {
      entries.push(rel);
    }
  }
}

function search(directory: string, query: string, maxResults: number, results: string[]): void {
  if (results.length >= maxResults) return;
  if (existsSync(directory) && lstatSync(directory).isFile()) {
    searchFile(directory, directory, query, maxResults, results);
    return;
  }
  let children;
  try {
    children = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const child of children) {
    if (results.length >= maxResults) return;
    if (child.name.startsWith(".") || SKIP_DIRS.has(child.name)) continue;
    const absolute = resolve(directory, child.name);
    if (child.isDirectory()) search(absolute, query, maxResults, results);
    else if (child.isFile()) searchFile(absolute, directory, query, maxResults, results);
  }
}

function searchFile(file: string, root: string, query: string, maxResults: number, results: string[]): void {
  const extension = extname(file).toLowerCase();
  if (!isTextExtension(extension)) return;
  try {
    if (statSync(file).size > MAX_READ_BYTES) return;
    const content = readFileSync(file, "utf8");
    if (content.includes("\u0000")) return;
    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length && results.length < maxResults; index += 1) {
      const line = lines[index] ?? "";
      if (line.toLowerCase().includes(query)) {
        results.push(`${relative(root, file).replace(/\\/g, "/")}:${index + 1}: ${line.trim().slice(0, 240)}`);
      }
    }
  } catch {
    // Ignore unreadable files during search.
  }
}

function isTextExtension(extension: string): boolean {
  return extension === "" || [".md", ".txt", ".json", ".jsonl", ".csv", ".tsv", ".ts", ".tsx", ".js", ".jsx", ".css", ".html", ".xml", ".yml", ".yaml", ".toml", ".ini", ".log", ".py", ".sh", ".ps1", ".sql"].includes(extension);
}

function parsePatch(patch: string): Array<
  | { type: "update"; path: string; hunks: string[][]; moveTo?: string }
  | { type: "add"; path: string; content: string }
  | { type: "delete"; path: string }
> {
  const lines = patch.replace(/\r\n/g, "\n").split("\n");
  const operations: Array<
    | { type: "update"; path: string; hunks: string[][]; moveTo?: string }
    | { type: "add"; path: string; content: string }
    | { type: "delete"; path: string }
  > = [];
  let current: { type: "update"; path: string; hunks: string[][]; moveTo?: string } | { type: "add"; path: string; lines: string[] } | { type: "delete"; path: string } | null = null;
  for (const line of lines) {
    if (line.startsWith("*** Update File: ")) {
      current = { type: "update", path: line.slice("*** Update File: ".length).trim(), hunks: [] };
      operations.push(current);
      continue;
    }
    if (line.startsWith("*** Add File: ")) {
      current = { type: "add", path: line.slice("*** Add File: ".length).trim(), lines: [] };
      operations.push({ type: "add", path: current.path, content: "" });
      continue;
    }
    if (line.startsWith("*** Delete File: ")) {
      current = { type: "delete", path: line.slice("*** Delete File: ".length).trim() };
      operations.push(current);
      continue;
    }
    if (line.startsWith("*** Move to: ") && current?.type === "update") {
      current.moveTo = line.slice("*** Move to: ".length).trim();
      continue;
    }
    if (line === "*** End Patch" || line === "*** Begin Patch") continue;
    if (!current) continue;
    if (current.type === "update") {
      if (line.startsWith("@@")) {
        current.hunks.push([]);
      } else if (current.hunks.length > 0 && /^[+\- ]/.test(line)) {
        current.hunks.at(-1)?.push(line);
      }
    } else if (current.type === "add") {
      const target = operations.find((operation) => operation.type === "add" && operation.path === current?.path);
      if (target?.type === "add" && line.startsWith("+")) target.content += `${line.slice(1)}\n`;
    }
  }
  return operations;
}

function applyHunk(content: string, hunk: string[]): string {
  const oldLines: string[] = [];
  const newLines: string[] = [];
  for (const line of hunk) {
    const marker = line.charAt(0);
    const rest = line.slice(1);
    if (marker !== "+") oldLines.push(rest);
    if (marker !== "-") newLines.push(rest);
  }
  const oldText = oldLines.join("\n");
  const newText = newLines.join("\n");
  const hadCrlf = content.includes("\r\n");
  const normalized = content.replace(/\r\n/g, "\n");
  if (!oldText.trim()) {
    const appended = `${normalized}${newText}`;
    return hadCrlf ? appended.replace(/\n/g, "\r\n") : appended;
  }
  const placeholderIssue = omissionPlaceholderError(oldText, "补丁片段");
  if (placeholderIssue) throw new Error(placeholderIssue);
  const match = findEditMatch(normalized, oldText);
  if (!("start" in match)) throw new Error(`补丁片段未匹配：${match.error}`);
  const result = applyEdit(normalized, match, newText);
  return hadCrlf ? result.replace(/\n/g, "\r\n") : result;
}

function captureWindowsScreen(target: string, signal: AbortSignal): Promise<void> {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -AssemblyName System.Drawing",
    "$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen",
    "$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height",
    "$graphics = [System.Drawing.Graphics]::FromImage($bitmap)",
    "$graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bounds.Size)",
    `$bitmap.Save('${target.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)`,
    "$graphics.Dispose()",
    "$bitmap.Dispose()"
  ].join("; ");
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return new Promise((resolvePromise, reject) => {
    execCallback(
      `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`,
      { timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true, signal },
      (error, stdout, stderr) => {
        if (error) {
          const detail = [stderr, stdout, error.message].filter(Boolean).join("\n").trim();
          reject(new Error(`桌面截图失败：${detail.slice(-2_000)}`));
          return;
        }
        resolvePromise();
      }
    );
  });
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === "string") result[key] = item;
  }
  return Object.keys(result).length ? result : undefined;
}

function isTestCommand(command: string): boolean {
  return /(^|\s)(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\b(pytest|vitest|jest|go test|cargo test|mvn test|gradlew test|rspec|phpunit|dotnet test|ctest)\b/i.test(command);
}

function assertSafeCommand(command: string, networkAllowed: boolean): void {
  const normalized = command.toLowerCase();
  if (/rm\s+-rf\s+[\/~]|format\s+[a-z]:|shutdown|reboot|stop-computer/.test(normalized)) {
    throw new Error("命令被安全策略拒绝");
  }
  if (!networkAllowed && /(\bgh\b|(?:^|\s)git\s+(?:clone|fetch|pull|push|ls-remote)|curl|wget|invoke-webrequest|ssh|scp|ftp)\b/.test(normalized)) {
    throw new Error("任务没有网络权限，不能运行联网命令");
  }
}

function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal,
  workspaceRoot: string
): Promise<{ content: string; isError: boolean }> {
  return new Promise((resolvePromise) => {
    const logDirectory = join(workspaceRoot, ".hearth", "shell");
    mkdirSync(logDirectory, { recursive: true });
    const logPath = join(logDirectory, `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}.log`);
    const log = createWriteStream(logPath, { flags: "a", encoding: "utf8" });
    log.on("error", () => undefined);
    log.write(`$ ${command}\n# cwd: ${cwd}\n# started: ${new Date().toISOString()}\n\n`);
    const logLabel = relative(workspaceRoot, logPath).replace(/\\/g, "/");
    let tail = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let spawnError: Error | null = null;
    const capture = (chunk: Buffer | string): void => {
      const text = chunk.toString();
      log.write(text);
      tail = `${tail}${text}`.slice(-MAX_SHELL_OUTPUT_CHARS * 2);
    };
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child.pid);
    }, timeoutMs);
    const onAbort = (): void => {
      aborted = true;
      killProcessTree(child.pid);
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    child.on("error", (error) => {
      spawnError = error;
    });
    child.on("close", (code, closeSignal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      const footer = `\n\n# exited: ${new Date().toISOString()}\n# code: ${code ?? "null"} signal: ${closeSignal ?? "none"} timeout: ${timedOut} aborted: ${aborted}\n`;
      const complete = (content: string, isError: boolean): void => {
        log.end(footer, () => resolvePromise({ content, isError }));
      };
      const detail = tail.trim();
      const logNotice = `完整日志：${logLabel}`;
      if (timedOut) {
        complete(`命令失败：执行超过 ${timeoutMs}ms，进程树已终止。\n${detail ? `${detail.slice(-4_000)}\n` : ""}${logNotice}`, true);
        return;
      }
      if (aborted) {
        complete(`命令失败：任务已取消，进程树已终止。\n${logNotice}`, true);
        return;
      }
      if (spawnError) {
        complete(`命令失败：${spawnError.message}\n${logNotice}`, true);
        return;
      }
      if (code !== 0) {
        complete(`命令失败：退出码 ${code ?? "unknown"}${closeSignal ? `，信号 ${closeSignal}` : ""}\n${detail ? `${detail.slice(-4_000)}\n` : ""}${logNotice}`, true);
        return;
      }
      complete(`${detail ? detail.slice(-MAX_SHELL_OUTPUT_CHARS) : "（命令没有输出）"}\n${logNotice}`, false);
    });
  });
}

function killProcessTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The process may already have exited.
    }
  }
}

function hostAllowed(hostname: string, allowed: string[]): boolean {
  const host = hostname.toLowerCase();
  if (allowed.includes("*")) return true;
  return allowed.some((item) => {
    const allowedHost = item.toLowerCase();
    return host === allowedHost || (allowedHost.startsWith("*.") && host.endsWith(allowedHost.slice(1)));
  });
}

function countOccurrences(content: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = content.indexOf(needle);
  while (index >= 0) {
    count += 1;
    index = content.indexOf(needle, index + needle.length);
  }
  return count;
}

function writeFileAtomic(target: string, content: string | Uint8Array): void {
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, "utf8");
    renameSync(temporary, target);
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}

function commitFileChanges(changes: Array<{ target: string; content: string | null; previous: string | null }>): void {
  const staged = new Map<string, string>();
  let committing = false;
  try {
    for (const change of changes) {
      if (change.content === null) continue;
      mkdirSync(dirname(change.target), { recursive: true });
      const temporary = `${change.target}.${randomUUID()}.tmp`;
      writeFileSync(temporary, change.content, "utf8");
      staged.set(change.target, temporary);
    }
    committing = true;
    for (const change of changes) {
      if (change.content === null) {
        unlinkSync(change.target);
      } else {
        renameSync(staged.get(change.target)!, change.target);
        staged.delete(change.target);
      }
    }
  } catch (error) {
    if (committing) {
      for (const change of [...changes].reverse()) {
        try {
          if (change.previous === null) {
            if (existsSync(change.target)) unlinkSync(change.target);
          } else {
            writeFileAtomic(change.target, change.previous);
          }
        } catch {
          // Keep the original failure and best-effort rollback.
        }
      }
    }
    throw error;
  } finally {
    for (const temporary of staged.values()) {
      try {
        if (existsSync(temporary)) unlinkSync(temporary);
      } catch {
        // Ignore temporary cleanup failures.
      }
    }
  }
}

function previewDiff(path: string, before: string, after: string): string {
  if (before === after) return "";
  const oldLines = before === "" ? [] : before.replace(/\r\n/g, "\n").split("\n");
  const newLines = after === "" ? [] : after.replace(/\r\n/g, "\n").split("\n");
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) suffix += 1;
  const removed = oldLines.slice(prefix, oldLines.length - suffix);
  const added = newLines.slice(prefix, newLines.length - suffix);
  const start = prefix + 1;
  const lines = [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${start},${removed.length} +${start},${added.length} @@`,
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`)
  ];
  const text = lines.join("\n");
  return text.length > 4_000 ? `${text.slice(0, 4_000)}\n... 差异已截断` : text;
}
