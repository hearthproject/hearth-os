import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Inbox } from "lucide-react";
import { EmptyState } from "../components/EmptyState.tsx";
import { TaskCard } from "../components/TaskCard.tsx";
import { api } from "../lib/api.ts";
import { needsAttention } from "../lib/format.ts";

export function AttentionPage() {
  const tasksQuery = useQuery({ queryKey: ["tasks"], queryFn: api.tasks, refetchInterval: 8_000 });
  const templatesQuery = useQuery({ queryKey: ["templates"], queryFn: api.templates });
  const templates = new Map((templatesQuery.data?.templates ?? []).map((template) => [template.id, template]));
  const tasks = (tasksQuery.data?.tasks ?? []).filter((task) => needsAttention(task.status));

  return (
    <div className="page">
      <header className="page-top compact">
        <div>
          <span className="eyebrow">需要你</span>
          <h1>只有真正需要你的事，<em>才会出现在这里。</em></h1>
          <p className="page-lead">审批、补充信息和失败恢复都集中在这一页。普通进度不会打扰你。</p>
        </div>
      </header>

      {tasks.length === 0 ? (
        <section className="panel comfortable">
          <EmptyState icon={CheckCircle2} title="现在没有要你决定的事" body="Hearth 会继续处理已排队的任务。真正需要授权或补充信息时，这里会出现提示。" />
        </section>
      ) : (
        <div className="task-grid attention-grid">
          {tasks.map((task) => <TaskCard key={task.id} task={task} template={task.templateId ? templates.get(task.templateId) : undefined} />)}
        </div>
      )}

      <aside className="principle-note">
        <Inbox size={18} />
        <p><strong>为什么停在这里？</strong> 外部发布、推送、评论或信息不足时，Hearth 不会替你做决定，也不会在未确认前重复执行。</p>
      </aside>
    </div>
  );
}
