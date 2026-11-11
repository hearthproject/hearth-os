import { exec as execCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import picomatch from "picomatch";
import { RE2JS } from "re2js";
import type { TaskPermissions } from "@hearth/core";
import type { AgentTool, AgentToolContext, AgentToolResult } from "./types.ts";

const MAX_READ_BYTES = 2 * 1024 * 1024;
const MAX_LIST_ENTRIES = 500;
const MAX_SEARCH_RESULTS = 100;
const MAX_GLOB_RESULTS = 500;
const MAX_GREP_PATTERN_LENGTH = 500;
const MAX_SCAN_MS = 10_000;
const MAX_FETCH_CHARS = 200_000;
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "coverage", ".next", ".cache", ".turbo"]);

export function createBuiltinTools(): AgentTool[] {
  return [readFileTool, listFilesTool, searchTextTool, globTool, grepTool, writeFileTool, editFileTool, applyPatchTool, shellTool, captureScreenTool, fetchUrlTool, askUserTool, finishTaskTool];
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
    "list_files",
    "search_text",
    "glob",
    "grep",
    "write_file",
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
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件路径，相对于工作区根目录" },
        offset: { type: "number", description: "起始行，从 1 开始" },
        limit: { type: "number", description: "最多读取多少行，默认 400" }
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
    if (stat.size > MAX_READ_BYTES) throw new Error(`文件过大，请先用 search_text 定位：${path}`);
    const lines = readFileSync(target, "utf8").split(/\r?\n/);
    const offset = Math.max(1, intArg(args, "offset", 1));
    const limit = Math.min(2_000, Math.max(1, intArg(args, "limit", 400)));
    const selected = lines.slice(offset - 1, offset - 1 + limit);
    const body = selected.map((line, index) => `${offset + index}: ${line}`).join("\n");
    const more = offset - 1 + limit < lines.length ? `\n... 共 ${lines.length} 行，继续读取请调大 offset` : "";
    return { content: body + more };
  }
};

const listFilesTool: AgentTool = {
  definition: {
    name: "list_files",
    description: "列出工作区内的文件和目录。用于了解工作区结构，默认跳过依赖和构建目录。",
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
    const results: string[] = [];
    search(target, query, maxResults, results);
    return { content: results.length > 0 ? results.join("\n") : `没有找到包含“${query}”的内容` };
  }
};

const globTool: AgentTool = {
  definition: {
    name: "glob",
    description: "按 glob 模式查找工作区文件，返回相对工作区路径。自动跳过依赖、构建和隐藏目录，适合先定位代码或资料。",
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
    const includes = stringArrayArg(args, "include").map(toGlobMatcher);
    const excludes = stringArrayArg(args, "exclude").map(toGlobMatcher);
    const maxResults = Math.min(MAX_SEARCH_RESULTS, Math.max(1, intArg(args, "maxResults", 50)));
    const expression = mode === "literal" ? RE2JS.quote(pattern) : pattern;
    let regex: RE2JS;
    try {
      regex = RE2JS.compile(expression, args.caseSensitive === true ? 0 : RE2JS.CASE_INSENSITIVE);
    } catch (error) {
      throw new Error(`无效的 RE2 正则：${error instanceof Error ? error.message : String(error)}`);
    }
    const deadline = Date.now() + MAX_SCAN_MS;
    const results: string[] = [];
    walkFiles(target, deadline, (file) => {
      const matchPath = stat.isFile() ? basename(file) : relative(target, file).replace(/\\/g, "/");
      const name = basename(file);
      if (includes.length > 0 && !includes.some((matcher) => matcher(matchPath) || matcher(name))) return true;
      if (excludes.some((matcher) => matcher(matchPath) || matcher(name))) return true;
      grepFile(file, context.workspaceRoot, regex, maxResults, results);
      return results.length < maxResults;
    });
    results.sort((left, right) => left.localeCompare(right));
    const suffix = results.length >= maxResults ? `\n... 已达到 ${maxResults} 条上限` : "";
    return { content: results.length > 0 ? `${results.join("\n")}${suffix}` : `没有找到匹配“${pattern}”的内容` };
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
        content: { type: "string", description: "完整文件内容" }
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
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
    return { content: `已写入 ${relative(context.workspaceRoot, target).replace(/\\/g, "/")}（${Buffer.byteLength(content)} 字节）` };
  }
};

const editFileTool: AgentTool = {
  definition: {
    name: "edit_file",
    description: "对授权目录内的文本文件做精确替换。oldText 必须与文件内容完全一致；dryRun 可先查看差异而不写盘。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件路径，相对于工作区根目录" },
        oldText: { type: "string", description: "要被替换的原文" },
        newText: { type: "string", description: "替换后的内容" },
        replaceAll: { type: "boolean", description: "是否替换所有匹配，默认只替换唯一匹配" },
        dryRun: { type: "boolean", description: "只返回差异预览，不修改文件" }
      },
      required: ["path", "oldText", "newText"],
      additionalProperties: false
    }
  },
  async execute(input, context) {
    const args = objectArgs(input);
    const path = stringArg(args, "path");
    const oldText = stringArg(args, "oldText");
    const newText = stringArg(args, "newText", true);
    const replaceAll = args.replaceAll === true;
    const target = resolveSafe(path, context.workspaceRoot, context.permissions.writeRoots);
    assertWritable(target, context.permissions.writeRoots);
    if (!existsSync(target)) throw new Error(`文件不存在：${path}`);
    const content = readFileSync(target, "utf8");
    const count = countOccurrences(content, oldText);
    if (count === 0) throw new Error("没有找到要替换的原文");
    if (count > 1 && !replaceAll) throw new Error(`原文出现 ${count} 次，请提供更长的唯一片段或设置 replaceAll`);
    const next = replaceAll ? content.split(oldText).join(newText) : content.replace(oldText, newText);
    const diff = previewDiff(path, content, next);
    if (args.dryRun === true) return { content: `差异预览（未写入）：\n${diff}` };
    writeFileAtomic(target, next);
    return { content: `已更新 ${path}（替换 ${replaceAll ? count : 1} 处）\n${diff}` };
  }
};

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
    commitFileChanges(changes);
    return { content: `补丁已应用，修改 ${changes.length} 个文件\n${preview}` };
  }
};

const shellTool: AgentTool = {
  definition: {
    name: "shell",
    description: "在授权工作目录内运行一条命令，用于运行测试、检查、脚本，以及 git/gh 等仓库和 GitHub 操作。网络权限由任务授权控制。输出会截断。",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "要运行的命令" },
        cwd: { type: "string", description: "工作目录，默认为工作区根目录" },
        timeoutMs: { type: "number", description: "超时时间，默认 120000" }
      },
      required: ["command"],
      additionalProperties: false
    }
  },
  async execute(input, context) {
    const args = objectArgs(input);
    const command = stringArg(args, "command");
    assertSafeCommand(command, context.permissions.networkHosts.length > 0);
    const cwd = resolveSafe(optionalStringArg(args, "cwd") ?? ".", context.workspaceRoot, context.permissions.readRoots);
    assertReadable(cwd, context.permissions.readRoots);
    const timeoutMs = Math.min(10 * 60_000, Math.max(1_000, intArg(args, "timeoutMs", 120_000)));
    const output = await runCommand(command, cwd, timeoutMs);
    return { content: output || "（命令没有输出）", ...(output.startsWith("命令失败") ? { isError: true } : {}) };
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
    description: "读取一个已授权域名下的网页并返回纯文本。网络默认关闭，只有任务声明的域名可用。",
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
    const response = await fetch(url, {
      redirect: "follow",
      signal: withTimeout(context.signal, 30_000),
      headers: { "user-agent": "Hearth/0.1 (+local agent)" }
    });
    if (!response.ok) throw new Error(`网页返回 HTTP ${response.status}`);
    const finalHost = new URL(response.url).hostname;
    if (!hostAllowed(finalHost, context.permissions.networkHosts)) throw new Error(`重定向到未授权域名：${finalHost}`);
    const html = (await response.text()).slice(0, MAX_FETCH_CHARS);
    const isHtml = /html/i.test(response.headers.get("content-type") ?? "");
    const text = isHtml ? htmlToText(html) : html;
    return { content: text.trim() || "（网页没有文本内容）" };
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
  async execute(input) {
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
  if (!oldText.trim()) return `${content}${newText}`;
  const index = content.indexOf(oldText);
  if (index < 0) throw new Error(`补丁片段未匹配：${oldText.slice(0, 80)}`);
  return content.slice(0, index) + newText + content.slice(index + oldText.length);
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

function assertSafeCommand(command: string, networkAllowed: boolean): void {
  const normalized = command.toLowerCase();
  if (/rm\s+-rf\s+[\/~]|format\s+[a-z]:|shutdown|reboot|stop-computer/.test(normalized)) {
    throw new Error("命令被安全策略拒绝");
  }
  if (!networkAllowed && /(\bgh\b|(?:^|\s)git\s+(?:clone|fetch|pull|push|ls-remote)|curl|wget|invoke-webrequest|ssh|scp|ftp)\b/.test(normalized)) {
    throw new Error("任务没有网络权限，不能运行联网命令");
  }
}

function runCommand(command: string, cwd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolvePromise) => {
    execCallback(command, { cwd, timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      const output = [stdout, stderr].filter(Boolean).join("\n").trim();
      if (error) {
        const detail = output ? `${output}\n${error.message}` : error.message;
        resolvePromise(`命令失败：${detail.slice(-4_000)}`);
      } else {
        resolvePromise(output.slice(-6_000));
      }
    });
  });
}

function hostAllowed(hostname: string, allowed: string[]): boolean {
  const host = hostname.toLowerCase();
  return allowed.some((item) => {
    const allowedHost = item.toLowerCase();
    return host === allowedHost || (allowedHost.startsWith("*.") && host.endsWith(allowedHost.slice(1)));
  });
}

function withTimeout(signal: AbortSignal, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function htmlToText(html: string): string {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? "";
  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return title ? `# ${title}\n\n${body}` : body;
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

function writeFileAtomic(target: string, content: string): void {
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
