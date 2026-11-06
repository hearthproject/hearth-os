import { Link } from "react-router-dom";
import type { TaskListItem } from "../lib/types.ts";
import { abbreviateHash, formatDuration, formatTokens, relativeTime } from "../lib/format.ts";
import { useViewMode } from "../lib/view-mode.tsx";
import { StatusPill } from "./StatusPill.tsx";

export function TaskTable({ tasks }: { tasks: TaskListItem[] }) {
  return (
    <table className="data-table task-table">
      <TaskTableHead />
      <tbody>
        {tasks.map((task) => <TaskRow key={task.id} task={task} />)}
      </tbody>
    </table>
  );
}

function TaskRow({ task }: { task: TaskListItem }) {
  const { mode } = useViewMode();
  const summary = task.summary;
  const next = task.error ? task.error.message : task.nextAction ?? task.goal;
  const pro = mode === "pro";

  return (
    <tr className={`task-row status-${task.status}`}>
      <td className="col-status"><StatusPill status={task.status} /></td>
      <td className="col-title">
        <Link to={`/tasks/${task.id}`} title={task.title}>{task.title}</Link>
      </td>
      <td className="col-next" title={next}>{next}</td>
      <td className="col-time">{relativeTime(task.updatedAt)}</td>
      <td className="col-num">{summary.artifacts > 0 ? summary.artifacts : "—"}</td>
      {pro && <td className="col-num mono">{task.templateId ?? "自定义"}</td>}
      {pro && <td className="col-num">{summary.runs > 0 ? summary.runs : "—"}</td>}
      {pro && <td className="col-dur">{formatDuration(summary.lastDurationMs)}</td>}
      {pro && <td className="col-tokens mono">{formatTokens(summary.lastUsage)}</td>}
      {pro && <td className="col-num">{task.networkHosts.length > 0 ? task.networkHosts.length : "—"}</td>}
      {pro && (
        <td className="col-effects">
          {summary.effects.total > 0
            ? `${summary.effects.total}${summary.effects.uncertain > 0 ? ` · ${summary.effects.uncertain} 不确定` : ""}`
            : "—"}
        </td>
      )}
      {pro && <td className="col-mono mono">{summary.approvalId ? abbreviateHash(summary.approvalId, 8, 4) : "—"}</td>}
      {pro && <td className="col-mono mono">{task.currentRunId ? abbreviateHash(task.currentRunId, 8, 4) : "—"}</td>}
    </tr>
  );
}

function TaskTableHead() {
  const { mode } = useViewMode();
  return (
    <thead>
      <tr>
        <th scope="col" className="col-status">状态</th>
        <th scope="col" className="col-title">任务</th>
        <th scope="col" className="col-next">下一步</th>
        <th scope="col" className="col-time">更新</th>
        <th scope="col" className="col-num">产物</th>
        {mode === "pro" && <th scope="col" className="col-num">模板</th>}
        {mode === "pro" && <th scope="col" className="col-num">尝试</th>}
        {mode === "pro" && <th scope="col" className="col-dur">时长</th>}
        {mode === "pro" && <th scope="col" className="col-tokens">Token</th>}
        {mode === "pro" && <th scope="col" className="col-num">联网</th>}
        {mode === "pro" && <th scope="col" className="col-effects">外部动作</th>}
        {mode === "pro" && <th scope="col" className="col-mono">待确认</th>}
        {mode === "pro" && <th scope="col" className="col-mono">当前执行记录</th>}
      </tr>
    </thead>
  );
}
