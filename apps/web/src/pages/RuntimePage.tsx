import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, Clock3, RefreshCw, Square } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api.ts";
import { formatDate, relativeTime } from "../lib/format.ts";
import type { BackgroundToolJob } from "../lib/types.ts";

const TOOL_STATUS_LABELS: Record<BackgroundToolJob["status"], string> = {
  queued: "排队中",
  running: "运行中",
  finished: "已完成",
  failed: "失败",
  stopped: "已停止"
};

type Notice = { tone: "ok" | "error"; text: string };

export function RuntimePage() {
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<Notice | null>(null);
  const toolsQuery = useQuery({ queryKey: ["background-tools"], queryFn: () => api.backgroundTools({ limit: 100 }), refetchInterval: 10_000 });

  const refreshRuntime = () => {
    void queryClient.invalidateQueries({ queryKey: ["background-tools"] });
  };

  const toolStopMutation = useMutation({
    mutationFn: (id: string) => api.stopBackgroundTool(id, "用户在运行控制台停止"),
    onSuccess: () => {
      setNotice({ tone: "ok", text: "后台工具已请求停止。" });
      refreshRuntime();
    },
    onError: (error: Error) => setNotice({ tone: "error", text: error.message })
  });

  const tools = toolsQuery.data?.jobs ?? [];

  return (
    <div className="page workbench-page runtime-page">
      <div className="page-head">
        <div>
          <h1>运行控制台</h1>
          <p className="page-meta">查看代理正在后台运行的工具任务。</p>
        </div>
        <button className="ghost-button" onClick={refreshRuntime} disabled={toolsQuery.isFetching}>
          <RefreshCw size={15} className={toolsQuery.isFetching ? "spin" : ""} /> 刷新
        </button>
      </div>

      <div className="stat-line">
        <span><Activity size={13} /> 后台运行 {tools.filter((item) => ["queued", "running"].includes(item.status)).length}</span>
        <span><Clock3 size={13} /> 历史任务 {tools.length}</span>
      </div>

      {notice && <p className={`settings-notice ${notice.tone}`}>{notice.text}</p>}

      <section className="panel table-panel">
        <div className="panel-head">
          <h2><Activity size={16} /> 后台工具</h2>
          <span className="panel-meta">非只读工具必须先通过审批通道</span>
        </div>
        {tools.length === 0 ? (
          <p className="section-empty">还没有后台工具任务。</p>
        ) : (
          <table className="data-table">
            <thead><tr><th>工具</th><th>状态</th><th>任务</th><th>输出</th><th>时间</th><th>操作</th></tr></thead>
            <tbody>
              {tools.map((job) => (
                <tr key={job.id}>
                  <td><strong>{job.toolName}</strong><span className="page-meta mono">{job.id}</span></td>
                  <td><span className="tag">{TOOL_STATUS_LABELS[job.status]}</span>{job.exitCode !== null && <span className="page-meta">退出码 {job.exitCode}</span>}</td>
                  <td>{job.taskId ? <Link className="link-button" to={"/tasks/" + job.taskId}>查看任务</Link> : "—"}</td>
                  <td><pre className="runtime-output">{shorten(job.output || job.stopReason || "暂无输出", 360)}</pre></td>
                  <td><span title={job.createdAt}>{relativeTime(job.createdAt)}</span></td>
                  <td>
                    {["queued", "running"].includes(job.status) ? (
                      <button className="ghost-button danger" onClick={() => toolStopMutation.mutate(job.id)} disabled={toolStopMutation.isPending}><Square size={13} /> 停止</button>
                    ) : <span className="page-meta">{job.finishedAt ? formatDate(job.finishedAt) : "—"}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function shorten(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
