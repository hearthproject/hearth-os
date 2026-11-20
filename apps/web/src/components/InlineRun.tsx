import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Loader2,
  RotateCcw,
  TriangleAlert
} from "lucide-react";
import { api } from "../lib/api.ts";
import { formatBytes, formatDuration } from "../lib/format.ts";
import { executorLabel } from "../lib/labels.ts";
import type { TaskStatus, TaskView } from "../lib/types.ts";
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
  waiting_input: "需要补充",
  waiting_approval: "等你确认",
  waiting_budget: "预算触顶",
  completed: "已完成",
  failed: "执行失败",
  recoverable: "执行中断",
  cancelled: "已取消"
};

const ACTIVE_STATUSES: TaskStatus[] = ["queued", "running", "waiting_input", "waiting_approval", "waiting_budget"];
const ATTENTION_STATUSES: TaskStatus[] = ["failed", "recoverable", "waiting_input", "waiting_approval", "waiting_budget"];

interface Step {
  id: string;
  at: string;
  message: string;
}

export function InlineRun({ task }: { task: RunInfo }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const taskQuery = useQuery({
    queryKey: ["task", task.id],
    queryFn: () => api.task(task.id),
    enabled: Boolean(task.id),
    refetchInterval: ACTIVE_STATUSES.includes(task.status) ? 1_500 : false,
    staleTime: 1_000
  });
  const view = taskQuery.data;
  const status = view?.task.status ?? task.status;
  const active = ACTIVE_STATUSES.includes(status);
  const attention = ATTENTION_STATUSES.includes(status);
  const error = view?.task.error ?? null;
  const latestRun = view?.runs && view.runs.length > 0 ? view.runs[view.runs.length - 1] : null;
  const elapsed = latestRun?.startedAt
    ? new Date(latestRun.endedAt ?? Date.now()).getTime() - new Date(latestRun.startedAt).getTime()
    : null;
  const steps = collectSteps(view?.events ?? []);
  const artifacts = view?.artifacts ?? [];
  const pendingApprovals = (view?.approvals ?? []).filter((approval) => approval.status === "pending");

  useEffect(() => {
    if (active || attention) setOpen(true);
  }, [active, attention]);

  const retryMutation = useMutation({
    mutationFn: () => api.retry(task.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["task", task.id] });
      await queryClient.invalidateQueries({ queryKey: ["tasks"] });
      await queryClient.invalidateQueries({ queryKey: ["conversations"] });
    }
  });

  return (
    <div className={`inline-run ${status}`}>
      <button
        type="button"
        className="inline-run-head"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <span className="inline-run-status">
          <TaskStatusIcon status={status} size={13} />
          {RUN_LABELS[status]}
        </span>
        <span className="inline-run-title">{task.title}</span>
        <span className="inline-run-meta">
          {elapsed !== null && formatDuration(elapsed)}
          {steps.length > 0 && <span>{steps.length} 步</span>}
          {artifacts.length > 0 && <span>{artifacts.length} 个产物</span>}
          {task.executorId && <span>{executorLabel(task.executorId)}</span>}
        </span>
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

          {steps.length === 0 && active && (
            <p className="inline-run-muted"><Loader2 size={12} className="spin" /> 正在准备执行…</p>
          )}
          {steps.length > 0 && (
            <ol className="inline-run-steps">
              {steps.slice(-40).map((step, index, shown) => {
                const isLast = index === shown.length - 1;
                return (
                  <li key={step.id} className={isLast && status === "running" ? "running" : ""}>
                    <span className="inline-run-dot">{isLast && status === "running" ? <Loader2 size={11} className="spin" /> : <CheckDot />}</span>
                    <span className="inline-run-step-text">{step.message}</span>
                  </li>
                );
              })}
            </ol>
          )}

          {error && (
            <div className="inline-run-error">
              <TriangleAlert size={13} />
              <span>{error.message}</span>
              {error.recoverable && (
                <button className="ghost-button small" onClick={() => retryMutation.mutate()} disabled={retryMutation.isPending}>
                  {retryMutation.isPending ? <Loader2 size={12} className="spin" /> : <RotateCcw size={12} />} 重试
                </button>
              )}
            </div>
          )}

          {artifacts.length > 0 && (
            <div className="inline-run-artifacts">
              {artifacts.map((artifact) => (
                <a key={artifact.id} href={api.artifactUrl(task.id, artifact.id)} target="_blank" rel="noreferrer" title={`${artifact.relativePath} · ${formatBytes(artifact.bytes)}`}>
                  <FileText size={12} />
                  {fileName(artifact.relativePath)}
                </a>
              ))}
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

function collectSteps(events: TaskView["events"]): Step[] {
  const steps: Step[] = [];
  for (const event of events) {
    if (event.type !== "task.progress") continue;
    const payload = event.payload as { message?: unknown; detail?: { eventType?: unknown } } | null;
    const eventType = typeof payload?.detail?.eventType === "string" ? payload.detail.eventType : "";
    if (eventType === "tool.finished" || eventType === "turn.started") continue;
    const message = typeof payload?.message === "string" ? payload.message.trim() : "";
    if (!message) continue;
    if (steps.length > 0 && steps[steps.length - 1]?.message === message) continue;
    steps.push({ id: event.id, at: event.createdAt, message });
  }
  return steps;
}

function CheckDot() {
  return <span className="inline-run-check" />;
}

function fileName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}
