import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { MoreHorizontal } from "lucide-react";
import { api, ApiError } from "../lib/api.ts";
import type { TaskRecord } from "../lib/types.ts";
import { executionModeLabel } from "../lib/labels.ts";

export function TaskActionsMenu({ task }: { task: TaskRecord }) {
  const client = useQueryClient();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const [notice, setNotice] = useState("");
  const action = useMutation({
    mutationFn: async (kind: "archive" | "delete" | "share") => {
      setNotice("");
      if (kind === "share") {
        const { summary } = await api.taskOverview(task.id);
        await navigator.clipboard.writeText(`${task.title}\n执行模式：${executionModeLabel(task.executionMode)}\n\n${summary}`);
        setNotice("任务摘要已复制");
      } else if (kind === "archive") {
        await api.setTaskOrganization(task.id, { archived: !task.archivedAt });
      } else {
        if (!window.confirm(`将「${task.title}」移入回收站？可以从回收站恢复。`)) return;
        try { await api.deleteTask(task.id); }
        catch (error) {
          if (!(error instanceof ApiError) || error.code !== "TASK_RUNNING") throw error;
          if (!window.confirm("任务正在运行。取消运行并移入回收站？")) return;
          await api.deleteTask(task.id, true);
        }
      }
      await client.invalidateQueries({ queryKey: ["tasks"] });
      await client.invalidateQueries({ queryKey: ["task", task.id] });
      await client.invalidateQueries({ queryKey: ["trash"] });
    },
    onError: (error) => setNotice(error instanceof Error ? error.message : "操作失败，请重试")
  });
  function close() { setPosition(null); }
  const open = Boolean(position);
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) close();
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { close(); trigger.current?.focus({ preventScroll: true }); } };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    const reposition = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (rect) setPosition({ top: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - 150)), left: Math.max(8, Math.min(rect.right - 200, window.innerWidth - 208)) });
    };
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open]);
  return <span className="task-menu-anchor" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
    <button ref={trigger} className="icon-button" aria-label={`更多操作：${task.title}`} aria-haspopup="menu" aria-expanded={Boolean(position)} disabled={action.isPending}
      onClick={() => {
        if (position) return close();
        const rect = trigger.current!.getBoundingClientRect();
        setPosition({ top: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - 150)), left: Math.max(8, Math.min(rect.right - 200, window.innerWidth - 208)) });
      }}><MoreHorizontal size={16} /></button>
    {notice && <span className="task-action-notice" role="status">{notice}</span>}
    {position && createPortal(<div ref={menu} role="menu" aria-label="任务操作" className="task-actions-menu" style={{ top: position.top, left: position.left }}
      onClick={(event) => event.stopPropagation()} onKeyDown={(event) => {
        event.stopPropagation();
        const buttons = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault(); buttons[(current + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length]?.focus({ preventScroll: true });
        }
        if (event.key === "Escape") { close(); trigger.current?.focus({ preventScroll: true }); }
        if (event.key === "Tab") close();
      }}>
      {([ ["archive", task.archivedAt ? "恢复任务" : "归档任务"], ["share", "分享 · 复制任务摘要"], ["delete", "删除 · 移入回收站"] ] as const).map(([kind, label]) =>
        <button key={kind} role="menuitem" className={kind === "delete" ? "danger" : ""} onClick={() => { close(); trigger.current?.focus({ preventScroll: true }); action.mutate(kind); }}>{label}</button>)}
    </div>, document.body)}
  </span>;
}
