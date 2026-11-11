import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderGit2, GitBranch, Loader2, RefreshCw, Trash2 } from "lucide-react";
import { api } from "../lib/api.ts";

export function TaskWorktreePanel({ taskId }: { taskId: string }) {
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);
  const worktreeQuery = useQuery({
    queryKey: ["task-worktree", taskId],
    queryFn: () => api.taskWorktree(taskId),
    refetchInterval: 8_000
  });
  const cleanup = useMutation({
    mutationFn: () => api.cleanupTaskWorktree(taskId),
    onSuccess: (result) => {
      setNotice(result.branchKept
        ? "Worktree 已清理；任务分支包含未合并提交，已保留分支。"
        : "Worktree 与任务分支已清理。");
      void queryClient.invalidateQueries({ queryKey: ["task-worktree", taskId] });
      void queryClient.invalidateQueries({ queryKey: ["task-git", taskId] });
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "清理失败")
  });

  const worktree = worktreeQuery.data?.worktree ?? null;
  if (worktreeQuery.isLoading || (!worktree && !notice)) return null;

  function remove() {
    if (!worktree) return;
    if (!window.confirm(`清理任务 Worktree“${worktree.branch}”？只有工作区干净时才会删除目录。`)) return;
    setNotice(null);
    cleanup.mutate();
  }

  return (
    <section className="panel worktree-panel">
      <div className="panel-head">
        <h2>任务 Worktree</h2>
        <div className="git-head-actions">
          <span className="panel-meta">{worktree?.available ? (worktree.dirty ? "有未提交改动" : "工作区干净") : "不可用"}</span>
          <button className="icon-button" onClick={() => void worktreeQuery.refetch()} disabled={worktreeQuery.isFetching} title="刷新 Worktree 状态">
            <RefreshCw size={13} className={worktreeQuery.isFetching ? "spin" : ""} />
          </button>
        </div>
      </div>
      <div className="worktree-body">
        {worktree ? (
          <>
            <div className="worktree-summary">
              <span><FolderGit2 size={14} /> <code>{worktree.path}</code></span>
              <span><GitBranch size={14} /> {worktree.branch}</span>
              <span>基线 {worktree.baseBranch} · {worktree.baseSha.slice(0, 12)}</span>
            </div>
            {worktree.error && <p className="form-error">{worktree.error}</p>}
            <p className="muted">任务结束或失败后 Worktree 默认保留。只有工作区干净时才能清理；未合并的任务分支会继续保留。</p>
            <div className="worktree-actions">
              <button className="ghost-button danger" onClick={remove} disabled={!worktree.available || worktree.dirty || cleanup.isPending}>
                {cleanup.isPending ? <Loader2 size={14} className="spin" /> : <Trash2 size={14} />} 清理 Worktree
              </button>
            </div>
          </>
        ) : (
          <p className="muted">{notice ?? "这个任务没有 Worktree。"}</p>
        )}
        {notice && worktree && <p className="worktree-notice">{notice}</p>}
      </div>
    </section>
  );
}
