import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import type { ExecutorBootstrapState } from "../lib/use-executor-bootstrap.ts";

export function ExecutorBootstrapStatus({ state }: { state: ExecutorBootstrapState }) {
  if (state.status === "error") {
    return (
      <div className="executor-install-status error" role="alert">
        <AlertTriangle size={14} />
        <span>{state.error}</span>
      </div>
    );
  }

  if (state.status === "complete") {
    return (
      <div className="executor-install-status complete" role="status">
        <CheckCircle2 size={14} />
        <span>{state.progress.message}</span>
      </div>
    );
  }

  const percent = Math.max(0, Math.min(100, state.progress.percent ?? 0));
  return (
    <div className="executor-install-status" role="status" aria-live="polite">
      <div className="executor-install-status-head">
        <Loader2 size={14} className="spin" />
        <span>{state.progress.message}</span>
        <strong>{phaseLabel(state.progress.phase)}</strong>
      </div>
      <div
        className="executor-install-track"
        role="progressbar"
        aria-label={state.progress.message}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <span style={{ width: `${percent}%` }} />
      </div>
      {state.progress.bytes !== undefined && state.progress.estimatedBytes !== undefined && (
        <small>
          {formatBytes(state.progress.bytes)} / 约 {formatBytes(state.progress.estimatedBytes)}，进度按本地写入量估算
        </small>
      )}
    </div>
  );
}

function phaseLabel(phase: string): string {
  if (phase === "verify") return "验证";
  if (phase === "bind") return "绑定";
  if (phase === "probe") return "测试";
  return "安装";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(0, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 100 * 1024 * 1024 ? 1 : 0)} MB`;
}
