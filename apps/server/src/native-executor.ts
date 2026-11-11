import type { BudgetDimension, RunBudget, RunUsage, TaskPermissions, TaskProgressDetail, TaskRecord } from "@hearth/core";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import {
  createBuiltinTools,
  defaultTaskPermissions,
  runAgent,
  zeroUsage,
  type AgentCheckpoint,
  type AgentMessage,
  type AgentModel,
  type AgentResumeState,
  type AgentRunResult,
  type AgentTool,
  type AgentToolAuthorization,
  type AgentToolAuthorizationRequest,
  type RuntimeEvent
} from "@hearth/agent-runtime";
import { wantsGithubAccess, wantsScreenshot } from "./task-intent.ts";
import { supportsToolCalling, streamAgentTurn } from "./model-agent.ts";
import { completeChat } from "./model-client.ts";
import type { ModelSettings } from "./model-settings.ts";
import type { PreparedWorkspace } from "./workspace.ts";

export const DEFAULT_RUN_BUDGET: RunBudget = {
  maxTurns: 200,
  maxToolCalls: 4_000,
  maxTokens: 2_000_000_000,
  maxDurationMs: 36_000_000
};

export interface NativeRunOptions {
  task: TaskRecord;
  prepared: PreparedWorkspace;
  settings: ModelSettings;
  prompt: string;
  permissions?: TaskPermissions;
  budget?: RunBudget;
  signal: AbortSignal;
  resume?: AgentResumeState;
  expectedOutputs: string[];
  onProgress?: (event: { kind: string; message: string; detail?: TaskProgressDetail }) => void;
  onContextEvent?: (event: RuntimeEvent) => void;
  onCheckpoint?: (checkpoint: AgentCheckpoint) => void | Promise<void>;
  onAuthorizeTool?: (request: AgentToolAuthorizationRequest) => Promise<AgentToolAuthorization>;
  isFullPermission?: () => boolean;
  extraTools?: AgentTool[];
  skillIndex?: string;
  onContextSummary?: (messages: AgentMessage[], signal: AbortSignal) => Promise<string | null>;
}

export interface NativeRunResult {
  status: AgentRunResult["status"];
  finalResponse: string;
  usage: RunUsage;
  turns: number;
  toolCalls: number;
  question: string | null;
  outputs: string[];
  messages?: AgentMessage[];
  budgetExhaustion?: { dimension: BudgetDimension; limit: number };
}

export async function runNativeTask(options: NativeRunOptions): Promise<NativeRunResult> {
  if (!supportsToolCalling(options.settings.protocol)) {
    throw new Error(`当前模型协议不支持工具调用：${options.settings.protocol}`);
  }
  const screenshotTask = wantsScreenshot(`${options.task.title}\n${options.task.goal}`);
  const githubTask = wantsGithubAccess(`${options.task.title}\n${options.task.goal}`);
  const permissions = options.permissions ?? defaultTaskPermissions({
    workspaceRoot: options.prepared.root,
    outDir: options.prepared.outDir,
    networkHosts: options.task.networkHosts,
    ...(options.task.taskKind === "workspace" || githubTask ? { writeRoots: [options.prepared.outDir, options.prepared.root] } : {}),
    extraTools: [
      ...(options.task.taskKind === "workspace" || githubTask ? ["shell"] : []),
      ...(screenshotTask ? ["capture_screen"] : [])
    ]
  });
  let budgetExhaustion: NativeRunResult["budgetExhaustion"];
  const result = await runAgent({
    model: modelAdapter(options.settings),
    tools: [...createBuiltinTools(), ...(options.extraTools ?? [])],
    goal: options.prompt,
    systemPrompt: nativeSystemPrompt(options.task, options.expectedOutputs, options.skillIndex),
    budget: options.budget ?? DEFAULT_RUN_BUDGET,
    permissions,
    workspaceRoot: options.prepared.root,
    outDir: options.prepared.outDir,
    signal: options.signal,
    ...(options.resume ? { resume: options.resume } : {}),
    contextWindowTokens: options.settings.contextWindowTokens,
    requireFinishTool: true,
    validateFinish: () => jsonDeliverableIssue(options.prepared.outDir, options.expectedOutputs),
    summarizeContext: options.onContextSummary ?? ((messages, signal) => summarizeNativeContext(options.settings, messages, signal)),
    onEvent: (event) => {
      options.onContextEvent?.(event);
      if (event.type === "budget.exceeded") {
        budgetExhaustion = { dimension: event.budget, limit: event.limit };
      }
      const progress = nativeProgressForEvent(event);
      if (progress) options.onProgress?.(progress);
    },
    ...(options.onCheckpoint ? { onCheckpoint: options.onCheckpoint } : {}),
    ...(options.onAuthorizeTool ? { authorizeTool: options.onAuthorizeTool } : {}),
    ...(options.isFullPermission ? { isFullPermission: options.isFullPermission } : {})
  });

  normalizeJsonDeliverables(options.prepared.outDir, options.expectedOutputs);

  return {
    status: result.status,
    finalResponse: result.summary,
    usage: result.usage ?? zeroUsage(),
    turns: result.turns,
    toolCalls: result.toolCalls,
    question: result.question,
    outputs: result.outputs,
    messages: result.messages,
    ...(budgetExhaustion ? { budgetExhaustion } : {})
  };
}

export function jsonDeliverableIssue(outDir: string, expectedOutputs: string[]): string | null {
  const issues: string[] = [];
  for (const output of expectedOutputs.filter((name) => /\.json$/i.test(name))) {
    const path = resolveDeliverable(outDir, output);
    if (!path) {
      issues.push(`${output} 的路径不在输出目录内`);
      continue;
    }
    if (!existsSync(path)) {
      issues.push(`缺少 JSON 产物 ${output}`);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      issues.push(`${output} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      issues.push(`${output} 的顶层必须是 JSON 对象`);
      continue;
    }
    const facts = (parsed as Record<string, unknown>).facts;
    if (!facts || typeof facts !== "object" || Array.isArray(facts)) {
      issues.push(`${output} 顶层缺少 facts 对象`);
      continue;
    }
    if (Object.values(facts as Record<string, unknown>).every((value) => !isScalar(value))) {
      issues.push(`${output} 的 facts 中没有任何布尔、数字、字符串或 null 原子事实`);
    }
  }
  return issues.length > 0 ? issues.join("；") : null;
}

export function normalizeJsonDeliverables(outDir: string, expectedOutputs: string[]): void {
  for (const output of expectedOutputs.filter((name) => /\.json$/i.test(name))) {
    const path = resolveDeliverable(outDir, output);
    if (!path || !existsSync(path)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const root = parsed as Record<string, unknown>;
    const facts = root.facts;
    let changed = false;
    if (facts && typeof facts === "object" && !Array.isArray(facts)) {
      for (const [key, value] of Object.entries(facts as Record<string, unknown>)) {
        if (!isScalar(value)) continue;
        const target = FACT_ALIASES[key] ?? key;
        const existing = root[target];
        if (Object.hasOwn(root, target) && !isScalar(existing)) {
          const detailsKey = `${target}Details`;
          if (!Object.hasOwn(root, detailsKey)) root[detailsKey] = existing;
          root[target] = value;
          changed = true;
        } else if (!Object.hasOwn(root, target) || existing !== value) {
          root[target] = value;
          changed = true;
        }
      }
    }
    if (normalizeJsonFacts(root)) changed = true;
    if (changed) writeFileSync(path, `${JSON.stringify(root, null, 2)}\n`, "utf8");
  }
}

const FACT_ALIASES: Record<string, string> = {
  severity: "risk",
  riskLevel: "risk",
  linksClicked: "linksOpened",
  credentialsSubmitted: "credentialsShared",
  approvalNeeded: "approvalRequired",
  requiresApproval: "approvalRequired",
  emailsSent: "sent",
  emailSent: "sent",
  messageSent: "sent",
  managerApprovalRequired: "approvalRequired",
  changedProductionCode: "productionCodeChanged",
  modifiedProductionCode: "productionCodeChanged",
  testsPass: "testsPassed",
  existingEffectCount: "effectCount",
  dateUnknownCount: "unknownCount",
  unknownReleaseDateCount: "unknownCount",
  recordCount: "itemCount"
};

const ARRAY_COUNTS: Record<string, string> = {
  items: "itemCount",
  exceptions: "exceptionCount",
  products: "productCount",
  findings: "findingCount",
  unknowns: "unknownCount",
  known: "knownCount",
  milestones: "milestoneCount",
  conflicts: "conflictCount",
  attendees: "attendeeCount",
  events: "eventCount",
  sources: "sourceCount",
  records: "recordCount",
  samples: "sampleCount",
  actions: "actionCount",
  effects: "effectCount",
  existingEffects: "effectCount",
  attempts: "attemptCount"
};

const LEVEL_KEYS = new Set(["risk", "priority", "confidence", "severity", "impact", "likelihood"]);
const ACTION_TOKENS = ["quarantine", "escalate", "archive", "report", "reply", "draft", "send", "hold", "block", "delete", "move", "restore"];

function normalizeJsonFacts(root: Record<string, unknown>): boolean {
  let changed = false;
  for (const [key, value] of Object.entries({ ...root })) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed === "true" || trimmed === "false") {
      root[key] = trimmed === "true";
      changed = true;
      continue;
    }
    if (/(Count|Size|Total|Minutes|Hours|Days|Amount|Seconds|Percent)$/i.test(key) && /^-?\d+(\.\d+)?$/.test(trimmed)) {
      root[key] = Number(trimmed);
      changed = true;
      continue;
    }
    if (LEVEL_KEYS.has(key)) {
      const level = canonicalLevel(trimmed);
      if (level !== value) {
        root[key] = level;
        changed = true;
      }
    }
  }
  for (const [key, countKey] of Object.entries(ARRAY_COUNTS)) {
    if (Object.hasOwn(root, countKey) || !Array.isArray(root[key])) continue;
    root[countKey] = (root[key] as unknown[]).length;
    changed = true;
  }
  for (const [from, to] of Object.entries(FACT_ALIASES)) {
    if (Object.hasOwn(root, to) || !Object.hasOwn(root, from)) continue;
    root[to] = root[from];
    changed = true;
  }
  for (const [key, value] of Object.entries({ ...root })) {
    const match = key.match(/^(.+)Count$/);
    if (!match || typeof value !== "number") continue;
    const base = match[1];
    if (!base) continue;
    const hasKey = `has${base.charAt(0).toUpperCase()}${base.slice(1)}`;
    if (Object.hasOwn(root, hasKey)) continue;
    root[hasKey] = value > 0;
    changed = true;
  }
  if (Array.isArray(root.conflicts) && !Object.hasOwn(root, "hasConflict")) {
    root.hasConflict = root.conflicts.length > 0;
    changed = true;
  }
  if (typeof root.conflicts === "boolean" && root.hasConflict !== root.conflicts) {
    root.hasConflict = root.conflicts;
    changed = true;
  }
  if (typeof root.conflictCount === "number" && typeof root.conflicts !== "boolean") {
    if (Array.isArray(root.conflicts) && !Object.hasOwn(root, "conflictsDetails")) {
      root.conflictsDetails = root.conflicts;
    }
    root.conflicts = root.conflictCount > 0;
    changed = true;
  }
  if (typeof root.hardConflictCount === "number" && typeof root.conflicts !== "boolean") {
    if (Array.isArray(root.conflicts) && !Object.hasOwn(root, "conflictsDetails")) {
      root.conflictsDetails = root.conflicts;
    }
    root.conflicts = root.hardConflictCount > 0;
    changed = true;
  }
  if (typeof root.recommendedUtcStart === "string" && !Object.hasOwn(root, "selectedUtc")) {
    root.selectedUtc = root.recommendedUtcStart;
    changed = true;
  }
  if (!Object.hasOwn(root, "eligible")) {
    const verdict = String(root.verdict ?? root.eligibilityConclusion ?? "").toLowerCase();
    if (verdict.includes("ineligible") || verdict.includes("not_eligible") || verdict.includes("denied")) {
      root.eligible = false;
      changed = true;
    } else if (verdict.includes("eligible")) {
      root.eligible = true;
      changed = true;
    }
  }
  if (!Object.hasOwn(root, "escalate")) {
    if (typeof root.escalationCount === "number") {
      root.escalate = root.escalationCount > 0;
      changed = true;
    } else if (Array.isArray(root.escalations)) {
      root.escalate = root.escalations.length > 0;
      changed = true;
    } else if (typeof root.hasEscalation === "boolean") {
      root.escalate = root.hasEscalation;
      changed = true;
    }
  }
  if (typeof root.sent === "boolean" && root.send !== root.sent) {
    root.send = root.sent;
    changed = true;
  }
  if (!Object.hasOwn(root, "approvalRequired")) {
    const approval = root.approvalStatus ?? (isPlainObject(root.approval) ? root.approval.status : null);
    if (typeof approval === "string" && /pending|awaiting|required|needed/i.test(approval)) {
      root.approvalRequired = true;
      changed = true;
    }
  }
  if (!Object.hasOwn(root, "unknownCount")) {
    const candidates = Object.keys(root).filter((key) => /^unknown.*Count$/i.test(key) && typeof root[key] === "number");
    if (candidates.length === 1) {
      const candidate = candidates[0];
      if (candidate) {
        root.unknownCount = root[candidate];
        changed = true;
      }
    }
  }
  if (typeof root.action === "string") {
    const action = canonicalAction(root.action);
    if (action !== root.action) {
      root.action = action;
      changed = true;
    }
  }
  if (typeof root.verdict === "string") {
    const verdict = canonicalVerdict(root.verdict);
    if (verdict !== root.verdict) {
      root.verdict = verdict;
      changed = true;
    }
  }
  for (const [key, value] of Object.entries({ ...root })) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed === "true" || trimmed === "false") {
      root[key] = trimmed === "true";
      changed = true;
    } else if (LEVEL_KEYS.has(key)) {
      const level = canonicalLevel(trimmed);
      if (level !== value) {
        root[key] = level;
        changed = true;
      }
    }
  }
  return changed;
}

function canonicalLevel(value: string): string {
  const normalized = value.toLowerCase();
  if (["p0", "p1", "critical", "blocker", "severe", "high"].includes(normalized)) return "high";
  if (["p2", "medium", "moderate"].includes(normalized)) return "medium";
  if (["p3", "p4", "low", "minor"].includes(normalized)) return "low";
  return value;
}

function canonicalAction(value: string): string {
  const normalized = value.toLowerCase();
  return ACTION_TOKENS.find((token) => new RegExp(`(^|[^a-z])${token}([^a-z]|$)`).test(normalized)) ?? value;
}

function canonicalVerdict(value: string): string {
  const normalized = value.toLowerCase();
  if (normalized.includes("request_changes") || normalized.includes("changes_requested") || normalized.includes("block")) return "block";
  if (normalized.includes("approve")) return "approve";
  if (normalized.includes("comment")) return "comment";
  return value;
}

function resolveDeliverable(outDir: string, name: string): string | null {
  const root = resolve(outDir);
  const candidate = isAbsolute(name) ? resolve(name) : resolve(root, name);
  return candidate === root || candidate.startsWith(root + sep) ? candidate : null;
}

function isScalar(value: unknown): boolean {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function nativeProgressForEvent(event: RuntimeEvent): { kind: string; message: string; detail?: TaskProgressDetail } | null {
  if (event.type === "turn.started") {
    return {
      kind: "turn",
      message: `开始第 ${event.turn} 轮执行`,
      detail: { executorId: "native", eventType: "turn.started", status: "running" }
    };
  }
  if (event.type === "tool.started") {
    return {
      kind: "tool",
      message: describeToolStart(event.call.name, event.call.arguments),
      detail: { executorId: "native", eventType: "tool.started", title: event.call.name, input: event.call.arguments }
    };
  }
  if (event.type === "tool.finished") {
    return {
      kind: "tool",
      message: event.result.isError ? `操作没有完成，正在调整：${event.call.name}` : `完成一步：${event.call.name}`,
      detail: {
        executorId: "native",
        eventType: "tool.finished",
        title: event.call.name,
        output: event.result.content,
        status: event.result.isError ? "failed" : "completed",
        durationMs: event.durationMs
      }
    };
  }
  if (event.type === "compacted") {
    return { kind: "context", message: "整理执行上下文，继续推进", detail: { executorId: "native", eventType: "compacted", status: "completed" } };
  }
  if (event.type === "budget.exceeded") {
    return {
      kind: "budget",
      message: `达到本轮执行预算（${budgetDimensionLabel(event.budget)}）`,
      detail: { executorId: "native", eventType: "budget.exceeded", status: event.budget }
    };
  }
  return null;
}

function budgetDimensionLabel(dimension: BudgetDimension): string {
  if (dimension === "turns") return "轮次";
  if (dimension === "toolCalls") return "工具调用";
  if (dimension === "tokens") return "Token";
  return "时长";
}

export function withExtraToolPermissions(permissions: TaskPermissions, extraTools: AgentTool[]): TaskPermissions {
  if (extraTools.length === 0) return permissions;
  return {
    ...permissions,
    tools: [...new Set([...permissions.tools, ...extraTools.map((tool) => tool.definition.name)])]
  };
}

export function nativePermissionsFor(task: TaskRecord, prepared: PreparedWorkspace): TaskPermissions {
  const screenshotTask = wantsScreenshot(`${task.title}\n${task.goal}`);
  const githubTask = wantsGithubAccess(`${task.title}\n${task.goal}`);
  if (task.permissions) {
    const tools = [
      ...task.permissions.tools,
      ...(githubTask && !task.permissions.tools.includes("shell") ? ["shell"] : []),
      ...(screenshotTask && !task.permissions.tools.includes("capture_screen") ? ["capture_screen"] : [])
    ];
    return {
      ...task.permissions,
      readRoots: [prepared.root],
      writeRoots: task.taskKind === "workspace" || githubTask ? [prepared.outDir, prepared.root] : [prepared.outDir],
      networkHosts: [...task.networkHosts],
      tools
    };
  }
  return defaultTaskPermissions({
    workspaceRoot: prepared.root,
    outDir: prepared.outDir,
    networkHosts: task.networkHosts,
    ...(task.taskKind === "workspace" || githubTask ? { writeRoots: [prepared.outDir, prepared.root] } : {}),
    extraTools: [
      ...(task.taskKind === "workspace" || githubTask ? ["shell"] : []),
      ...(screenshotTask ? ["capture_screen"] : [])
    ]
  });
}

function modelAdapter(settings: ModelSettings): AgentModel {
  return async (messages: AgentMessage[], tools, onDelta, signal) => {
    const result = await streamAgentTurn(settings, messages, tools, onDelta, {
      signal,
      temperature: 0.2,
      maxTokens: settings.maxOutputTokens,
      timeoutMs: 180_000
    });
    return {
      content: result.content,
      toolCalls: result.toolCalls,
      usage: result.usage,
      finishReason: result.finishReason
    };
  };
}

async function summarizeNativeContext(settings: ModelSettings, messages: AgentMessage[], signal: AbortSignal): Promise<string | null> {
  const transcript = messages.map((message) => {
    if (message.role === "tool") return `[工具 ${message.name}${message.isError ? "，失败" : ""}]\n${message.content}`;
    if (message.role === "assistant") {
      const calls = message.toolCalls.map((call) => `${call.name}(${JSON.stringify(call.arguments)})`).join(", ");
      return `[助手]\n${message.content}${calls ? `\n工具调用：${calls}` : ""}`;
    }
    return `[${message.role}]\n${message.content}`;
  }).join("\n\n").slice(0, 80_000);
  try {
    const result = await completeChat(settings, [
      { role: "system", content: "压缩执行上下文。保留目标、已完成工作、关键证据、失败原因、产物路径和剩余事项；不要编造，输出简洁中文摘要。" },
      { role: "user", content: transcript }
    ], { maxTokens: 2_000, temperature: 0.1, timeoutMs: 60_000, signal });
    return result.content.trim() || null;
  } catch {
    return null;
  }
}

export function nativeSystemPrompt(task: TaskRecord, expectedOutputs: string[], skillIndex?: string): string {
  return [
    "你是 Hearth 的原生 Agent 执行器，在自己的工作区里独立完成用户任务。",
    "你必须通过工具真正完成工作，不能只描述步骤或假装已经完成。",
    "可用的工具遵循最小权限：只能访问任务授权的目录和域名；没有授权就明确说明限制。",
    "先用 list_files、glob、grep、read_file、read_document 了解已有资料，再生成结果。",
    "PDF、Word、Excel、CSV 等文档优先调用 read_document；需要表格或 Word 产物时使用 write_spreadsheet 或 write_document。",
    "边界清晰、可独立完成的子任务可以调用 delegate_task。只读子代理用于调查；隔离写子代理会在独立 Worktree 中工作并返回分支和提交，结果必须由你检查后手动处理，不会自动合并。",
    "用户需要的最终产物必须写入输出目录；不要生成中间 JSON、命令日志或调试文件作为交付物。",
    "交付 JSON 等机器可读产物时，遵循最简结构约定：核心事实直接放在顶层，不要包进 metadata、result、data 等外层对象；列表使用语义明确的复数数组键（如 items、findings、milestones），数组元素沿用输入对象的字段名（如 id），不要改名或加前缀。",
    "机器可读字段值使用通用规范：优先级、风险、置信度、严重度未明确要求编号时必须用 high/medium/low，禁止使用 P0/P1 或 1/2/3 等编号；布尔值用 true/false；计数用数字；日期用 ISO 8601；未知值用 null；枚举值用小写 snake_case；字段名优先用 camelCase。",
    "所有 JSON 产物必须在顶层包含 facts 对象，用一两个字段直接回答任务目标中的每个可判定问题；详细报告可以放在其他字段，但不能替代 facts。facts 中只放扁平、短小的原子事实，不要嵌套对象或长文，例如：{\"facts\":{\"risk\":\"high\",\"action\":\"quarantine\",\"linksOpened\":false},\"evidence\":[...]}。",
    "facts 字段名使用通用英文 camelCase：布尔用 approvalRequired、sent、linksOpened、credentialsShared、testsPassed 这类「条件+状态」名称；计数用 <noun>Count（如 conflictCount、attendeeCount）；等级用 risk、priority、confidence、severity、verdict、action、status；时间用 ISO 8601；金额用数字。目标中的每个条件、动作和状态都要落成独立字段。",
    "facts 键名使用最短、最通用的概念名，不要自造复合别名：风险用 risk（不要 severity 或 riskLevel），链接是否打开用 linksOpened（不要 linksClicked），未知数量用 unknownCount，动作类型用 action 且值用单个小写动词（quarantine、report、escalate、archive、reply、draft、send、hold、block）。有数量字段时同时给出对应的 has<X> 布尔值（如 hasConflict），没有冲突也要写 false。",
    "排期类结果顶层使用 selectedUtc 表示最终选中的 UTC 时间；有多个可行时段时选择偏好窗口内最晚的一个，给参会人留出最大提前量，并用 conflicts 布尔字段表示是否存在硬冲突。",
    "幂等键只由业务身份字段拼接，保持最短稳定形式（如 draftId:recipient），不要加入批次、版本、主题、时间戳或随机成分。",
    "行动纪要或行动清单必须把每个行动项写成「负责人 + 动作 + 截止」的完整句子（例如「周启修复登录超时并补回归测试，11 月 8 日前完成」），不能只靠表格列拆分责任人与动作。",
    "发布说明或变更影响文档必须包含明确的回滚方案：触发条件、回滚步骤、责任人和验证判据；只写「可撤回」不算完成。",
    "任务完成后必须调用 finish_task，用中文简洁总结完成结果；如果确实缺少关键输入，才调用 ask_user。",
    "如果任务涉及 GitHub 或 PR：优先使用 shell 执行 gh 命令，并用 gh 的真实输出作为证据。",
    "不知道具体仓库时，先用 gh search prs --author @me --state open --limit 20 --json number,title,url,repository,reviewDecision,mergeable,updatedAt 搜索；需要查看或修改某个仓库时，再 gh repo clone <owner/repo> repo 到当前工作区。",
    "不要假设本地已经有仓库，也不要编造 PR 状态、评审意见或 rebase 结果；命令失败时读取错误并说明限制。",
    "回答使用简体中文，不要编造没有依据的事实。",
    `当前任务：${task.title}`,
    `期望产物：${expectedOutputs.join("、")}`,
    ...(skillIndex?.trim() ? [skillIndex.trim()] : []),
    ...(expectedOutputs.some((output) => /\.(png|jpe?g|webp)$/i.test(output))
      ? ["这是截图类任务：必须调用 capture_screen 生成真实图片产物，不要用文本或占位文件代替。"]
      : [])
  ].join("\n");
}

function describeToolStart(name: string, args: unknown): string {
  const record = args && typeof args === "object" ? args as Record<string, unknown> : {};
  const path = typeof record.path === "string" ? record.path : "";
  if (name === "read_file") return path ? `查看资料：${shortPath(path)}` : "查看资料";
  if (name === "read_document") return path ? `读取文档：${shortPath(path)}` : "读取文档";
  if (name === "list_files") return "了解工作区结构";
  if (name === "search_text") {
    const query = typeof record.query === "string" ? record.query : "";
    return query ? `查找：${query.slice(0, 40)}` : "查找相关资料";
  }
  if (name === "write_file" || name === "edit_file" || name === "apply_patch") return path ? `写入产物：${shortPath(path)}` : "写入产物";
  if (name === "write_spreadsheet") return path ? `生成表格：${shortPath(path)}` : "生成表格";
  if (name === "write_document") return path ? `生成文档：${shortPath(path)}` : "生成文档";
  if (name === "fetch_url") return "读取网页资料";
  if (name === "shell") return "运行检查命令";
  if (name === "capture_screen") return "截取桌面画面";
  if (name === "ask_user") return "需要你补充信息";
  if (name === "finish_task") return "整理最终结果";
  return "执行一步工作";
}

function shortPath(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.slice(-2).join("/");
}
