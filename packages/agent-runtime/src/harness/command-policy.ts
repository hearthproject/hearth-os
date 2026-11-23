import { planModeAllowsCommand } from "./plan.ts";

const DESTRUCTIVE = [
  /\brm\s+-[a-z]*r[a-z]*f?[a-z]*\s+(?:--\S+\s+)*(?:\/|~|\*)(?:\s|$)/i,
  /\bremove-item\b[\s\S]*(?:-recurse|-force)\b/i,
  /\b(?:rd|rmdir)\s+\/[sq]\b/i,
  /\bdel\s+\/[a-z]*[fsq][a-z]*\b/i,
  /\bclear-content\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-[a-z]*f[a-z]*d?x?[a-z]*\b/i,
  /\bgit\s+push\b.*--force\b/i,
  /\bmkfs(\.|\s)/i,
  /\bdd\s+if=/i,
  /\bshutdown\b|\breboot\b|\bstop-computer\b|\brestart-computer\b/i,
  /\bformat\s+[a-z]:|\bformat-volume\b/i,
  /\bdiskpart\b|\bclear-disk\b|\binitialize-disk\b|\bremove-partition\b/i,
  /\bbcdedit\b|\bvssadmin\s+delete\b|\btakeown\b|\bicacls\b|\breg\s+delete\b|\bschtasks\s+\/delete\b/i,
  /\btaskkill\b[\s\S]*\/f\b[\s\S]*\/im\b/i
];

const SENSITIVE = [
  /\bgit\s+push\b/i,
  /\bgit\s+reset\b/i,
  /\bgit\s+clean\b/i,
  /\bnpm\s+publish\b/i,
  /\bpnpm\s+publish\b/i,
  /\byarn\s+npm\s+publish\b/i,
  /\bgh\s+pr\s+(create|merge)\b/i,
  /\bgh\s+release\s+create\b/i,
  /\bterraform\s+(apply|destroy)\b/i,
  /\bkubectl\s+(apply|delete|scale)\b/i
];

export type ShellCommandClass = "read-only" | "mutating" | "destructive" | "unknown";

export interface ShellClassification {
  kind: ShellCommandClass;
  reason: string;
  command: string;
}

const READ_ONLY_COMMANDS = new Set([
  "ls", "dir", "pwd", "cat", "type", "head", "tail", "wc", "stat", "file", "du", "df", "tree",
  "rg", "grep", "findstr", "where", "which", "whoami", "hostname", "date", "uname", "env",
  "get-childitem", "gci", "get-content", "gc", "get-location", "get-item", "get-command",
  "test-path", "resolve-path", "select-string", "write-output", "echo", "sort", "uniq", "cut"
]);

const MUTATING_COMMANDS = new Set([
  "mkdir", "md", "touch", "cp", "copy", "copy-item", "mv", "move", "move-item", "rename", "ren",
  "sed", "awk", "tee", "out-file", "set-content", "sc", "add-content", "ac", "new-item", "ni",
  "npm", "pnpm", "yarn", "npx", "node", "python", "python3", "py", "tsx", "bun", "deno", "pip", "pip3",
  "cargo", "go", "dotnet", "java", "javac", "mvn", "gradle", "make", "cmake", "git", "gh",
  "curl", "wget", "tar", "zip", "unzip", "7z", "expand-archive", "compress-archive",
  "start-process", "start-job", "invoke-webrequest", "iwr", "invoke-restmethod", "irm"
]);

const DESTRUCTIVE_COMMANDS = new Set([
  "rm", "remove-item", "ri", "del", "erase", "rd", "rmdir", "clear-content", "clc",
  "mkfs", "dd", "shutdown", "reboot", "restart-computer", "stop-computer", "format", "format-volume",
  "diskpart", "clear-disk", "initialize-disk", "remove-partition", "bcdedit", "vssadmin", "takeown",
  "icacls", "reg", "schtasks", "taskkill", "stop-process", "spps", "kill", "pkill", "killall"
]);

const READ_ONLY_GIT = new Set(["status", "diff", "log", "show", "blame", "rev-parse", "ls-files", "shortlog", "describe"]);
const MUTATING_GIT = new Set(["add", "commit", "checkout", "switch", "merge", "rebase", "cherry-pick", "revert", "tag", "stash", "fetch", "pull", "push", "init", "clone", "mv", "rm", "restore", "apply"]);
const SCRIPT_FLAGS = new Set(["-c", "-command", "/c", "--command"]);

export function classifyShellCommand(command: string): ShellClassification {
  const trimmed = command.trim();
  if (!trimmed) return { kind: "unknown", reason: "命令为空", command: "" };
  const segments = splitShellSegments(trimmed);
  let worst: ShellClassification = { kind: "read-only", reason: "只读命令", command: trimmed };
  for (const segment of segments) {
    const result = classifySegment(segment);
    if (RANK[result.kind] > RANK[worst.kind]) worst = { ...result, command: trimmed };
    if (worst.kind === "unknown") return worst;
  }
  return worst;
}

export function shellScriptFromArgv(argv: string[], shell: "powershell" | "cmd" | "sh" | null): string | null {
  if (shell === null) return null;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]?.toLowerCase();
    if (!flag || !SCRIPT_FLAGS.has(flag)) continue;
    return argv.slice(index + 1).join(" ");
  }
  return null;
}

const RANK: Record<ShellCommandClass, number> = { "read-only": 0, mutating: 1, destructive: 2, unknown: 3 };

function classifySegment(segment: string): ShellClassification {
  const tokens = tokenize(segment);
  if (tokens.length === 0) return { kind: "read-only", reason: "空片段", command: segment };
  const command = tokens[0]!.toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/i, "");
  const args = tokens.slice(1);
  const lowerArgs = args.map((arg) => arg.toLowerCase());

  if (segment.includes("$(") || segment.includes("`")) {
    return { kind: "unknown", reason: "包含命令替换，无法静态确认", command: segment };
  }
  if (DESTRUCTIVE_COMMANDS.has(command)) {
    if (command === "reg" && !lowerArgs.includes("delete")) return { kind: "unknown", reason: "reg 子命令无法确认", command: segment };
    return { kind: "destructive", reason: `${command} 属于破坏性命令`, command: segment };
  }
  if (command === "git") return classifyGit(args, segment);
  if (command === "npm" || command === "pnpm" || command === "yarn") {
    const verb = lowerArgs[0];
    if (verb === "test" || verb === "run" || verb === "install" || verb === "ci" || verb === "exec") {
      return { kind: "mutating", reason: `${command} ${verb} 会执行或写入依赖`, command: segment };
    }
    return { kind: "unknown", reason: `${command} 子命令无法确认`, command: segment };
  }
  if (command === "find") {
    if (lowerArgs.some((arg) => arg === "-delete" || arg === "-exec" || arg === "-execdir")) {
      return { kind: "destructive", reason: "find 带删除或执行参数", command: segment };
    }
    return { kind: "read-only", reason: "find 只读查找", command: segment };
  }
  if (command === "curl" || command === "wget") {
    const writes = args.some((arg) => ["-o", "-O", "--output", "-d", "-D", "--data", "-F", "--form", "-T", "--upload-file", "-X"].includes(arg) || arg.toLowerCase().startsWith("--data"));
    return writes
      ? { kind: "mutating", reason: "网络命令带写入参数", command: segment }
      : { kind: "read-only", reason: "网络读取", command: segment };
  }
  if (READ_ONLY_COMMANDS.has(command)) {
    if (command === "sed" && lowerArgs.some((arg) => arg === "-i" || arg.startsWith("--in-place"))) {
      return { kind: "mutating", reason: "sed 原地修改", command: segment };
    }
    return { kind: "read-only", reason: `${command} 只读`, command: segment };
  }
  if (MUTATING_COMMANDS.has(command)) return { kind: "mutating", reason: `${command} 会修改状态`, command: segment };
  return { kind: "unknown", reason: `${command} 未登记，需人工确认`, command: segment };
}

function classifyGit(args: string[], segment: string): ShellClassification {
  const sub = args[0]?.toLowerCase();
  if (!sub) return { kind: "unknown", reason: "git 缺少子命令", command: segment };
  if (sub === "reset" && args.some((arg) => arg.toLowerCase() === "--hard")) {
    return { kind: "destructive", reason: "git reset --hard", command: segment };
  }
  if (sub === "clean" && args.some((arg) => /^-[a-z]*f/i.test(arg))) {
    return { kind: "destructive", reason: "git clean 会删除未跟踪文件", command: segment };
  }
  if (sub === "push" && args.some((arg) => arg.toLowerCase().includes("--force") || arg.toLowerCase() === "-f")) {
    return { kind: "destructive", reason: "git push --force", command: segment };
  }
  if (sub === "branch" && args.some((arg) => /^-[dD]$/.test(arg))) {
    return { kind: "destructive", reason: "git branch 删除分支", command: segment };
  }
  if (sub === "stash" && args.some((arg) => arg.toLowerCase() === "drop")) {
    return { kind: "destructive", reason: "git stash drop", command: segment };
  }
  if (READ_ONLY_GIT.has(sub)) {
    if (sub === "status" || sub === "diff" || sub === "log" || sub === "show" || sub === "blame") {
      return { kind: "read-only", reason: `git ${sub} 只读`, command: segment };
    }
    return { kind: "read-only", reason: `git ${sub} 只读`, command: segment };
  }
  if (MUTATING_GIT.has(sub)) return { kind: "mutating", reason: `git ${sub} 会修改状态`, command: segment };
  return { kind: "unknown", reason: `git ${sub} 无法确认`, command: segment };
}

function splitShellSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (quote) {
      current += char;
      if (char === quote && command[index - 1] !== "\\") quote = null;
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      current += char;
      continue;
    }
    if (char === ";" || char === "\n" || (char === "&" && command[index + 1] === "&") || (char === "|" && command[index + 1] === "|")) {
      segments.push(current);
      current = "";
      if ((char === "&" && command[index + 1] === "&") || (char === "|" && command[index + 1] === "|")) index += 1;
      continue;
    }
    if (char === "|" || char === "&") {
      segments.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current) segments.push(current);
  return segments.map((segment) => segment.trim()).filter(Boolean);
}

function tokenize(segment: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index]!;
    if (quote) {
      if (char === quote && segment[index - 1] !== "\\" && segment[index - 1] !== "`") quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (char === " " || char === "\t") {
      if (current) tokens.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);
  return tokens;
}

export function commandPolicyIssue(command: string, options: { fullAccess?: boolean; planMode?: boolean } = {}): string | null {
  const trimmed = command.trim();
  if (!trimmed) return "命令为空。";
  for (const pattern of DESTRUCTIVE) {
    if (pattern.test(trimmed)) return `拒绝执行破坏性命令：${trimmed.slice(0, 120)}。如确需执行，请调整任务范围或项目配置。`;
  }
  if (options.planMode) {
    if (!planModeAllowsCommand(trimmed)) {
      return "plan mode 只允许只读命令；请先 submit_plan 并等待用户批准后再执行修改命令。";
    }
    return null;
  }
  if (!options.fullAccess) {
    for (const pattern of SENSITIVE) {
      if (pattern.test(trimmed)) return `当前模式不允许自动执行敏感命令：${trimmed.slice(0, 120)}。请调整任务范围或项目配置。`;
    }
  }
  const pipedShell = /\b(curl|wget)\b[^|]*\|\s*(sh|bash|zsh|pwsh|powershell)\b/i.exec(trimmed);
  if (pipedShell) return "拒绝执行从网络直接管道到 shell 的命令；请先下载并检查内容。";
  return null;
}
