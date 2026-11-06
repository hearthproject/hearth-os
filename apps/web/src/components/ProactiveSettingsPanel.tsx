import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Pause, Play, Power } from "lucide-react";
import { api } from "../lib/api.ts";
import { formatDate } from "../lib/format.ts";
import type { ProactiveSettings, ProactiveSnapshot } from "../lib/types.ts";

const MODE_LABELS: Record<ProactiveSettings["mode"], string> = {
  off: "关闭",
  suggest: "只建议",
  prepare: "准备动作",
  auto: "自动执行低风险动作"
};

const AUTONOMY_LABELS: Record<string, string> = {
  A0: "只观察",
  A1: "准备但不执行",
  A2: "可执行低风险动作"
};

const TRIGGER_LABELS: Record<string, string> = {
  "task.deadline": "任务截止",
  "task.failed": "任务失败",
  "effect.uncertain": "外部动作不确定",
  "approval.pending": "审批等待",
  "source.new_items": "来源新条目",
  "system.health": "系统健康",
  "email.new_message": "邮件新消息",
  "calendar.upcoming": "日历临近"
};

export function ProactiveSettingsPanel({ snapshot }: { snapshot: ProactiveSnapshot }) {
  const queryClient = useQueryClient();
  const settings = snapshot.settings;
  const budget = snapshot.budget;
  const metrics = snapshot.metrics;

  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["proactive"] });
  const settingsMutation = useMutation({
    mutationFn: api.updateProactiveSettings,
    onSuccess: refresh
  });
  const pauseMutation = useMutation({
    mutationFn: api.pauseProactive,
    onSuccess: refresh
  });

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    settingsMutation.mutate({
      mode: form.get("mode") as ProactiveSettings["mode"],
      dailyLimit: Number(form.get("dailyLimit")),
      cooldownMinutes: Number(form.get("cooldownMinutes")),
      aggregateWindowMinutes: Number(form.get("aggregateWindowMinutes")),
      quietStart: String(form.get("quietStart")),
      quietEnd: String(form.get("quietEnd")),
      triggers: Object.fromEntries(
        Object.keys(settings.triggers).map((kind) => [
          kind,
          {
            enabled: form.get("trigger." + kind) === "on",
            autonomy: String(form.get("autonomy." + kind)) as ProactiveSettings["triggers"][keyof ProactiveSettings["triggers"]]["autonomy"]
          }
        ])
      )
    });
  }

  const error = settingsMutation.error ?? pauseMutation.error;

  return (
    <section className="panel proactive-control-panel">
      <div className="panel-head">
        <h2>主动服务</h2>
        <span className="panel-meta">
          {settings.enabled ? MODE_LABELS[settings.mode] : "已关闭"} · {budget.paused ? "已暂停" : budget.quiet ? "安静时段" : "可提醒"}
        </span>
      </div>

      <div className="proactive-budget-grid">
        <div><span>今日打断</span><strong>{budget.usedToday} / {budget.limit}</strong></div>
        <div><span>下次可提醒</span><strong>{budget.nextAllowedAt ? formatDate(budget.nextAllowedAt) : "现在"}</strong></div>
        <div><span>接受率</span><strong>{metrics.acceptanceRate === null ? "暂无" : Math.round(metrics.acceptanceRate * 100) + "%"}</strong></div>
        <div><span>每次任务打断</span><strong>{metrics.interruptionsPerTask === null ? "暂无" : metrics.interruptionsPerTask.toFixed(2)}</strong></div>
      </div>

      <div className="proactive-actions">
        <button className="ghost-button" onClick={() => pauseMutation.mutate({ minutes: 60 })} disabled={pauseMutation.isPending}>
          <Pause size={15} /> 暂停 1 小时
        </button>
        <button className="ghost-button" onClick={() => pauseMutation.mutate({ resume: true })} disabled={pauseMutation.isPending}>
          <Play size={15} /> 恢复
        </button>
        <button className="ghost-button danger" onClick={() => pauseMutation.mutate({ off: true })} disabled={pauseMutation.isPending}>
          <Power size={15} /> 关闭主动模式
        </button>
        {settings.pausedUntil && <span className="page-meta">暂停到 {formatDate(settings.pausedUntil)}</span>}
      </div>

      <form className="proactive-settings-form" onSubmit={submit}>
        <div className="proactive-number-grid">
          <label>主动级别
            <select name="mode" defaultValue={settings.mode}>
              {Object.entries(MODE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <label>每日上限
            <input name="dailyLimit" type="number" min="0" max="50" defaultValue={settings.dailyLimit} />
          </label>
          <label>同类冷却（分钟）
            <input name="cooldownMinutes" type="number" min="0" max="10080" defaultValue={settings.cooldownMinutes} />
          </label>
          <label>聚合窗口（分钟）
            <input name="aggregateWindowMinutes" type="number" min="0" max="1440" defaultValue={settings.aggregateWindowMinutes} />
          </label>
          <label>安静开始
            <input name="quietStart" type="time" defaultValue={settings.quietStart} />
          </label>
          <label>安静结束
            <input name="quietEnd" type="time" defaultValue={settings.quietEnd} />
          </label>
        </div>

        <div className="proactive-trigger-grid">
          {Object.entries(settings.triggers).map(([kind, policy]) => (
            <div className="proactive-trigger-row" key={kind}>
              <label>
                <input name={"trigger." + kind} type="checkbox" defaultChecked={policy.enabled} />
                <span>{TRIGGER_LABELS[kind] ?? kind}</span>
              </label>
              <select name={"autonomy." + kind} defaultValue={policy.autonomy}>
                {Object.entries(AUTONOMY_LABELS).map(([value, label]) => <option key={value} value={value}>{value} · {label}</option>)}
              </select>
            </div>
          ))}
        </div>

        <div className="proactive-form-foot">
          <button className="primary-button" type="submit" disabled={settingsMutation.isPending}>保存主动设置</button>
          <span className="page-meta">邮件与日历触发默认关闭；没有真实账户时不会伪造数据。</span>
        </div>
        {error && <p className="form-error">{error.message}</p>}
      </form>
    </section>
  );
}
