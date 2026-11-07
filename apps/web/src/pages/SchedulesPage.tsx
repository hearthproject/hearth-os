import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  CalendarClock,
  ChevronDown,
  Clock3,
  History,
  Loader2,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  TriangleAlert,
  X
} from "lucide-react";
import { api } from "../lib/api.ts";
import { formatDate } from "../lib/format.ts";
import { executorLabel, taskKindLabel } from "../lib/labels.ts";
import type {
  ApprovalMode,
  ExecutorId,
  ScheduleRecord,
  ScheduleRunRecord,
  ScheduleRunStatus,
  TaskKind
} from "../lib/types.ts";

const PRESETS = [
  { id: "hourly", label: "每小时", cron: "0 * * * *" },
  { id: "daily", label: "每天 09:00", cron: "0 9 * * *" },
  { id: "weekdays", label: "工作日 09:00", cron: "0 9 * * 1-5" },
  { id: "weekly", label: "每周一 09:00", cron: "0 9 * * 1" },
  { id: "monthly", label: "每月 1 日 09:00", cron: "0 9 1 * *" },
  { id: "advanced", label: "高级 Cron", cron: "" }
] as const;

const TASK_KINDS: TaskKind[] = ["general", "workspace", "delivery"];

interface ScheduleDraft {
  id?: string;
  name: string;
  prompt: string;
  cron: string;
  timezone: string;
  executorId: ExecutorId;
  approvalMode: ApprovalMode;
  taskKind: TaskKind;
  enabled: boolean;
}

const EMPTY_DRAFT: ScheduleDraft = {
  name: "",
  prompt: "",
  cron: "0 9 * * *",
  timezone: "Asia/Shanghai",
  executorId: "native",
  approvalMode: "necessary",
  taskKind: "general",
  enabled: true
};

export function SchedulesPage() {
  const queryClient = useQueryClient();
  const schedulesQuery = useQuery({ queryKey: ["schedules"], queryFn: api.schedules, refetchInterval: 15_000 });
  const healthQuery = useQuery({ queryKey: ["health"], queryFn: api.health, refetchInterval: 30_000 });
  const [draft, setDraft] = useState<ScheduleDraft | null>(null);
  const [historyId, setHistoryId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const schedules = schedulesQuery.data?.schedules ?? [];
  const hermes = healthQuery.data?.hermes;

  function startCreate() {
    setDraft({ ...EMPTY_DRAFT });
    setNotice(null);
  }

  function startEdit(schedule: ScheduleRecord) {
    setDraft({
      id: schedule.id,
      name: schedule.name,
      prompt: schedule.prompt,
      cron: schedule.cron,
      timezone: schedule.timezone,
      executorId: schedule.executorId,
      approvalMode: schedule.approvalMode,
      taskKind: schedule.taskKind,
      enabled: schedule.enabled
    });
    setNotice(null);
  }

  function updateDraft<K extends keyof ScheduleDraft>(key: K, value: ScheduleDraft[K]) {
    setDraft((current) => current ? { ...current, [key]: value } : current);
  }

  async function save() {
    if (!draft) return;
    if (!draft.name.trim() || !draft.prompt.trim() || !draft.cron.trim()) {
      setNotice({ tone: "error", text: "请填写名称、提示词和运行时间。" });
      return;
    }
    setBusy("save");
    setNotice(null);
    try {
      const input = {
        name: draft.name.trim(),
        prompt: draft.prompt.trim(),
        cron: draft.cron.trim(),
        timezone: draft.timezone.trim() || "Asia/Shanghai",
        executorId: draft.executorId,
        approvalMode: draft.approvalMode,
        taskKind: draft.taskKind,
        enabled: draft.enabled
      };
      if (draft.id) await api.updateSchedule(draft.id, input);
      else await api.createSchedule(input);
      setDraft(null);
      setNotice({ tone: "ok", text: draft.id ? "定时任务已更新。" : "定时任务已创建，会按计划进入专属对话。" });
      await refreshSchedules();
    } catch (error) {
      setNotice({ tone: "error", text: errorMessage(error) });
    } finally {
      setBusy(null);
    }
  }

  async function toggle(schedule: ScheduleRecord) {
    setBusy(`toggle:${schedule.id}`);
    setNotice(null);
    try {
      await api.updateSchedule(schedule.id, { enabled: !schedule.enabled });
      await refreshSchedules();
    } catch (error) {
      setNotice({ tone: "error", text: errorMessage(error) });
    } finally {
      setBusy(null);
    }
  }

  async function runNow(schedule: ScheduleRecord) {
    setBusy(`run:${schedule.id}`);
    setNotice(null);
    try {
      await api.runSchedule(schedule.id);
      setNotice({ tone: "ok", text: `已触发「${schedule.name}」，任务已经进入排队。` });
      setHistoryId(schedule.id);
      await refreshSchedules();
    } catch (error) {
      setNotice({ tone: "error", text: errorMessage(error) });
    } finally {
      setBusy(null);
    }
  }

  async function remove(schedule: ScheduleRecord) {
    if (!window.confirm(`删除定时任务「${schedule.name}」？专属对话和历史任务会保留。`)) return;
    setBusy(`delete:${schedule.id}`);
    setNotice(null);
    try {
      await api.deleteSchedule(schedule.id);
      if (historyId === schedule.id) setHistoryId(null);
      if (draft?.id === schedule.id) setDraft(null);
      setNotice({ tone: "ok", text: "定时任务已删除，专属对话和历史任务已保留。" });
      await refreshSchedules();
    } catch (error) {
      setNotice({ tone: "error", text: errorMessage(error) });
    } finally {
      setBusy(null);
    }
  }

  async function refreshSchedules() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["schedules"] }),
      queryClient.invalidateQueries({ queryKey: ["scheduleRuns"] }),
      queryClient.invalidateQueries({ queryKey: ["tasks"] }),
      queryClient.invalidateQueries({ queryKey: ["conversations"] })
    ]);
  }

  return (
    <div className="page schedules-page">
      <div className="page-head">
        <div>
          <h1>定时任务</h1>
          <p className="page-meta">按固定时间自动创建任务。每次执行都会进入专属对话，进度、结果和失败原因都能回看。</p>
        </div>
        <div className="page-actions">
          <button className="ghost-button" onClick={() => void schedulesQuery.refetch()} disabled={schedulesQuery.isFetching}>
            <RefreshCw size={15} className={schedulesQuery.isFetching ? "spin" : ""} /> 刷新
          </button>
          <button className="primary-button" onClick={startCreate}><Plus size={15} /> 新建计划</button>
        </div>
      </div>

      {notice && <div className={`notice ${notice.tone === "error" ? "error" : "ok"}`}>{notice.text}</div>}

      {draft && (
        <section className="panel schedule-editor">
          <div className="panel-head">
            <h2>{draft.id ? "编辑定时任务" : "新建定时任务"}</h2>
            <button className="icon-button" onClick={() => setDraft(null)} title="关闭"><X size={16} /></button>
          </div>
          <div className="schedule-form">
            <label>
              <span>名称</span>
              <input value={draft.name} onChange={(event) => updateDraft("name", event.target.value)} placeholder="例如：每日行业简报" />
            </label>
            <label>
              <span>执行器</span>
              <select value={draft.executorId} onChange={(event) => updateDraft("executorId", event.target.value as ExecutorId)}>
                <option value="native">Hearth 原生</option>
                <option value="codex">Codex</option>
                <option value="hermes">Hermes</option>
              </select>
              {draft.executorId === "hermes" && hermes && !hermes.canRun && (
                <small className="field-warning"><TriangleAlert size={12} /> Hermes 当前未配置，触发时会跳过并记录原因。</small>
              )}
            </label>
            <label className="span-2">
              <span>固定提示词</span>
              <textarea
                rows={4}
                value={draft.prompt}
                onChange={(event) => updateDraft("prompt", event.target.value)}
                placeholder="每次运行都会把这段内容作为任务目标。"
              />
            </label>
            <label>
              <span>运行频率</span>
              <select
                value={presetForCron(draft.cron)}
                onChange={(event) => {
                  const preset = PRESETS.find((item) => item.id === event.target.value);
                  if (preset && preset.id !== "advanced") updateDraft("cron", preset.cron);
                  else updateDraft("cron", "");
                }}
              >
                {PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}
              </select>
            </label>
            <label>
              <span>时区</span>
              <input value={draft.timezone} onChange={(event) => updateDraft("timezone", event.target.value)} spellCheck={false} />
            </label>
            <label className="span-2">
              <span>Cron 表达式</span>
              <input
                value={draft.cron}
                onChange={(event) => updateDraft("cron", event.target.value)}
                placeholder="0 9 * * 1-5"
                spellCheck={false}
                className="mono"
              />
              <small className="field-hint">格式：分 时 日 月 周。预设之外的时间可以直接修改这里。</small>
            </label>
            <label>
              <span>权限</span>
              <select value={draft.approvalMode} onChange={(event) => updateDraft("approvalMode", event.target.value as ApprovalMode)}>
                <option value="necessary">必要审批</option>
                <option value="full">完全权限（警示）</option>
              </select>
            </label>
            <label>
              <span>任务类型</span>
              <select value={draft.taskKind} onChange={(event) => updateDraft("taskKind", event.target.value as TaskKind)}>
                {TASK_KINDS.map((kind) => <option key={kind} value={kind}>{taskKindLabel(kind)}</option>)}
              </select>
            </label>
            <label className="check-row span-2">
              <input type="checkbox" checked={draft.enabled} onChange={(event) => updateDraft("enabled", event.target.checked)} />
              <span>保存后立即启用</span>
            </label>
            <div className="schedule-form-actions span-2">
              <button className="primary-button" onClick={() => void save()} disabled={busy !== null}>
                {busy === "save" ? <Loader2 className="spin" size={15} /> : <Save size={15} />} 保存
              </button>
              <button className="ghost-button" onClick={() => setDraft(null)} disabled={busy !== null}>取消</button>
            </div>
          </div>
        </section>
      )}

      {schedulesQuery.isLoading ? (
        <div className="empty-panel"><Loader2 className="spin" /> 正在读取定时任务</div>
      ) : schedules.length === 0 && !draft ? (
        <div className="empty-panel">
          <CalendarClock size={24} />
          <h2>还没有定时任务</h2>
          <p>创建一个计划，让 Hearth 在指定时间自动开始工作。</p>
          <button className="primary-button" onClick={startCreate}><Plus size={15} /> 新建计划</button>
        </div>
      ) : (
        <div className="schedule-list">
          {schedules.map((schedule) => (
            <section className="panel schedule-card" key={schedule.id}>
              <div className="schedule-card-head">
                <div className="schedule-title">
                  <span className={`schedule-state-dot ${schedule.enabled ? "online" : "paused"}`} />
                  <div>
                    <h2>{schedule.name}</h2>
                    <p>{schedule.prompt}</p>
                  </div>
                </div>
                <span className={`status-chip ${schedule.enabled ? "ok" : "warn"}`}>{schedule.enabled ? "已启用" : "已暂停"}</span>
              </div>

              <div className="schedule-tags">
                <span>{executorLabel(schedule.executorId)}</span>
                <span>{schedule.approvalMode === "full" ? "完全权限" : "必要审批"}</span>
                <span>{taskKindLabel(schedule.taskKind)}</span>
                <span className="mono">{schedule.cron}</span>
                <span>{schedule.timezone}</span>
              </div>

              <div className="schedule-meta">
                <span><Clock3 size={13} /> 下次：{schedule.enabled ? formatDate(schedule.nextRunAt) : "暂停中"}</span>
                <span><History size={13} /> 上次：{formatDate(schedule.lastRunAt)}</span>
                <ScheduleRunBadge status={schedule.lastStatus} />
                {schedule.lastTaskId && <Link to={`/tasks/${schedule.lastTaskId}`}>最近任务 <ChevronDown size={12} /></Link>}
              </div>

              <div className="schedule-actions">
                <button className="ghost-button" onClick={() => startEdit(schedule)}>编辑</button>
                <button className="ghost-button" onClick={() => void toggle(schedule)} disabled={busy !== null}>
                  {schedule.enabled ? <Pause size={14} /> : <Play size={14} />}
                  {schedule.enabled ? "暂停" : "恢复"}
                </button>
                <button className="ghost-button" onClick={() => void runNow(schedule)} disabled={busy !== null}>
                  {busy === `run:${schedule.id}` ? <Loader2 size={14} className="spin" /> : <Play size={14} />} 立即运行
                </button>
                <button className="ghost-button" onClick={() => setHistoryId(historyId === schedule.id ? null : schedule.id)}>
                  <History size={14} /> {historyId === schedule.id ? "收起历史" : "历史"}
                </button>
                <button className="ghost-button danger" onClick={() => void remove(schedule)} disabled={busy !== null}>
                  <Trash2 size={14} /> 删除
                </button>
              </div>

              {historyId === schedule.id && <ScheduleHistory schedule={schedule} />}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function ScheduleHistory({ schedule }: { schedule: ScheduleRecord }) {
  const runsQuery = useQuery({
    queryKey: ["scheduleRuns", schedule.id],
    queryFn: () => api.scheduleRuns(schedule.id),
    refetchInterval: 10_000
  });
  const runs = runsQuery.data?.runs ?? [];
  return (
    <div className="schedule-history">
      <div className="schedule-history-head">
        <strong>最近运行</strong>
        <span>最近 {runs.length} 次</span>
      </div>
      {runsQuery.isLoading ? (
        <p className="muted"><Loader2 size={13} className="spin" /> 正在读取运行历史</p>
      ) : runs.length === 0 ? (
        <p className="muted">还没有运行记录。</p>
      ) : (
        <ol>
          {runs.slice(0, 20).map((run) => (
            <li key={run.id}>
              <ScheduleRunBadge status={run.status} />
              <span className="schedule-run-time">{formatDate(run.scheduledFor)}</span>
              <span className="schedule-run-detail">{run.error ?? (run.taskId ? "任务已创建" : "未创建任务")}</span>
              {run.taskId && <Link to={`/tasks/${run.taskId}`}>打开任务</Link>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function ScheduleRunBadge({ status }: { status: ScheduleRunStatus | null }) {
  if (!status) return <span className="schedule-run-badge idle">未运行</span>;
  return <span className={`schedule-run-badge ${status}`}>{runStatusLabel(status)}</span>;
}

function runStatusLabel(status: ScheduleRunStatus): string {
  if (status === "queued") return "排队中";
  if (status === "running") return "执行中";
  if (status === "completed") return "已完成";
  if (status === "failed") return "失败";
  if (status === "skipped") return "已跳过";
  return "已取消";
}

function presetForCron(cron: string): string {
  return PRESETS.find((preset) => preset.id !== "advanced" && preset.cron === cron)?.id ?? "advanced";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "操作失败，请稍后重试";
}
