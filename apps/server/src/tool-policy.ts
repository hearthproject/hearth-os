export const TOOL_APPROVAL_REQUIRED = new Set([
  "write_file",
  "edit_file",
  "apply_patch",
  "shell",
  "fetch_url",
  "capture_screen"
]);

export const BACKGROUND_READ_ONLY_TOOLS = new Set([
  "read_file",
  "list_files",
  "search_text"
]);

export function requiresToolApproval(toolName: string): boolean {
  return TOOL_APPROVAL_REQUIRED.has(toolName);
}

export function isBackgroundToolReadOnly(toolName: string): boolean {
  return BACKGROUND_READ_ONLY_TOOLS.has(toolName);
}

export function toolApprovalSummary(toolName: string, value: unknown): string {
  const args = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const path = typeof args.path === "string" ? args.path : typeof args.fileName === "string" ? args.fileName : null;
  const command = typeof args.command === "string" ? args.command : null;
  const url = typeof args.url === "string" ? args.url : null;
  if (toolName === "write_file") return `写入工作区文件：${path ?? "未指定路径"}`;
  if (toolName === "edit_file") return `修改工作区文件：${path ?? "未指定路径"}`;
  if (toolName === "apply_patch") return "应用补丁修改工作区文件";
  if (toolName === "shell") return `运行命令：${clipText(command ?? "未指定命令", 160)}`;
  if (toolName === "fetch_url") return `读取网址：${clipText(url ?? "未指定网址", 200)}`;
  if (toolName === "capture_screen") return `截取桌面画面：${path ?? "desktop.png"}`;
  return `执行敏感工具：${toolName}`;
}

function clipText(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}