import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, FilePenLine, FilePlus2, History, Loader2, RefreshCw, RotateCcw } from "lucide-react";
import { ApiError, api } from "../lib/api.ts";
import { formatTime, relativeTime } from "../lib/format.ts";
import type { TaskRewindReport, TaskTurn } from "../lib/types.ts";

function diffLabel(turn: TaskTurn): string {
  const insertions = turn.files.reduce((sum, file) => sum + (file.insertions ?? 0), 0);
  const deletions = turn.files.reduce((sum, file) => sum + (file.deletions ?? 0), 0);
  if (insertions === 0 && deletions === 0) return `${turn.files.length} 个文件`;
  return `${turn.files.length} 个文件 · +${insertions} / -${deletions}`;
}

function verificationLine(turn: TaskTurn): string | null {
  const verification = turn.verification;
  if (!verification) return null;
  const parts: string[] = [];
  if (verification.failedTests.length > 0) parts.push(`${verification.failedTests.length} 个测试失败`);
  else if (verification.toolCalls > 0 && verification.exitCodes.some((code) => code === 0)) parts.push("测试通过");
  if (verification.diagnostics.length > 0) parts.push(`${verification.diagnostics.length} 条诊断`);
  if (verification.browserAssertions.length > 0) {
    const failed = verification.browserAssertions.filter((item) => !item.passed).length;
    parts.push(failed > 0 ? `${failed} 条页面断言失败` : `${verification.browserAssertions.length} 条页面断言通过`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

function rewindMessage(report: TaskRewindReport): string {
  const parts: string[] = [];
  if (report.restored.length > 0) parts.push(`恢复 ${report.restored.length} 个文件`);
  if (report.removed.length > 0) parts.push(`删除 ${report.removed.length} 个新建文件`);
  if (report.failed.length > 0) parts.push(`${report.failed.length} 个文件失败`);
  return parts.length > 0 ? parts.join("，") : "没有需要回退的文件";
}

export function TaskTurnTimeline({ taskId }: { taskId: string }) {
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const turnsQuery = useQuery({
    queryKey: ["task-turns", taskId],
    queryFn: () => api.taskTurns(taskId),
    enabled: Boolean(taskId),
    retry: false
  });
  const rewind = useMutation({
    mutationFn: (input: { runId: string; turn: number; force?: boolean }) => api.rewindTask(taskId, input),
    onSuccess: (response) => {
      setError(null);
      setNotice(`已回退第 ${response.report.turn} 轮：${rewindMessage(response.report)}`);
      void queryClient.invalidateQueries({ queryKey: ["task-turns", taskId] });
      void queryClient.invalidateQueries({ queryKey: ["task", taskId] });
      void queryClient.invalidateQueries({ queryKey: ["tasks"] });
    }
  });

  async function rewindTurn(turn: TaskTurn): Promise<void> {
    setError(null);
    setNotice(null);
    const confirmed = window.confirm(
      `回退到第 ${turn.turn} 轮执行之前？\n\n会恢复本轮改过的文件，并删除本轮新建的文件。其他轮次不受影响。`
    );
    if (!confirmed) return;
    try {
      await rewind.mutateAsync({ runId: turn.runId, turn: turn.turn });
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === "HISTORY_DRIFT") {
        const force = window.confirm(`${caught.message}\n\n强制回退会覆盖这些后续改动，确定继续？`);
        if (!force) return;
        try {
          await rewind.mutateAsync({ runId: turn.runId, turn: turn.turn, force: true });
        } catch (forced) {
          setError(forced instanceof Error ? forced.message : "强制回退失败");
        }
        return;
      }
      setError(caught instanceof Error ? caught.message : "回退失败");
    }
  }

  const turns = turnsQuery.data?.turns ?? [];

  return (
    <section className="panel turn-panel">
      <div className="panel-head">
        <div>
          <h2>逐轮时间线</h2>
          <p className="turn-subtitle">每一轮改了什么、验证结果如何，都可以在这里核对或回退。</p>
        </div>
        <div className="turn-head-actions">
          <span className="panel-meta">{turns.length > 0 ? `${turns.length} 轮` : "暂无记录"}</span>
          <button className="icon-button" onClick={() => void turnsQuery.refetch()} title="刷新时间线" aria-label="刷新时间线">
            {turnsQuery.isFetching ? <Loader2 className="spin" size={15} /> : <RefreshCw size={15} />}
          </button>
        </div>
      </div>

      {turnsQuery.isLoading ? (
        <div className="turn-empty"><Loader2 className="spin" size={16} /> 正在读取逐轮记录</div>
      ) : turnsQuery.isError ? (
        <div className="turn-empty turn-error"><AlertTriangle size={15} /> {turnsQuery.error instanceof Error ? turnsQuery.error.message : "读取逐轮记录失败"}</div>
      ) : turns.length === 0 ? (
        <div className="turn-empty">
          <History size={16} />
          <span>还没有逐轮记录。任务执行一轮后，这里会显示文件改动和验证证据。</span>
        </div>
      ) : (
        <ol className="turn-list">
          {turns.map((turn) => {
            const line = verificationLine(turn);
            return (
              <li className="turn-item" key={`${turn.runId}-${turn.turn}`}>
                <div className="turn-marker">
                  <span className="turn-number">第 {turn.turn} 轮</span>
                  <time title={formatTime(turn.createdAt)}>{relativeTime(turn.createdAt)}</time>
                </div>
                <div className="turn-body">
                  <div className="turn-summary">
                    <strong>{diffLabel(turn)}</strong>
                    {turn.attempt > 1 && <small>第 {turn.attempt} 次执行</small>}
                  </div>
                  {turn.files.length > 0 && (
                    <ul className="turn-files">
                      {turn.files.map((file) => (
                        <li key={file.path}>
                          {file.created ? <FilePlus2 size={13} /> : <FilePenLine size={13} />}
                          <code>{file.path}</code>
                          {(file.insertions !== null || file.deletions !== null) && (
                            <small>
                              {file.insertions !== null ? `+${file.insertions}` : ""}
                              {file.insertions !== null && file.deletions !== null ? " " : ""}
                              {file.deletions !== null ? `-${file.deletions}` : ""}
                            </small>
                          )}
                          {file.created && <span className="turn-tag">新建</span>}
                          {!file.snapshotAvailable && !file.created && <span className="turn-tag turn-tag-warn">无快照</span>}
                        </li>
                      ))}
                    </ul>
                  )}
                  {turn.failed.length > 0 && (
                    <p className="turn-warning"><AlertTriangle size={13} /> {turn.failed.map((item) => `${item.path}：${item.reason}`).join("；")}</p>
                  )}
                  {line && (
                    <p className={`turn-verification ${turn.verification?.failedTests.length ? "turn-verification-bad" : ""}`}>
                      {turn.verification?.failedTests.length ? <AlertTriangle size={13} /> : <CheckCircle2 size={13} />}
                      {line}
                    </p>
                  )}
                  <div className="turn-actions">
                    <button
                      className="ghost-button"
                      onClick={() => void rewindTurn(turn)}
                      disabled={rewind.isPending}
                    >
                      {rewind.isPending && rewind.variables?.runId === turn.runId && rewind.variables?.turn === turn.turn
                        ? <Loader2 className="spin" size={13} />
                        : <RotateCcw size={13} />}
                      回退到本轮之前
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {notice && <p className="turn-notice">{notice}</p>}
      {error && <p className="form-error">{error}</p>}
    </section>
  );
}
