import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronRight,
  Loader2,
  Play,
  RotateCcw,
  TriangleAlert
} from "lucide-react";
import { api } from "../lib/api.ts";
import { formatDuration } from "../lib/format.ts";
import type { TaskProgressDetail, TaskStatus, TaskView } from "../lib/types.ts";
import { ApprovalCard } from "./ApprovalCard.tsx";
import { BrowserTaskPanel } from "./BrowserTaskPanel.tsx";
import { Markdown } from "./Markdown.tsx";
import { TaskStatusIcon } from "./TaskStatusIcon.tsx";

export interface RunInfo {
  id: string;
  title: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  executorId?: string | null;
}

const RUN_LABELS: Record<TaskStatus, string> = {
  queued: "等待执行",
  running: "执行中",
  waiting_input: "需要补充信息",
  waiting_approval: "等待你确认",
  waiting_budget: "已暂停",
  paused: "已暂停",
  completed: "已完成",
  failed: "执行失败",
  recoverable: "执行中断",
  cancelled: "已取消"
};

const ACTIVE_STATUSES: TaskStatus[] = ["queued", "running", "waiting_input", "waiting_approval"];
const ATTENTION_STATUSES: TaskStatus[] = ["failed", "recoverable", "waiting_input", "waiting_approval", "paused"];
const FINISHED_STATUSES: TaskStatus[] = ["completed", "cancelled"];

export interface ToolDetail {
  key: string;
  title: string;
  command?: string;
  output?: string;
  status?: string;
  durationMs?: number;
  exitCode?: number;
  paths?: string[];
  /** 写入的文件路径（write_file / apply_patch） */
  file?: string;
  /** write_file 的完整正文 / apply_patch 的补丁正文 */
  content?: string;
  /** 完整正文是 Markdown 文件时按渲染结果展示，而不是 raw text。 */
  markdown?: boolean;
  /** 本任务里第一次写这个交付物：默认展开完整内容 */
  autoExpand?: boolean;
}

export type Entry =
  | { type: "narration"; key: string; text: string }
  | { type: "label"; key: string; text: string; tools: ToolDetail[] }
  | { type: "system"; key: string; text: string };

const DETAIL_OUTPUT_LIMIT = 4_000;
const LABEL_LIMIT = 28;

export const InlineRun = memo(function InlineRun({ task }: { task: RunInfo }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(() => !FINISHED_STATUSES.includes(task.status));
  const [expandedTools, setExpandedTools] = useState<Record<string, boolean>>({});
  const [reply, setReply] = useState("");
  const [clock, setClock] = useState(() => Date.now());
  const statusRef = useRef(task.status);

  const taskQuery = useQuery({
    queryKey: ["task", task.id],
    queryFn: () => api.task(task.id),
    enabled: Boolean(task.id),
    refetchInterval: (query) => {
      const current = query.state.data?.task.status ?? task.status;
      // SSE appends progress immediately. Poll less often as a recovery path
      // for a missed event or a reconnecting EventSource.
      return ACTIVE_STATUSES.includes(current) ? 5_000 : false;
    },
    staleTime: 1_000
  });
  const view = taskQuery.data;
  const status = view?.task.status ?? task.status;
  const active = ACTIVE_STATUSES.includes(status);
  const error = view?.task.error ?? null;
  const visibleError = error && !isRetiredTaskNotice(error.message) ? error : null;
  const expectedOutputs = view?.task.expectedOutputs;
  const entries = useMemo(
    () => collectEntries(view?.events ?? [], expectedOutputs),
    [view?.events, expectedOutputs]
  );
  const pendingApprovals = (view?.approvals ?? []).filter((approval) => approval.status === "pending");
  const duration = useMemo(
    () => runDuration(view?.runs ?? [], clock) ?? (active ? elapsedSince(task.createdAt, clock) : null),
    [view?.runs, clock, active, task.createdAt]
  );

  useEffect(() => {
    if (!active) {
      setClock(Date.now());
      return;
    }
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") setClock(Date.now());
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [active]);

  useEffect(() => {
    const previous = statusRef.current;
    statusRef.current = status;
    if (previous === status) return;
    if (FINISHED_STATUSES.includes(status)) {
      // Collapse the whole execution trail as soon as the final answer lands.
      setOpen(false);
      return;
    }
    if (ACTIVE_STATUSES.includes(status) || ATTENTION_STATUSES.includes(status)) setOpen(true);
  }, [status]);

  const retryMutation = useMutation({
    mutationFn: () => api.retry(task.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["task", task.id] });
      await queryClient.invalidateQueries({ queryKey: ["tasks"] });
      await queryClient.invalidateQueries({ queryKey: ["conversations"] });
    }
  });

  const resumeMutation = useMutation({
    mutationFn: () => {
      if (!view?.resume) throw new Error("没有可用的检查点，无法继续");
      return api.resume(task.id, view.resume);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["task", task.id] });
      await queryClient.invalidateQueries({ queryKey: ["tasks"] });
      await queryClient.invalidateQueries({ queryKey: ["conversations"] });
    }
  });

  const replyMutation = useMutation({
    mutationFn: (content: string) => api.addFollowUp(task.id, content, "queue"),
    onSuccess: async () => {
      setReply("");
      await queryClient.invalidateQueries({ queryKey: ["task", task.id] });
      await queryClient.invalidateQueries({ queryKey: ["tasks"] });
    }
  });

  const headline = status === "completed"
    ? duration !== null ? `共用时 ${formatDuration(duration)}` : "已完成"
    : `${RUN_LABELS[status]}${duration !== null ? ` · ${formatDuration(duration)}` : ""}`;

  return (
    <div className={`inline-run ${status}`}>
      <button
        type="button"
        className="inline-run-head"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <span className="inline-run-head-icon">
          {status === "running" || status === "queued"
            ? <Loader2 size={12} className="spin" />
            : FINISHED_STATUSES.includes(status)
              ? <span className="inline-run-check" aria-hidden="true" />
              : <TaskStatusIcon status={status} size={12} />}
        </span>
        <span className="inline-run-headline">{headline}</span>
      </button>

      {open && (
        <div className="inline-run-body">
          {pendingApprovals.length > 0 && (
            <div className="inline-run-approvals">
              {pendingApprovals.map((approval) => (
                <ApprovalCard
                  key={approval.id}
                  approval={approval}
                  effect={view?.effects.find((effect) => effect.id === approval.effectId)}
                />
              ))}
            </div>
          )}

          <BrowserTaskPanel taskId={task.id} />
          {entries.length === 0 && active && (
            <p className="inline-run-muted"><Loader2 size={12} className="spin" /> 正在准备执行…</p>
          )}

          {entries.length > 0 && (
            <div className="inline-run-trail">
              {entries.map((entry) => entry.type === "narration" ? (
                <p key={entry.key} className="inline-run-narration">{entry.text}</p>
              ) : entry.type === "system" ? (
                <p key={entry.key} className="inline-run-system">{entry.text}</p>
              ) : (
                <div key={entry.key} className="inline-run-step">
                  <button
                    type="button"
                    className={`inline-run-label ${entry.tools.length > 0 ? "expandable" : ""}`}
                    onClick={() => entry.tools.length > 0 && setExpandedTools((prev) => ({ ...prev, [entry.key]: !isEntryExpanded(entry, expandedTools) }))}
                    aria-expanded={entry.tools.length > 0 ? isEntryExpanded(entry, expandedTools) : undefined}
                  >
                    <span className="inline-run-label-mark" aria-hidden="true">▸</span>
                    <span className="inline-run-label-text">{entry.text}</span>
                    {entry.tools.length > 0 && (isEntryExpanded(entry, expandedTools) ? <ChevronDown size={11} /> : <ChevronRight size={11} />)}
                  </button>
                  {isEntryExpanded(entry, expandedTools) && entry.tools.length > 0 && (
                    <div className="inline-run-detail">
                      {entry.tools.map((tool) => (
                        <div key={tool.key} className="inline-run-tool">
                          <div className="inline-run-tool-head">
                            <span>{tool.title}</span>
                            {tool.durationMs !== undefined && <span>{formatDuration(tool.durationMs)}</span>}
                            {tool.exitCode !== undefined && <span>exit {tool.exitCode}</span>}
                            {tool.status && <span className={tool.status === "failed" ? "failed" : ""}>{tool.status}</span>}
                          </div>
                          {tool.command && <pre className="inline-run-command">{tool.command}</pre>}
                          {tool.paths && tool.paths.length > 0 && (
                            <pre className="inline-run-command">{tool.paths.join("\n")}</pre>
                          )}
                          {tool.content !== undefined
                            ? tool.markdown
                              ? <Markdown className="chat-markdown inline-run-markdown">{tool.content}</Markdown>
                              : <pre className="inline-run-output inline-run-output-full">{tool.content}</pre>
                            : tool.output && <pre className="inline-run-output">{clipOutput(tool.output)}</pre>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {status === "waiting_input" && (
            <div className="inline-run-question">
              <p>{view?.task.resultSummary || view?.task.nextAction || "执行器需要你补充一些信息。"}</p>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  const text = reply.trim();
                  if (text) replyMutation.mutate(text);
                }}
              >
                <input
                  value={reply}
                  onChange={(event) => setReply(event.target.value)}
                  placeholder="补充信息后继续"
                  disabled={replyMutation.isPending}
                />
                <button type="submit" className="ghost-button small" disabled={!reply.trim() || replyMutation.isPending}>
                  {replyMutation.isPending ? <Loader2 size={12} className="spin" /> : null}继续
                </button>
              </form>
              {replyMutation.isError && (
                <p className="inline-run-error">{replyMutation.error instanceof Error ? replyMutation.error.message : "提交失败"}</p>
              )}
            </div>
          )}

          {status === "paused" && (
            <div className="inline-run-question">
              <p>{view?.task.nextAction || "已保存最近检查点，可以继续执行。"}</p>
              {view?.resume ? (
                <button
                  className="ghost-button small"
                  onClick={() => resumeMutation.mutate()}
                  disabled={resumeMutation.isPending}
                >
                  {resumeMutation.isPending ? <Loader2 size={12} className="spin" /> : <Play size={12} />}
                  继续
                </button>
              ) : (
                <p className="inline-run-error">没有可用的检查点，不能从暂停位置继续。</p>
              )}
              {resumeMutation.isError && (
                <p className="inline-run-error">{resumeMutation.error instanceof Error ? resumeMutation.error.message : "继续失败"}</p>
              )}
            </div>
          )}

          {visibleError && (
            <div className="inline-run-error">
              <TriangleAlert size={13} />
              <span>{visibleError.message}</span>
              {visibleError.guidance && <span>{visibleError.guidance}</span>}
              {visibleError.recoverable && (
                <button className="ghost-button small" onClick={() => retryMutation.mutate()} disabled={retryMutation.isPending}>
                  {retryMutation.isPending ? <Loader2 size={12} className="spin" /> : <RotateCcw size={12} />} 重试
                </button>
              )}
            </div>
          )}

          {retryMutation.isError && (
            <p className="inline-run-error">{retryMutation.error instanceof Error ? retryMutation.error.message : "重试失败"}</p>
          )}
        </div>
      )}
    </div>
  );
});

export function isEntryExpanded(entry: Extract<Entry, { type: "label" }>, expandedTools: Record<string, boolean>): boolean {
  // 用户手动展开/折叠优先；否则交付物第一次写入时自动展开完整正文。
  return expandedTools[entry.key] ?? entry.tools.some((tool) => tool.autoExpand);
}

function runDuration(runs: TaskView["runs"], now: number): number | null {
  let total = 0;
  let seen = false;
  for (const run of runs) {
    if (!run.startedAt) continue;
    const start = Date.parse(run.startedAt);
    const end = run.endedAt ? Date.parse(run.endedAt) : now;
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    total += Math.max(0, end - start);
    seen = true;
  }
  return seen ? total : null;
}

function elapsedSince(startedAt: string, now: number): number | null {
  const start = Date.parse(startedAt);
  return Number.isFinite(start) ? Math.max(0, now - start) : null;
}

function isRetiredTaskNotice(text: string): boolean {
  return /执行预算|本轮执行预算|预算已触顶|budgetExhaustion|Unknown event type:\s*job\.|未知事件类型[：:]\s*job\./i.test(text);
}

export function collectEntries(events: TaskView["events"], expectedOutputs: readonly string[] = []): Entry[] {
  const entries: Entry[] = [];
  const pendingTools = new Map<string, ToolDetail[]>();
  // 每个交付物只完整展示一次，之后的写入默认折叠。
  const shownFiles = new Set<string>();
  let lastLabel: Extract<Entry, { type: "label" }> | null = null;

  const pushNarration = (text: string, eventId: string) => {
    for (const part of parseNarration(text, eventId)) {
      if (part.type === "narration" && lastEntryText(entries) === part.text) continue;
      entries.push(part);
      // A following tool call still belongs to the most recent label even
      // when narration text sits between the label and the call.
      if (part.type === "label") lastLabel = part;
    }
  };

  const attachTool = (tool: ToolDetail) => {
    if (lastLabel && lastLabel.tools.length === 0) {
      lastLabel.tools.push(tool);
      lastLabel = null;
      return;
    }
    entries.push({ type: "label", key: `tool:${tool.key}`, text: tool.title, tools: [tool] });
  };

  for (const event of events) {
    if (event.type !== "task.progress") continue;
    const payload = event.payload as { kind?: string; message?: string; detail?: TaskProgressDetail } | null;
    if (!payload) continue;
    const kind = typeof payload.kind === "string" ? payload.kind : "";
    const detail = payload.detail;
    const message = typeof payload.message === "string" ? payload.message.trim() : "";

    const narration = narrationText(kind, detail, message);
    if (isRetiredTaskNotice(narration ?? message)) continue;
    if (narration) {
      pushNarration(narration, event.id);
      continue;
    }

    if (kind === "context") {
      pushSystem(entries, event.id, message || "整理上下文，继续推进");
      continue;
    }
    if (kind === "budget" || kind === "turn" || kind === "dsh.start" || kind === "dsh.done" || kind === "dsh.resume" || kind === "dsh.assistant.attempt") {
      continue;
    }

    const progress = toolFromProgress(kind, detail, message, event.id, shownFiles, expectedOutputs);
    if (!progress) continue;
    if (progress.phase === "start") {
      const list = pendingTools.get(progress.pairKey) ?? [];
      list.push(progress.tool);
      pendingTools.set(progress.pairKey, list);
      continue;
    }
    if (progress.phase === "done") {
      const list = pendingTools.get(progress.pairKey) ?? [];
      const started = progress.pairKey === "dsh-tool" ? list.shift() : list.pop();
      if (list.length === 0) pendingTools.delete(progress.pairKey);
      attachTool(started ? mergeToolDetails(started, progress.tool) : progress.tool);
      continue;
    }
    attachTool(progress.tool);
  }

  return entries;
}

function pushSystem(entries: Entry[], eventId: string, text: string): void {
  const previous = entries[entries.length - 1];
  if (previous?.type === "system" && previous.text === text) return;
  entries.push({ type: "system", key: `sys:${eventId}`, text });
}

function mergeToolDetails(started: ToolDetail, finished: ToolDetail): ToolDetail {
  return {
    ...started,
    ...(finished.output ? { output: finished.output } : {}),
    ...(finished.content !== undefined ? { content: finished.content } : {}),
    ...(finished.markdown ? { markdown: true } : {}),
    ...(finished.autoExpand ? { autoExpand: true } : {}),
    ...(finished.status ? { status: finished.status } : {}),
    ...(finished.durationMs !== undefined ? { durationMs: finished.durationMs } : {}),
    ...(finished.exitCode !== undefined ? { exitCode: finished.exitCode } : {})
  };
}

function lastEntryText(entries: Entry[]): string | null {
  const last = entries[entries.length - 1];
  return last?.type === "narration" ? last.text : null;
}

function narrationText(kind: string, detail: TaskProgressDetail | undefined, message: string): string | null {
  if (detail?.eventType === "assistant.message" && detail.text) return detail.text;
  if (detail?.eventType === "item.completed" && detail.itemType === "agent_message" && detail.text) return detail.text;
  if (kind === "dsh.assistant" && message) return message;
  return null;
}

function toolFromProgress(
  kind: string,
  detail: TaskProgressDetail | undefined,
  message: string,
  eventId: string,
  shownFiles: Set<string>,
  expectedOutputs: readonly string[]
): { phase: "start" | "done" | "single"; pairKey: string; tool: ToolDetail } | null {
  if (detail?.eventType === "tool.started") {
    const command = commandFromInput(detail.input);
    const write = writePreview(detail.input, shownFiles, expectedOutputs);
    return {
      phase: "start",
      pairKey: detail.title ?? message,
      tool: {
        key: eventId,
        title: humanToolTitle(detail.title, message, write.file),
        ...(command ? { command } : {}),
        ...(write.file ? { file: write.file } : {}),
        ...(write.content !== undefined ? { content: write.content } : {}),
        ...(write.markdown ? { markdown: true } : {}),
        ...(write.autoExpand ? { autoExpand: true } : {})
      }
    };
  }
  if (detail?.eventType === "tool.finished") {
    const plan = /submit_plan|提交计划/i.test(detail.title ?? "") ? planOutputMarkdown(detail.output) : null;
    return {
      phase: "done",
      pairKey: detail.title ?? message,
      tool: {
        key: eventId,
        title: humanToolTitle(detail.title, message),
        ...(plan ? { content: plan, markdown: true, autoExpand: true } : {}),
        ...(detail.output ? { output: detail.output } : {}),
        ...(detail.status ? { status: detail.status } : {}),
        ...(detail.durationMs !== undefined ? { durationMs: detail.durationMs } : {}),
        ...(detail.exitCode !== undefined ? { exitCode: detail.exitCode } : {})
      }
    };
  }
  if (detail?.eventType === "item.completed") {
    if (detail.itemType === "reasoning" || detail.itemType === "agent_message" || detail.itemType === "todo_list") return null;
    return {
      phase: "single",
      pairKey: eventId,
      tool: {
        key: eventId,
        title: humanToolTitle(detail.title, message),
        ...(detail.command ? { command: detail.command } : {}),
        ...(detail.output ? { output: detail.output } : {}),
        ...(detail.status ? { status: detail.status } : {}),
        ...(detail.exitCode !== undefined ? { exitCode: detail.exitCode } : {}),
        ...(detail.paths && detail.paths.length > 0 ? { paths: detail.paths } : {})
      }
    };
  }
  if (kind === "dsh.tool.call") {
    return {
      phase: "start",
      pairKey: "dsh-tool",
      tool: {
        key: eventId,
        title: humanToolTitle(undefined, message.replace(/^调用工具：/, "工具")),
        ...(detail?.command ? { command: detail.command } : {})
      }
    };
  }
  if (kind === "dsh.tool.result") {
    return {
      phase: "done",
      pairKey: "dsh-tool",
      tool: { key: eventId, title: "工具", ...(message ? { output: message } : {}) }
    };
  }
  return null;
}

function humanToolTitle(title: string | undefined, message: string, file?: string): string {
  const raw = file ? `写入 ${fileBaseName(file)}` : message || title || "执行一步";
  // Keep the row to an action category; paths, queries and command text stay
  // inside the expandable detail.
  const text = raw.split("：")[0]?.trim() || raw;
  return text.length > LABEL_LIMIT ? `${text.slice(0, LABEL_LIMIT)}…` : text;
}

interface WritePreview {
  file?: string;
  content?: string;
  markdown?: boolean;
  autoExpand?: boolean;
}

/**
 * `write_file` 的入参里带着完整正文，`apply_patch` 带着补丁正文。
 * 交付物（result.md 或 expectedOutputs 里的文件）第一次出现时标记为自动展开，
 * 同一任务里后续写入只保留正文、默认折叠。
 */
function writePreview(
  input: unknown,
  shownFiles: Set<string>,
  expectedOutputs: readonly string[]
): WritePreview {
  if (!input || typeof input !== "object") return {};
  const record = input as Record<string, unknown>;
  const patch = typeof record.patch === "string" ? record.patch : null;
  const file = typeof record.path === "string" ? record.path : patchTargetPath(patch);
  const content = typeof record.content === "string" ? record.content : patch ?? undefined;
  if (content === undefined) return {};
  const preview: WritePreview = { content };
  if (!file) return preview;
  preview.file = file;
  if (!patch && /\.mdx?$/i.test(file)) preview.markdown = true;
  if (!isDeliverablePath(file, expectedOutputs)) return preview;
  const key = normalizePathKey(file);
  if (shownFiles.has(key)) return preview;
  shownFiles.add(key);
  preview.autoExpand = true;
  return preview;
}

/** `submit_plan` returns "计划已写入 <path>。" followed by the raw plan; keep only the plan. */
function planOutputMarkdown(output?: string): string | null {
  const text = (output ?? "").replace(/\r\n/g, "\n").trim();
  if (!text) return null;
  if (/^计划已写入[^\n]*\n/.test(text)) {
    const rest = text.replace(/^计划已写入[^\n]*\n+/, "").trim();
    return rest || null;
  }
  const firstHeading = text.search(/^#{1,6}\s/m);
  return firstHeading > 0 ? text.slice(firstHeading).trim() : text;
}

function patchTargetPath(patch: string | null): string | undefined {  if (!patch) return undefined;
  const match = /^\*\*\*\s+(?:Update|Add) File:\s*(.+)$/m.exec(patch);
  return match?.[1]?.trim() || undefined;
}

function isDeliverablePath(file: string, expectedOutputs: readonly string[]): boolean {
  const normalized = normalizePathKey(file);
  const base = fileBaseName(normalized);
  if (base === "result.md") return true;
  return expectedOutputs.some((item) => {
    const want = normalizePathKey(item);
    return want === normalized || want === base;
  });
}

function normalizePathKey(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

function fileBaseName(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

function commandFromInput(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  if (typeof record.command === "string") return record.command;
  if (typeof record.path === "string") return record.path;
  return undefined;
}

function parseNarration(text: string, baseKey: string): Array<Extract<Entry, { type: "narration" | "label" }>> {
  const parts: Array<Extract<Entry, { type: "narration" | "label" }>> = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let buffer: string[] = [];
  let index = 0;
  const flush = () => {
    const paragraph = buffer.join("\n").trim();
    buffer = [];
    if (paragraph) parts.push({ type: "narration", key: `${baseKey}:p${index++}`, text: paragraph });
  };
  for (const line of lines) {
    const match = /^\s*(?:\*\*)?[▸▶►]\s*(.+?)\s*(?:\*\*)?$/.exec(line);
    if (match?.[1]) {
      flush();
      const label = match[1].trim();
      if (label) {
        parts.push({
          type: "label",
          key: `${baseKey}:l${index++}`,
          text: label.length > LABEL_LIMIT ? `${label.slice(0, LABEL_LIMIT)}…` : label,
          tools: []
        });
      }
      continue;
    }
    buffer.push(line);
  }
  flush();
  return parts;
}

function clipOutput(text: string): string {
  return text.length > DETAIL_OUTPUT_LIMIT ? `${text.slice(0, DETAIL_OUTPUT_LIMIT)}\n…` : text;
}
