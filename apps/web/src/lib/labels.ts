import type {
  ApprovalRecord,
  DesktopCommandStatus,
  DesktopSessionStatus,
  DeviceCapabilityKind,
  DeviceCapabilityStatus,
  EffectRecord,
  EventEnvelope,
  OutboxDraftStatus,
  PairingRequestStatus,
  RunStatus,
  SourceConnection,
  SourceItem,
  SourceKind,
  TaskRecord,
  TaskStatus
} from "./types.ts";

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  queued: "排队中",
  running: "正在做",
  waiting_input: "需要补充信息",
  waiting_approval: "等你确认",
  completed: "已完成",
  failed: "失败",
  recoverable: "可以继续",
  cancelled: "已取消"
};

export const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  queued: "排队中",
  running: "正在做",
  waiting_input: "需要补充信息",
  waiting_approval: "等你确认",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消"
};

export const EFFECT_STATUS_LABELS: Record<EffectRecord["status"], string> = {
  pending: "待执行",
  executing: "执行中",
  succeeded: "已完成",
  failed: "失败",
  uncertain: "结果不确定"
};

export const APPROVAL_STATUS_LABELS: Record<ApprovalRecord["status"], string> = {
  pending: "等你决定",
  approved: "已批准",
  rejected: "已拒绝",
  expired: "已过期"
};

export const APPROVAL_KIND_LABELS: Record<string, string> = {
  "github.publish-pr": "创建 GitHub PR",
  "github.comment": "发布 GitHub 评论",
  "outbox.local-write": "写入本地发件箱"
};

export const OUTBOX_STATUS_LABELS: Record<OutboxDraftStatus, string> = {
  draft: "草稿",
  pending_approval: "等你确认",
  stored: "已写入本机",
  rejected: "已拒绝",
  failed: "写入失败",
  uncertain: "结果不确定",
  discarded: "已丢弃"
};

export const AUTH_SOURCE_LABELS: Record<string, string> = {
  "provider-env": "自定义 Provider 的环境变量",
  "openai-login": "OpenAI 登录",
  missing: "未检测到可用认证",
  unknown: "未知"
};

export const SOURCE_KIND_LABELS: Record<SourceKind, string> = {
  file: "本地文件",
  knowledge: "知识库",
  web: "公开网页",
  email: "邮件",
  calendar: "日历"
};

export const SOURCE_STATUS_LABELS: Record<SourceConnection["status"], string> = {
  connected: "已连接",
  reading: "正在读取",
  needs_user: "需要你处理",
  error: "读取失败",
  disconnected: "已断开"
};

export const SOURCE_ITEM_STATUS_LABELS: Record<SourceItem["status"], string> = {
  ready: "已读取",
  failed: "读取失败",
  cleared: "已清除"
};

export const DEVICE_CAPABILITY_LABELS: Record<DeviceCapabilityKind, string> = {
  observe: "观察桌面",
  "desktop.control": "控制桌面",
  "ui.automation": "界面自动化"
};

export const DEVICE_CAPABILITY_STATUS_LABELS: Record<DeviceCapabilityStatus, string> = {
  pending: "待你批准",
  approved: "已批准",
  revoked: "已撤销"
};

export const PAIRING_STATUS_LABELS: Record<PairingRequestStatus, string> = {
  pending: "等待配对",
  approved: "已配对",
  rejected: "已拒绝",
  expired: "已过期",
  redeemed: "助手已连接"
};

export const DESKTOP_SESSION_STATUS_LABELS: Record<DesktopSessionStatus, string> = {
  active: "自动操作中",
  paused: "已暂停",
  taken_over: "你已接管",
  terminated: "已终止"
};

export const DESKTOP_COMMAND_STATUS_LABELS: Record<DesktopCommandStatus, string> = {
  queued: "等待助手",
  claimed: "正在执行",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已取消",
  expired: "已过期"
};

export const CATEGORY_LABELS: Record<string, string> = {
  document: "文档",
  web: "网页",
  code: "代码",
  data: "数据",
  people: "人事",
  marketing: "营销"
};

export const EVENT_LABELS: Record<string, string> = {
  "task.created": "任务已创建",
  "task.updated": "状态更新",
  "task.progress": "执行进展",
  "run.created": "开始新一轮执行",
  "run.updated": "执行记录更新",
  "approval.created": "等待你确认",
  "approval.updated": "确认结果已记录",
  "artifact.published": "产物已保存",
  "effect.created": "外部动作已开始",
  "effect.updated": "外部动作已更新",
  "source.created": "来源已连接",
  "source.updated": "来源状态更新",
  "source.item.updated": "来源内容已读取",
  "source.cleared": "来源内容已清除",
  "device.pairing-requested": "桌面助手请求配对",
  "device.pairing-updated": "配对状态已更新",
  "device.paired": "桌面设备已配对",
  "device.updated": "桌面设备状态已更新",
  "desktop.session.created": "桌面会话已开始",
  "desktop.session.updated": "桌面会话状态已更新",
  "desktop.frame.updated": "收到新的桌面观察",
  "desktop.command.created": "桌面动作已排队",
  "desktop.command.updated": "桌面动作状态已更新"
};

const STATUS_EXPLANATIONS: Record<TaskStatus, string> = {
  queued: "等前一个任务做完就开始。",
  running: "执行器正在隔离工作区处理。",
  waiting_approval: "外部动作已备好，你确认后只执行一次。",
  waiting_input: "缺少材料，补齐后可以继续。",
  recoverable: "上一轮未完成，已保留结果，可重试。",
  completed: "产物已保存，交付标准已核对。",
  failed: "这一轮没有做完，原因见下。",
  cancelled: "不会再继续执行。"
};

export function approvalKindLabel(kind: string): string {
  return APPROVAL_KIND_LABELS[kind] ?? kind;
}

export function statusExplanation(task: TaskRecord): string {
  return STATUS_EXPLANATIONS[task.status];
}

export function eventDescription(event: EventEnvelope): string {
  const payload = event.payload as Record<string, unknown> | null;
  if (!payload) return EVENT_LABELS[event.type] ?? event.type;
  if (event.type === "task.progress") return String(payload.message ?? "正在处理");
  if (event.type === "task.updated" && typeof payload.status === "string") {
    return `状态变为：${TASK_STATUS_LABELS[payload.status as TaskStatus] ?? payload.status}`;
  }
  if (event.type === "run.updated" && typeof payload.status === "string") {
    return `执行状态：${RUN_STATUS_LABELS[payload.status as RunStatus] ?? payload.status}`;
  }
  if (event.type === "artifact.published" && typeof payload.relativePath === "string") return payload.relativePath;
  if (event.type === "effect.updated" && typeof payload.status === "string") {
    return `外部动作：${EFFECT_STATUS_LABELS[payload.status as EffectRecord["status"]] ?? payload.status}`;
  }
  if (event.type === "task.created") return "任务记录已写入本机事实记录。";
  return EVENT_LABELS[event.type] ?? event.type;
}

export function externalEffectSummary(approvals: ApprovalRecord[], effects: EffectRecord[]): string {
  const pending = approvals.find((approval) => approval.status === "pending");
  if (pending) return `等待你确认 1 个外部动作：${approvalKindLabel(pending.kind)}。`;
  const uncertain = effects.find((effect) => effect.status === "uncertain");
  if (uncertain) return "外部动作结果不确定，先对账再重试。";
  const failed = effects.find((effect) => effect.status === "failed");
  if (failed) return `外部动作失败：${failed.error ?? "未记录原因"}。`;
  const succeeded = effects.filter((effect) => effect.status === "succeeded");
  if (succeeded.length > 0) return `已产生 ${succeeded.length} 个外部动作，回执已记录。`;
  if (approvals.some((approval) => approval.status === "rejected")) return "你拒绝了外部动作，没有产生外部影响。";
  if (approvals.some((approval) => approval.status === "expired")) return "确认已过期，没有执行外部动作。";
  if (approvals.length > 0) return `已记录 ${approvals.length} 次确认，没有外部动作。`;
  return "没有外部动作。";
}
