import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Archive, ArchiveRestore, Copy, Trash2 } from "lucide-react";
import { api, ApiError } from "../lib/api.ts";
import type { TaskRecord } from "../lib/types.ts";
import { executionModeLabel } from "../lib/labels.ts";

export function TaskActionsMenu({ task }: { task: TaskRecord }) {
  const client = useQueryClient();
  const [notice, setNotice] = useState("");
  const action = useMutation({
    mutationFn: async (kind: "archive" | "delete" | "share") => {
      setNotice("");
      if (kind === "share") {
        const { summary } = await api.taskOverview(task.id);
        await navigator.clipboard.writeText(`${task.title}\n执行模式：${executionModeLabel(task.executionMode)}\n\n${summary}`);
        setNotice("已复制任务摘要");
      } else if (kind === "archive") {
        await api.setTaskOrganization(task.id, { archived: !task.archivedAt });
      } else {
        if (!window.confirm(`永久删除「${task.title}」？删除后无法恢复。`)) return;
        try {
          await api.deleteTask(task.id);
        } catch (error) {
          if (!(error instanceof ApiError) || error.code !== "TASK_RUNNING") throw error;
          if (!window.confirm("任务正在运行。取消运行并永久删除？")) return;
          await api.deleteTask(task.id, true);
        }
        await api.purgeTrash([{ kind: "task", id: task.id }]);
      }
      await client.invalidateQueries({ queryKey: ["tasks"] });
      await client.invalidateQueries({ queryKey: ["task", task.id] });
      await client.invalidateQueries({ queryKey: ["trash"] });
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "操作失败，请重试")
  });
  return <span className="task-menu-anchor task-quick-actions" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
    <button
      className="icon-button"
      title={task.archivedAt ? "恢复任务" : "归档任务"}
      aria-label={task.archivedAt ? "恢复任务" : "归档任务"}
      aria-pressed={Boolean(task.archivedAt)}
      disabled={action.isPending}
      onClick={() => action.mutate("archive")}
    >{task.archivedAt ? <ArchiveRestore size={14} /> : <Archive size={14} />}</button>
    <button
      className="icon-button"
      title="复制任务摘要"
      aria-label="复制任务摘要"
      disabled={action.isPending}
      onClick={() => action.mutate("share")}
    ><Copy size={14} /></button>
    <button
      className="icon-button danger"
      title="永久删除任务"
      aria-label="永久删除任务"
      disabled={action.isPending}
      onClick={() => action.mutate("delete")}
    ><Trash2 size={14} /></button>
    {notice && <span className="task-action-notice" role="status">{notice}</span>}
  </span>;
}
