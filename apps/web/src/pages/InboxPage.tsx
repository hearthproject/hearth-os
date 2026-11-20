import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlarmClock, ArrowRight, BatteryWarning, BellRing, CheckCheck, Clock3, ShieldAlert, X } from "lucide-react";
import { Link } from "react-router-dom";
import { api } from "../lib/api.ts";
import { relativeTime } from "../lib/format.ts";
import type { SupervisionKindView } from "../lib/types.ts";

const KIND_META: Record<SupervisionKindView, { label: string; icon: typeof BellRing }> = {
  long_running: { label: "运行偏久", icon: Clock3 },
  budget_near_limit: { label: "预算上限", icon: BatteryWarning },
  waiting_approval: { label: "等待审批", icon: ShieldAlert },
  failed: { label: "需要处理", icon: AlarmClock }
};

export function InboxPage() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["supervision"], queryFn: api.supervision, refetchInterval: 30_000 });
  const update = useMutation({
    mutationFn: ({ id, action, hours }: { id: string; action: "read" | "dismiss" | "snooze"; hours?: number }) =>
      api.supervisionAction(id, action, hours),
    onSuccess: (data) => queryClient.setQueryData(["supervision"], data)
  });

  const digest = query.data?.digest;
  const items = query.data?.items ?? [];

  return (
    <section className="page inbox-page">
      <header className="page-header">
        <div>
          <h2><BellRing size={20} /> 需要你</h2>
          <p>只放真正需要人处理的事：卡住的任务、等你审批的动作、跑太久的任务，以及每天的简短回顾。</p>
        </div>
        <span className="inbox-count">{items.filter((item) => item.status === "unread").length} 条未读</span>
      </header>

      {digest && (
        <section className="inbox-digest">
          <div className="inbox-digest-head">
            <strong>昨日回顾</strong>
            <small>{digest.date}</small>
          </div>
          <div className="inbox-digest-numbers">
            <span><strong>{digest.completed}</strong> 完成</span>
            <span><strong>{digest.failed}</strong> 失败</span>
            <span><strong>{digest.waitingApproval}</strong> 等审批</span>
            <span><strong>{digest.open}</strong> 未结束</span>
          </div>
          {digest.suggestions.length > 0 && (
            <ul>{digest.suggestions.map((item) => <li key={item}>{item}</li>)}</ul>
          )}
        </section>
      )}

      {query.isLoading ? <p className="form-hint">正在检查任务…</p> : items.length === 0 ? (
        <p className="empty-state">现在没有需要你处理的事。任务跑完后会自动出现在这里。</p>
      ) : (
        <div className="inbox-list">
          {items.map((item) => {
            const meta = KIND_META[item.kind];
            const Icon = meta.icon;
            return (
              <article className={`inbox-item ${item.status}`} key={item.id}>
                <div className="inbox-icon"><Icon size={17} /></div>
                <div className="inbox-copy">
                  <div className="inbox-meta"><span>{meta.label}</span><small>{relativeTime(item.createdAt)}</small></div>
                  <strong>{item.title}</strong>
                  <p>{item.body}</p>
                  <Link to={`/tasks/${item.taskId}`}>打开任务 <ArrowRight size={13} /></Link>
                </div>
                <div className="inbox-actions">
                  <button type="button" title="标为已读" onClick={() => update.mutate({ id: item.id, action: "read" })}><CheckCheck size={15} /> 已读</button>
                  <button type="button" title="4 小时后再提醒" onClick={() => update.mutate({ id: item.id, action: "snooze", hours: 4 })}><Clock3 size={15} /> 稍后</button>
                  <button type="button" title="不再提醒" onClick={() => update.mutate({ id: item.id, action: "dismiss" })}><X size={15} /></button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
