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
