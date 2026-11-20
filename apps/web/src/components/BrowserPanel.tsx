import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ExternalLink, Loader2, MonitorPlay, MousePointer2, Pause, Play, RefreshCw, X } from "lucide-react";
import { api } from "../lib/api.ts";
import { relativeTime } from "../lib/format.ts";

export function BrowserPanel({ taskId }: { taskId: string }) {
  const queryClient = useQueryClient();
  const [shotAt, setShotAt] = useState(() => Date.now());
  const [error, setError] = useState<string | null>(null);
  const status = useQuery({
    queryKey: ["browser-status", taskId],
    queryFn: () => api.browserStatus(taskId),
    refetchInterval: 5_000,
    retry: false
  });
  const evidence = useQuery({
    queryKey: ["browser-evidence", taskId],
    queryFn: () => api.browserEvidence(taskId),
    retry: false
  });
  const control = useMutation<unknown, Error, "pause" | "resume" | "close">({
    mutationFn: (action: "pause" | "resume" | "close") =>
      action === "pause" ? api.pauseBrowser(taskId) : action === "resume" ? api.resumeBrowser(taskId) : api.closeBrowser(taskId),
    onSuccess: () => {
      setError(null);
      setShotAt(Date.now());
      void queryClient.invalidateQueries({ queryKey: ["browser-status", taskId] });
      void queryClient.invalidateQueries({ queryKey: ["browser-evidence", taskId] });
    },
    onError: (caught) => setError(caught instanceof Error ? caught.message : "浏览器操作失败")
  });

  const view = status.data;
  const active = view?.tabs.find((tab) => tab.active) ?? view?.tabs[0] ?? null;
  const records = evidence.data?.evidence ?? [];
  const latest = records[0] ?? null;
  if (!view && status.isLoading) return null;
  if (!view?.running && records.length === 0 && (view?.tabs.length ?? 0) === 0) return null;

  return (
    <section className="panel browser-panel">
      <div className="panel-head">
        <div>
          <h2><MonitorPlay size={16} /> 浏览器</h2>
          <p className="browser-subtitle">
            {view?.paused ? "已暂停，你可以在真实浏览器窗口里接管。" : "Agent 在独立 Chrome 配置里操作；页面变化会留下截图。"}
          </p>
        </div>
        <div className="browser-actions">
          {view?.paused ? (
            <button className="ghost-button" disabled={control.isPending} onClick={() => control.mutate("resume")}>
              {control.isPending ? <Loader2 size={13} className="spin" /> : <Play size={13} />} 继续
            </button>
          ) : (
            <button className="ghost-button" disabled={!view?.running || control.isPending} onClick={() => control.mutate("pause")}>
              {control.isPending ? <Loader2 size={13} className="spin" /> : <Pause size={13} />} 接管
            </button>
          )}
          <button className="icon-button" onClick={() => { setShotAt(Date.now()); void status.refetch(); void evidence.refetch(); }} title="刷新浏览器状态" aria-label="刷新浏览器状态">
            {status.isFetching ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />}
          </button>
          {view?.running && (
            <button className="ghost-button" disabled={control.isPending} onClick={() => control.mutate("close")}>
              <X size={13} /> 关闭
            </button>
          )}
        </div>
      </div>

      {(view?.tabs.length ?? 0) > 0 && (
        <div className="browser-tabs">
          {view!.tabs.map((tab) => (
            <span className={`browser-tab ${tab.active ? "active" : ""}`} key={tab.id}>
              <MousePointer2 size={12} />
              <span>{tab.title || "空白标签"}</span>
              <small>{safeHost(tab.url)}</small>
            </span>
          ))}
        </div>
      )}

      {view?.running && active && (
        <a className="browser-live" href={`/api/tasks/${taskId}/browser/screenshot?t=${shotAt}`} target="_blank" rel="noreferrer">
          <img src={`/api/tasks/${taskId}/browser/screenshot?t=${shotAt}`} alt="当前网页截图" />
          <span className="browser-live-hint"><ExternalLink size={13} /> 打开当前网页截图</span>
        </a>
      )}

      {latest && (
        <div className="browser-evidence">
          <div className="browser-evidence-head">
            <strong>最近动作</strong>
            <span>{latest.kind} · {relativeTime(latest.createdAt)} · {safeHost(latest.url)}</span>
          </div>
          <div className="browser-evidence-shots">
            {latest.screenshotBefore && (
              <a href={evidenceUrl(taskId, latest.screenshotBefore)} target="_blank" rel="noreferrer">
                <img src={evidenceUrl(taskId, latest.screenshotBefore)} alt="动作前截图" />
                <small>动作前</small>
              </a>
            )}
            {latest.screenshotAfter && (
              <a href={evidenceUrl(taskId, latest.screenshotAfter)} target="_blank" rel="noreferrer">
                <img src={evidenceUrl(taskId, latest.screenshotAfter)} alt="动作后截图" />
                <small>动作后</small>
              </a>
            )}
          </div>
        </div>
      )}

      {!view?.running && records.length === 0 && (
        <div className="browser-empty">还没有打开过网页。</div>
      )}
      {error && <p className="form-error"><AlertTriangle size={13} /> {error}</p>}
    </section>
  );
}

function evidenceUrl(taskId: string, name: string): string {
  return `/api/tasks/${encodeURIComponent(taskId)}/browser/evidence/${encodeURIComponent(name)}`;
}

function safeHost(value: string): string {
  try {
    return new URL(value).hostname;
  } catch {
    return value || "空白";
  }
}
