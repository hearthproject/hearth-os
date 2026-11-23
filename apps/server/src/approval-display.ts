import type {
  ApprovalDisplay,
  ApprovalDisplayField,
  ApprovalRecord,
  ApprovalView
} from "@hearth/core";

const TOOL_KIND_PREFIX = "tool.";
const MAX_FIELDS = 24;
const MAX_FIELD_CHARS = 1_200;
const SENSITIVE_KEY = /(?:password|passwd|secret|token|api[_-]?key|authorization|cookie|credential)/i;

const FIELD_LABELS: Record<string, string> = {
  account: "账户",
  action: "动作",
  api_key: "API 密钥",
  api_token: "API 令牌",
  args: "参数",
  body: "正文",
  branch: "分支",
  cc: "抄送",
  command: "命令",
  content: "内容",
  cwd: "工作目录",
  directory: "目录",
  elementRef: "目标元素",
  executable: "可执行文件",
  file: "文件",
  filePath: "文件路径",
  from: "发件人",
  head: "源分支",
  method: "方法",
  path: "路径",
  query: "查询",
  recipient: "收件人",
  subject: "主题",
  to: "收件人",
  url: "网址",
  value: "内容"
};

/**
 * Build a small, presentation-only view from the authoritative approval
 * payload. Policy checks, parameter hashes, and audit records continue to use
 * the original ApprovalRecord.
 */
export function approvalView(approval: ApprovalRecord): ApprovalView {
  return {
    ...approval,
    display: toolDisplay(approval)
  };
}

export function toolDisplay(approval: ApprovalRecord): ApprovalDisplay | null {
  if (!approval.kind.startsWith(TOOL_KIND_PREFIX)) return null;

  const toolName = approval.kind.slice(TOOL_KIND_PREFIX.length);
  const args = record(approval.target.arguments) ?? record(approval.preview.arguments);
  const fields: ApprovalDisplayField[] = [];

  if (args) {
    for (const [key, value] of Object.entries(args)) {
      if (fields.length >= MAX_FIELDS) break;
      const redacted = SENSITIVE_KEY.test(key);
      const formatted = redacted ? "••••••（已隐藏）" : displayValue(value);
      const truncated = formatted.length > MAX_FIELD_CHARS;
      fields.push({
        label: FIELD_LABELS[key] ?? humanize(key),
        value: truncated ? `${formatted.slice(0, MAX_FIELD_CHARS)}…（已截断）` : formatted,
        ...(redacted ? { redacted: true } : {}),
        ...(truncated ? { truncated: true } : {})
      });
    }
  } else if (approval.target.arguments !== undefined || approval.preview.arguments !== undefined) {
    fields.push({
      label: "参数",
      value: displayValue(approval.target.arguments ?? approval.preview.arguments)
    });
  }

  if (fields.length === 0) fields.push({ label: "参数", value: "无参数" });
  if (args && Object.keys(args).length > MAX_FIELDS) {
    fields.push({ label: "其他", value: `另有 ${Object.keys(args).length - MAX_FIELDS} 项参数未展开` });
  }

  return { kind: "tool", toolName, fields };
}

function record(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function displayValue(value: unknown): string {
  if (typeof value === "string") return value || "（空）";
  if (value === null) return "null";
  if (typeof value === "undefined") return "（未提供）";
  if (typeof value !== "object") return String(value);
  try {
    return JSON.stringify(redactNested(value), null, 2);
  } catch {
    return String(value);
  }
}

function redactNested(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactNested);
  const object = record(value);
  if (!object) return value;
  return Object.fromEntries(Object.entries(object).map(([key, nested]) => [
    key,
    SENSITIVE_KEY.test(key) ? "••••••（已隐藏）" : redactNested(nested)
  ]));
}

function humanize(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/^./, (first) => first.toUpperCase());
}
