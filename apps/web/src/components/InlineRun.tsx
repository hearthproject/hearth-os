import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronRight,
  Loader2,
  RotateCcw,
  TriangleAlert
} from "lucide-react";
import { api } from "../lib/api.ts";
import { formatDuration } from "../lib/format.ts";
import type { TaskProgressDetail, TaskStatus, TaskView } from "../lib/types.ts";
import { ApprovalCard } from "./ApprovalCard.tsx";
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
  completed: "已完成",
  failed: "执行失败",
  recoverable: "执行中断",
  cancelled: "已取消"
};

const ACTIVE_STATUSES: TaskStatus[] = ["queued", "running", "waiting_input", "waiting_approval"];
const ATTENTION_STATUSES: TaskStatus[] = ["failed", "recoverable", "waiting_input", "waiting_approval"];
const FINISHED_STATUSES: TaskStatus[] = ["completed", "cancelled"];

interface ToolDetail {
  key: string;
  title: string;
  command?: string;
  output?: string;
  status?: string;
  durationMs?: number;
  exitCode?: number;
  paths?: string[];
}

type Entry =
  | { type: "narration"; key: string; text: string }
  | { type: "label"; key: string; text: string; tools: ToolDetail[] }
  | { type: "system"; key: string; text: string };

const DETAIL_OUTPUT_LIMIT = 4_000;
const LABEL_LIMIT = 28;

export function InlineRun({ task }: { task: RunInfo }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(() => !FINISHED_STATUSES.includes(task.status));
  const [expandedTools, setExpandedTools] = useState<Record<string, boolean>>({});
  const [reply, setReply] = useState("");
  const statusRef = useRef(task.status);

  const taskQuery = useQuery({
    queryKey: ["task", task.id],
    queryFn: () => api.task(task.id),
    enabled: Boolean(task.id),
    refetchInterval: (query) => {
      const current = query.state.data?.task.status ?? task.status;
      // Keep polling until the task view itself reports a terminal state; the
      // list status can lag behind the completion message by one poll.
      return ACTIVE_STATUSES.includes(current) ? 1_500 : false;
    },
    staleTime: 1_000
  });
  const view = taskQuery.data;
  const status = view?.task.status ?? task.status;
  const active = ACTIVE_STATUSES.includes(status);
  const attention = ATTENTION_STATUSES.includes(status);
  const error = view?.task.error ?? null;
  const visibleError = error && !isRetiredTaskNotice(error.message) ? error : null;
  const entries = useMemo(() => collectEntries(view?.events ?? []), [view?.events]);
  const pendingApprovals = (view?.approvals ?? []).filter((approval) => approval.status === "pending");
  const duration = runDuration(view?.runs ?? []);

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
                    onClick={() => entry.tools.length > 0 && setExpandedTools((prev) => ({ ...prev, [entry.key]: !prev[entry.key] }))}
                    aria-expanded={entry.tools.length > 0 ? Boolean(expandedTools[entry.key]) : undefined}
                  >
                    <span className="inline-run-label-mark" aria-hidden="true">▸</span>
                    <span className="inline-run-label-text">{entry.text}</span>
                    {entry.tools.length > 0 && (expandedTools[entry.key] ? <ChevronDown size={11} /> : <ChevronRight size={11} />)}
                  </button>
                  {expandedTools[entry.key] && entry.tools.length > 0 && (
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
                          {tool.output && <pre className="inline-run-output">{clipOutput(tool.output)}</pre>}
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
}

function runDuration(runs: TaskView["runs"]): number | null {
  let total = 0;
  let seen = false;
  for (const run of runs) {
    if (!run.startedAt) continue;
    const start = Date.parse(run.startedAt);
    const end = run.endedAt ? Date.parse(run.endedAt) : Date.now();
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    total += Math.max(0, end - start);
    seen = true;
  }
  return seen ? total : null;
}

function isRetiredTaskNotice(text: string): boolean {
  return /执行预算|本轮执行预算|预算已触顶|budgetExhaustion|Unknown event type:\s*job\.|未知事件类型[：:]\s*job\./i.test(text);
}

function collectEntries(events: TaskView["events"]): Entry[] {
  const entries: Entry[] = [];
  const pendingTools = new Map<string, ToolDetail[]>();
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
      pushSystem(entries, event.id, "整理执行上下文，继续推进");
      continue;
    }
    if (kind === "budget" || kind === "turn" || kind === "dsh.start" || kind === "dsh.done" || kind === "dsh.resume" || kind === "dsh.assistant.attempt") {
      continue;
    }

    const progress = toolFromProgress(kind, detail, message, event.id);
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
  eventId: string
): { phase: "start" | "done" | "single"; pairKey: string; tool: ToolDetail } | null {
  if (detail?.eventType === "tool.started") {
    const command = commandFromInput(detail.input);
    return {
      phase: "start",
      pairKey: detail.title ?? message,
      tool: {
        key: eventId,
        title: humanToolTitle(detail.title, message),
        ...(command ? { command } : {})
      }
    };
  }
  if (detail?.eventType === "tool.finished") {
    return {
      phase: "done",
      pairKey: detail.title ?? message,
      tool: {
        key: eventId,
        title: humanToolTitle(detail.title, message),
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

function humanToolTitle(title: string | undefined, message: string): string {
  const raw = message || title || "执行一步";
  // Keep the row to an action category; paths, queries and command text stay
  // inside the expandable detail.
  const text = raw.split("：")[0]?.trim() || raw;
  return text.length > LABEL_LIMIT ? `${text.slice(0, LABEL_LIMIT)}…` : text;
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
