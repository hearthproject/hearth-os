import { useQuery } from "@tanstack/react-query";
import { ArrowRight, CheckCircle2, Inbox, Loader2, Plus, Sparkles } from "lucide-react";
import { Link } from "react-router-dom";
import { EmptyState } from "../components/EmptyState.tsx";
import { TaskCard } from "../components/TaskCard.tsx";
import { useShell } from "../components/AppShell.tsx";
import { api } from "../lib/api.ts";
import { isActive, needsAttention, todayLabel } from "../lib/format.ts";
import type { TaskRecord, TaskTemplate } from "../lib/types.ts";

export function TodayPage() {
  const { openNewTask } = useShell();
  const tasksQuery = useQuery({ queryKey: ["tasks"], queryFn: api.tasks, refetchInterval: 10_000 });
  const templatesQuery = useQuery({ queryKey: ["templates"], queryFn: api.templates });
  const tasks = tasksQuery.data?.tasks ?? [];
  const templates = templatesQuery.data?.templates ?? [];
  const templateMap = new Map(templates.map((template) => [template.id, template]));
  const active = tasks.filter((task) => isActive(task.status));
  const attention = tasks.filter((task) => needsAttention(task.status));
  const completed = tasks.filter((task) => task.status === "completed").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  return (
    <div className="page today-page">
      <header className="page-top">
        <div>
          <span className="eyebrow">{todayLabel()}</span>
          <h1>把今天的工作，<em>交给 Hearth。</em></h1>
          <p className="page-lead">你只需要说清楚要什么。Hearth 会在本机执行、保存产物，并在需要你决定时停下来。</p>
        </div>
        <button className="primary-button hero-button" onClick={openNewTask}><Plus size={17} /> 新建任务</button>
      </header>

      <section className="metrics">
        <article className="metric-card metric-warm">
          <span className="metric-icon"><Loader2 size={18} /></span>
          <strong>{active.length}</strong>
          <span>正在进行</span>
        </article>
        <Link to="/attention" className="metric-card">
          <span className="metric-icon"><Inbox size={18} /></span>
          <strong>{attention.length}</strong>
          <span>需要你</span>
        </Link>
        <Link to="/artifacts" className="metric-card">
          <span className="metric-icon"><CheckCircle2 size={18} /></span>
          <strong>{completed.length}</strong>
          <span>已完成任务</span>
        </Link>
      </section>

      {tasks.length === 0 ? (
        <section className="first-run panel">
          <EmptyState
            icon={Sparkles}
            title="从一件真实工作开始"
            body="选一个会议纪要、网页归档或数据清洗任务。Hearth 会在隔离工作区里完成，并把结果放进产物中心。"
            action={<button className="primary-button" onClick={openNewTask}><Plus size={17} /> 创建第一个任务</button>}
          />
          <div className="how-it-works">
            <div><span>01</span><strong>说清楚要什么</strong><p>从 15 个真实任务中选择，或直接描述目标。</p></div>
            <div><span>02</span><strong>Hearth 在本机执行</strong><p>Codex 在隔离目录工作，不碰外部账号，也不自动发布。</p></div>
            <div><span>03</span><strong>你检查并拿走结果</strong><p>产物会自动保存，可预览、下载和追溯运行记录。</p></div>
          </div>
        </section>
      ) : (
        <>
          <TaskSection title="正在进行" count={active.length} tasks={active} templateMap={templateMap} empty="现在没有正在执行的任务。" />
          <TaskSection title="需要你决定" count={attention.length} tasks={attention.slice(0, 3)} templateMap={templateMap} empty="暂时没有需要你介入的事情。" viewAll={attention.length > 3} />
          <TaskSection title="最近完成" count={completed.length} tasks={completed.slice(0, 4)} templateMap={templateMap} empty="完成的产物会出现在这里。" />
        </>
      )}
    </div>
  );
}

function TaskSection({
  title,
  count,
  tasks,
  templateMap,
  empty,
  viewAll = false
}: {
  title: string;
  count: number;
  tasks: TaskRecord[];
  templateMap: Map<string, TaskTemplate>;
  empty: string;
  viewAll?: boolean;
}) {
  return (
    <section className="task-section">
      <div className="section-head">
        <h2>{title} <span>{count}</span></h2>
        {viewAll && <Link to="/attention" className="text-link">查看全部 <ArrowRight size={15} /></Link>}
      </div>
      {tasks.length === 0 ? (
        <p className="section-empty">{empty}</p>
      ) : (
        <div className="task-grid">
          {tasks.map((task, index) => (
            <TaskCard key={task.id} task={task} template={task.templateId ? templateMap.get(task.templateId) : undefined} featured={index === 0 && title === "正在进行"} />
          ))}
        </div>
      )}
    </section>
  );
}
