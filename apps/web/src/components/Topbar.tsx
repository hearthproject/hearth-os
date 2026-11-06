import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";
import { api } from "../lib/api.ts";
import { useViewMode } from "../lib/view-mode.tsx";

export function Topbar() {
  const { mode, setMode } = useViewMode();
  return (
    <header className="topbar">
      <SystemControl />
      <div className="mode-switch" role="group" aria-label="显示模式">
        <button
          type="button"
          className={`mode-option ${mode === "simple" ? "active" : ""}`}
          aria-pressed={mode === "simple"}
          onClick={() => setMode("simple")}
        >
          简单版
        </button>
        <button
          type="button"
          className={`mode-option ${mode === "pro" ? "active" : ""}`}
          aria-pressed={mode === "pro"}
          onClick={() => setMode("pro")}
        >
          专业版
        </button>
      </div>
      <span className="sr-only" aria-live="polite">
        {mode === "pro" ? "已显示专业版审计内容" : "已切换到简单版"}
      </span>
    </header>
  );
}

function SystemControl() {
  const queryClient = useQueryClient();
  const systemQuery = useQuery({ queryKey: ["system"], queryFn: api.system, refetchInterval: 5_000 });
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirmTimer = useRef<number | undefined>(undefined);
  const system = systemQuery.data;
  const running = system?.running ?? true;

  useEffect(() => () => window.clearTimeout(confirmTimer.current), []);

  if (system?.schedulerEnabled === false) return null;

  async function toggle() {
    if (busy) return;
    setError(null);
    if (running && !confirming) {
      setConfirming(true);
      window.clearTimeout(confirmTimer.current);
      confirmTimer.current = window.setTimeout(() => setConfirming(false), 5_000);
      return;
    }
    setBusy(true);
    try {
      if (running) await api.stopSystem();
      else await api.startSystem();
      setConfirming(false);
      await queryClient.invalidateQueries();
    } catch (toggleError) {
      setError(toggleError instanceof Error ? toggleError.message : String(toggleError));
    } finally {
      setBusy(false);
    }
  }

  const pending = (system?.runningTasks ?? 0) + (system?.queued ?? 0);
  return (
    <div className={`system-control ${running ? "" : "paused"}`}>
      <button className="system-button" onClick={() => void toggle()} disabled={busy}>
        {running ? <Pause size={14} /> : <Play size={14} />}
        {busy ? "正在处理…" : running ? (confirming ? "确认停止？已运行任务会中断" : "停止所有任务") : "恢复执行"}
      </button>
      <small>{error ?? (running ? `${pending} 个待处理任务` : "已全部停止，队列和审批会保留")}</small>
    </div>
  );
}
