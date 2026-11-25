import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ExternalLink,
  KeyRound,
  Loader2,
  LogIn,
  Monitor,
  PlugZap,
  X
} from "lucide-react";
import { api } from "../lib/api.ts";
import type { BrowserControlState, BrowserStatusView, BrowserTakeoverKind } from "../lib/types.ts";

const CONTROL_LABELS: Record<BrowserControlState, string> = {
  agent: "Agent 控制中",
  awaiting_user: "等待你接管",
  user: "你正在操作",
  closed: "未打开",
  unavailable: "浏览器不可用"
};

const TAKEOVER_LABELS: Record<BrowserTakeoverKind, string> = {
  login: "登录",
  captcha: "验证码",
  payment_confirmation: "支付确认",
  complex_interaction: "复杂交互",
  other: "网页操作"
};

export function BrowserTaskPanel({ taskId }: { taskId: string }) {
  const queryClient = useQueryClient();
  const [showConnect, setShowConnect] = useState(false);
  const [token, setToken] = useState("");
  const [profileDirName, setProfileDirName] = useState("");
  const browserQuery = useQuery({
    queryKey: ["browser", taskId],
    queryFn: () => api.browserStatus(taskId),
    staleTime: 1_000,
    refetchInterval: (query) => {
      const state = query.state.data?.controlState;
      return state && state !== "closed" ? 10_000 : false;
    }
  });

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["browser", taskId] }),
      queryClient.invalidateQueries({ queryKey: ["task", taskId] }),
      queryClient.invalidateQueries({ queryKey: ["tasks"] })
    ]);
  };

  const takeoverMutation = useMutation({
    mutationFn: (status: BrowserStatusView) => api.browserTakeover(taskId, {
      kind: status.takeoverKind ?? "other",
      reason: status.takeoverReason ?? `用户接管${TAKEOVER_LABELS[status.takeoverKind ?? "other"]}`
    }),
    onSuccess: refresh
  });

  const releaseMutation = useMutation({
    mutationFn: () => api.browserRelease(taskId),
    onSuccess: refresh
  });

  const connectMutation = useMutation({
    mutationFn: () => api.browserConnect(
      taskId,
      token.trim() || undefined,
      profileDirName.trim() || undefined
    ),
    onSuccess: async () => {
      setToken("");
      setProfileDirName("");
      setShowConnect(false);
      await refresh();
    }
  });

  const closeMutation = useMutation({
    mutationFn: () => api.browserClose(taskId),
    onSuccess: refresh
  });

  const status = browserQuery.data;
  if (!status || (status.controlState === "closed" && status.tabs.length === 0)) return null;

  const activeTab = status.tabs.find((tab) => tab.active) ?? status.tabs[0] ?? null;
  const busy = takeoverMutation.isPending || releaseMutation.isPending || connectMutation.isPending || closeMutation.isPending;
  const error = takeoverMutation.error ?? releaseMutation.error ?? connectMutation.error ?? closeMutation.error;

  return (
    <section className={`browser-task-panel browser-control-${status.controlState}`} aria-label="任务浏览器">
      <div className="browser-task-head">
        <span className="browser-task-title"><Monitor size={13} /> 浏览器</span>
        <span className="browser-control-badge">{CONTROL_LABELS[status.controlState]}</span>
        <span className="browser-backend">{status.backend === "extension" ? "日常 Chrome" : status.backend === "managed" ? "受管 Chrome" : "未连接"}</span>
      </div>

      {status.controlState === "awaiting_user" && (
        <div className="browser-takeover-callout">
          <LogIn size={15} />
          <div>
            <strong>需要你完成{TAKEOVER_LABELS[status.takeoverKind ?? "other"]}</strong>
            <p>{status.takeoverReason ?? "请在浏览器中完成当前页面操作，再继续 Agent。"}</p>
          </div>
        </div>
      )}

      {status.unavailableReason && <p className="browser-task-note">{status.unavailableReason}</p>}
      {status.requiresFreshObservation && status.controlState === "agent" && (
        <p className="browser-task-note">控制权已归还，Agent 会先重新读取页面再继续。</p>
      )}

      {activeTab && (
        <div className="browser-task-preview">
          <img
            src={`/api/tasks/${encodeURIComponent(taskId)}/browser/screenshot?t=${encodeURIComponent(status.lastObservedAt ?? String(status.controlEpoch))}`}
            alt={`${activeTab.title || "网页"} 截图`}
          />
          <div className="browser-task-page">
            <strong>{activeTab.title || "当前网页"}</strong>
            <span className="mono select-all">{activeTab.url}</span>
            {status.tabs.length > 1 && <span>{status.tabs.length} 个标签页，当前 {activeTab.id}</span>}
          </div>
        </div>
      )}

      <div className="browser-task-actions">
        {(status.controlState === "agent" || status.controlState === "awaiting_user") && (
          <button type="button" className="ghost-button small" onClick={() => takeoverMutation.mutate(status)} disabled={busy}>
            {takeoverMutation.isPending ? <Loader2 size={12} className="spin" /> : <LogIn size={12} />}
            {status.controlState === "awaiting_user" ? "开始接管" : "接管"}
          </button>
        )}
        {(status.controlState === "user" || status.controlState === "awaiting_user") && (
          <button type="button" className="ghost-button small" onClick={() => releaseMutation.mutate()} disabled={busy}>
            {releaseMutation.isPending ? <Loader2 size={12} className="spin" /> : <ArrowLeft size={12} />}
            继续 Agent
          </button>
        )}
        <button type="button" className="ghost-button small" onClick={() => setShowConnect((value) => !value)} disabled={busy}>
          <PlugZap size={12} /> 连接日常 Chrome
        </button>
        <button type="button" className="ghost-button small danger" onClick={() => closeMutation.mutate()} disabled={busy}>
          {closeMutation.isPending ? <Loader2 size={12} className="spin" /> : <X size={12} />}
          关闭浏览器
        </button>
      </div>

      {showConnect && (
        <div className="browser-extension-connect">
          <p>
            安装 Playwright Extension 后，Hearth 会把当前任务接到你正在使用的 Chrome。尚未安装时，Agent 使用受管 Chrome。
          </p>
          <a href={status.extension.installUrl} target="_blank" rel="noreferrer">
            打开扩展安装页 <ExternalLink size={11} />
          </a>
          <label>
            <span><KeyRound size={12} /> 扩展配对 token（可选）</span>
            <input
              type="password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder={status.extension.paired ? "已配对，需要更换时可粘贴新 token" : "粘贴 extension UI 生成的 token"}
              autoComplete="off"
            />
          </label>
          <label>
            <span>Chrome 资料目录名（推荐）</span>
            <input
              value={profileDirName}
              onChange={(event) => setProfileDirName(event.target.value)}
              placeholder="例如 Profile 1；留空时由扩展选择最近使用的账号"
              autoComplete="off"
            />
          </label>
          <button type="button" className="ghost-button small" onClick={() => connectMutation.mutate()} disabled={busy}>
            {connectMutation.isPending ? <Loader2 size={12} className="spin" /> : <PlugZap size={12} />}
            连接并接管当前任务
          </button>
        </div>
      )}

      {error && <p className="inline-run-error">{error instanceof Error ? error.message : "浏览器操作失败"}</p>}
    </section>
  );
}
