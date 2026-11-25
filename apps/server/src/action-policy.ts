import type { ActionClass } from "@hearth/core";
import { classifyShellCommand, shellScriptFromArgv } from "@hearth/agent-runtime";
import type { ResolvedAction } from "./action-resolver.ts";

export interface ActionPolicyClassification {
  actionClass: ActionClass;
  service: string;
  action: string;
  summary: string;
  requiresApproval: boolean;
  canAlwaysAllow: boolean;
}

export interface ClassifyActionInput {
  kind?: string;
  toolName?: string;
  action?: ResolvedAction | null;
}

const LOCAL_READ_TOOLS = new Set(["read_file", "list_files", "search_text", "stat_file"]);
const LOCAL_WRITE_TOOLS = new Set([
  "write_file",
  "write_spreadsheet",
  "write_document",
  "edit_file",
  "apply_patch"
]);
const LOCAL_DELETE_TOOLS = new Set(["delete_file", "remove_file", "delete_path"]);
const LOCAL_EXEC_TOOLS = new Set(["shell", "run_command", "exec"]);
const BROWSER_READ_TOOLS = new Set(["browser_read", "browser_screenshot", "browser_assert"]);
const BROWSER_INTERACTION_TOOLS = new Set([
  "browser_click",
  "browser_hover",
  "browser_type",
  "browser_key",
  "browser_wait",
  "browser_select",
  "browser_drag",
  "browser_click_at",
  "browser_type_at",
  "browser_scroll",
  "browser_tabs",
  "browser_request_takeover"
]);
const EXTERNAL_READ_TOOLS = new Set(["fetch_url", "web_search", "browser_open"]);
const EXTERNAL_WRITE_TOOLS = new Set([
  "browser_submit",
  "browser_upload",
  "browser_download",
  "browser_recipe",
  "send_message",
  "publish",
  "post",
  "comment"
]);
const DESKTOP_TOOLS = new Set(["capture_screen", "desktop_click", "desktop_type", "desktop_press", "desktop_focus"]);
// Reading a file outside the task sandbox (for example the user's Desktop) always
// needs an explicit decision: the path is not covered by the task's read roots.
const HOST_READ_TOOLS = new Set(["read_desktop_file"]);

const READ_MCP_TOOLS = new Set([
  "library_search",
  "library_read",
  "library_summary",
  "library_tree"
]);
const READ_NAME_PATTERN = /^(get|list|read|search|find|query|fetch|describe|inspect|browse|lookup|show)_/i;
const WRITE_NAME_PATTERN = /^(create|update|delete|remove|send|publish|post|comment|write|edit|upload|submit|add|insert|patch|set|move|rename)_/i;

export function classifyAction(input: ClassifyActionInput): ActionPolicyClassification {
  const toolName = input.toolName?.trim() || toolNameFromKind(input.kind);
  if (toolName) return classifyTool(toolName, input.action ?? null);
  if (input.kind) return classifyApprovalKind(input.kind, input.action ?? null);
  if (input.action) return classifyResolvedAction(input.action);
  return classification("unknown", "无法识别的动作需要你先确认。", true, false);
}

export function classifyTool(toolName: string, action: ResolvedAction | null = null): ActionPolicyClassification {
  if (toolName.startsWith("mcp__")) {
    const parsed = parseMcpName(toolName);
    if (parsed) return classifyMcp(parsed.serverId, parsed.toolName);
    return classification("unknown", "无法识别的 MCP 工具需要你先确认。", true, false);
  }
  if (LOCAL_READ_TOOLS.has(toolName)) return classification("local_read", "读取本机资料。", false, false);
  if (HOST_READ_TOOLS.has(toolName)) return classification("host_read", "读取工作区之外的文件，需要你确认。", true, false);
  if (LOCAL_WRITE_TOOLS.has(toolName)) return classification("local_write", "修改本机文件。", false, false);
  if (LOCAL_DELETE_TOOLS.has(toolName)) return classification("local_delete", "删除本机文件。", false, false);
  if (LOCAL_EXEC_TOOLS.has(toolName)) return classification("local_exec", "在本机运行命令。", false, false);
  if (BROWSER_READ_TOOLS.has(toolName)) return classification("browser_read", "读取网页内容。", false, false);
  if (BROWSER_INTERACTION_TOOLS.has(toolName)) return classification("desktop", "操作当前网页界面。", false, false);
  if (EXTERNAL_READ_TOOLS.has(toolName)) return classification("external_read", "读取外部信息。", false, false);
  if (EXTERNAL_WRITE_TOOLS.has(toolName)) return classification("external_write", "会把内容提交到外部服务。", true, true);
  if (DESKTOP_TOOLS.has(toolName)) return classification("desktop", "操作本机桌面。", false, false);
  if (toolName === "skill_install") return classification("skill_install", "安装技能前需要你确认。", true, false);
  if (toolName === "skill_update") return classification("skill_update", "技能更新只能手动触发。", false, false);
  if (action) return classifyResolvedAction(action);
  return classification("unknown", "无法识别的工具需要你先确认。", true, false);
}

export function classifyApprovalKind(kind: string, action: ResolvedAction | null = null): ActionPolicyClassification {
  if (kind === "github.publish-pr" || kind === "github.comment") {
    return classification("external_write", "会写入外部服务。", true, true);
  }
  if (kind.startsWith("skill.install")) return classification("skill_install", "安装技能前需要你确认。", true, false);
  if (kind.startsWith("skill.update")) return classification("skill_update", "技能更新只能手动触发。", false, false);
  if (action) return classifyResolvedAction(action);
  return classifyTool(kind.replace(/^tool\./, ""), null);
}

export function classifyResolvedAction(action: ResolvedAction): ActionPolicyClassification {
  if (action.kind === "shell") {
    const script = action.command ? shellScriptFromArgv(action.command.argv, action.command.shell) : null;
    if (script) {
      const shell = classifyShellCommand(script);
      if (shell.kind === "destructive") {
        return classification("local_delete", `破坏性命令需要确认：${shell.reason}`, true, false);
      }
      if (shell.kind === "unknown") {
        return classification("unknown", `无法静态确认的命令需要确认：${shell.reason}`, true, false);
      }
      if (shell.kind === "read-only") return classification("local_read", `只读命令：${shell.reason}`, false, false);
      return classification("local_exec", `会修改状态的命令：${shell.reason}`, false, false);
    }
    return classification("local_exec", "在本机运行命令。", false, false);
  }
  if (action.kind === "file_write") return classification("local_write", "修改本机文件。", false, false);
  if (action.kind === "file_delete") return classification("local_delete", "删除本机文件。", false, false);
  if (action.kind === "host_file") return classification("host_read", "读取工作区之外的文件，需要你确认。", true, false);
  if (action.kind === "desktop") return classification("desktop", "操作本机桌面。", false, false);
  if (action.kind === "browser") {
    const verb = action.browser?.action ?? "";
    if (verb === "read" || verb === "assert" || verb === "screenshot" || verb === "open" || verb === "navigate") {
      return classification("browser_read", "读取网页内容。", false, false);
    }
    if (!["submit", "upload", "download", "recipe"].includes(verb)) {
      return classification("desktop", "操作当前网页界面。", false, false);
    }
    return classification("external_write", "会在网页上提交或上传内容。", true, true);
  }
  if (action.kind === "network") {
    const method = action.network?.method?.toUpperCase() ?? "";
    if (!method || method === "GET" || method === "HEAD" || method === "CONNECT") {
      return classification("external_read", "读取外部信息。", false, false);
    }
    return classification("external_write", "会向外部服务写入内容。", true, true);
  }
  if (action.kind === "mcp" && action.mcp) return classifyMcp(action.mcp.serverId, action.mcp.toolName);
  if (action.kind === "email" || action.kind === "calendar") {
    return classification("external_write", "会写入外部服务。", true, true);
  }
  return classification("unknown", "无法识别的动作需要你先确认。", true, false);
}

export function approvalGrantAction(kind: string): string {
  return kind.startsWith("tool.") ? kind.slice("tool.".length) : kind;
}

function classifyMcp(serverId: string, toolName: string): ActionPolicyClassification {
  if (serverId === "hearth" && READ_MCP_TOOLS.has(toolName)) {
    return classification("local_read", "读取 Hearth 资料库。", false, false);
  }
  if (READ_NAME_PATTERN.test(toolName)) {
    return classification("external_read", "读取外部服务的信息。", false, false);
  }
  if (WRITE_NAME_PATTERN.test(toolName)) {
    return classification("external_write", "会向外部服务写入内容。", true, true);
  }
  return classification("unknown", "这个外部工具的作用无法确认，需要你先确认。", true, false);
}

function classification(
  actionClass: ActionClass,
  summary: string,
  requiresApproval: boolean,
  canAlwaysAllow: boolean
): ActionPolicyClassification {
  return {
    actionClass,
    service: "action-policy",
    action: actionClass,
    summary,
    requiresApproval,
    canAlwaysAllow
  };
}

function toolNameFromKind(kind: string | undefined): string | null {
  if (!kind) return null;
  return kind.startsWith("tool.") ? kind.slice("tool.".length) : null;
}

function parseMcpName(toolName: string): { serverId: string; toolName: string } | null {
  const rest = toolName.slice("mcp__".length);
  const separator = rest.indexOf("__");
  if (separator <= 0 || separator >= rest.length - 2) return null;
  return { serverId: rest.slice(0, separator), toolName: rest.slice(separator + 2) };
}
