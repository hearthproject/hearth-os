import { useQuery } from "@tanstack/react-query";
import { ProactiveSettingsPanel } from "../components/ProactiveSettingsPanel.tsx";
import { Download, FileJson, RefreshCw } from "lucide-react";
import { api } from "../lib/api.ts";
import { countTotal, formatBytes, formatDuration, formatNumber, formatTokens } from "../lib/format.ts";
import { AUTH_SOURCE_LABELS } from "../lib/labels.ts";
import { useViewMode } from "../lib/view-mode.tsx";

export function SettingsPage() {
  const { mode } = useViewMode();
  const pro = mode === "pro";
  const healthQuery = useQuery({ queryKey: ["health"], queryFn: api.health, refetchInterval: 20_000 });
  const proactiveQuery = useQuery({ queryKey: ["proactive"], queryFn: api.proactive, refetchInterval: 20_000 });
  const statsQuery = useQuery({ queryKey: ["stats"], queryFn: api.stats, refetchInterval: 30_000, enabled: pro });
  const health = healthQuery.data;
  const stats = statsQuery.data;

  return (
    <div className="page settings-page">
      <div className="page-head">
        <h1>设置</h1>
        <button className="ghost-button" onClick={() => void healthQuery.refetch()} disabled={healthQuery.isFetching}>
          <RefreshCw size={15} className={healthQuery.isFetching ? "spin" : ""} /> 重新检查
        </button>
      </div>

      <section className="panel">
        <div className="panel-head">
          <h2>执行器</h2>
          <span className="panel-meta">{health ? (health.codex.canRun ? "可用" : "不可用") : "读取中"}</span>
        </div>
        <dl className="kv-grid">
          <div><dt>状态</dt><dd>{health?.codex.canRun ? "可以开始工作" : health ? (health.codex.issues.join("；") || "本机配置不完整") : "正在读取本机配置"}</dd></div>
          <div><dt>Provider</dt><dd>{health?.codex.providerName ?? "—"}</dd></div>
          <div><dt>模型</dt><dd>{health?.codex.model ?? "默认模型"}</dd></div>
          <div><dt>认证来源</dt><dd>{health ? AUTH_SOURCE_LABELS[health.codex.authSource] ?? health.codex.authSource : "—"}</dd></div>
          {pro && <div><dt>Provider ID</dt><dd className="mono select-all">{health?.codex.providerId ?? "—"}</dd></div>}
          {pro && health && health.codex.issues.length > 0 && (
            <div><dt>问题</dt><dd className="mono">{health.codex.issues.join("；")}</dd></div>
          )}
        </dl>
        <p className="page-meta">密钥只由本机服务进程读取，不进入浏览器。</p>
      </section>

      {proactiveQuery.data && <ProactiveSettingsPanel snapshot={proactiveQuery.data} />}

      <section className="panel">
        <div className="panel-head"><h2>本机数据</h2></div>
        <dl className="kv-grid">
          <div><dt>服务地址</dt><dd className="mono">127.0.0.1:4317</dd></div>
          <div><dt>运行数据</dt><dd className="mono">.hearth/</dd></div>
          <div><dt>产物目录</dt><dd className="mono">eval/runs/</dd></div>
        </dl>
        <div className="settings-actions">
          <button className="ghost-button" onClick={api.downloadBackup}><Download size={15} /> 下载数据库备份</button>
          <button className="ghost-button" onClick={api.downloadExport}><FileJson size={15} /> 导出任务记录</button>
        </div>
      </section>

      {pro && (
        <section className="panel">
          <div className="panel-head">
            <h2>用量</h2>
            <span className="panel-meta">{stats ? `事实记录 ${formatNumber(stats.events.total)} 条` : "读取中"}</span>
          </div>
          {stats && (
            <dl className="kv-grid">
              <div><dt>任务</dt><dd>{formatNumber(stats.tasks.total)} · 已完成 {formatNumber(stats.tasks.byStatus.completed)}</dd></div>
              <div><dt>执行</dt><dd>{formatNumber(stats.runs.total)} 次 · 失败 {formatNumber(stats.runs.byStatus.failed)}</dd></div>
              <div><dt>累计时长</dt><dd>{formatDuration(stats.runs.durationMs)}</dd></div>
              <div><dt>Token</dt><dd className="mono">{formatTokens(stats.runs.usage)}</dd></div>
              <div>
                <dt>输入明细</dt>
                <dd className="mono">
                  {stats.runs.usage
                    ? `输入 ${formatNumber(stats.runs.usage.inputTokens)} · 缓存 ${formatNumber(stats.runs.usage.cachedInputTokens)} · 输出 ${formatNumber(stats.runs.usage.outputTokens)} · 推理 ${formatNumber(stats.runs.usage.reasoningOutputTokens)}`
                    : "未记录"}
                </dd>
              </div>
              <div><dt>外部动作</dt><dd>{formatNumber(countTotal(stats.effects.byStatus))}</dd></div>
              <div><dt>审批</dt><dd>待决定 {stats.approvals.byStatus.pending} · 已拒绝 {stats.approvals.byStatus.rejected} · 已过期 {stats.approvals.byStatus.expired}</dd></div>
              <div><dt>产物</dt><dd>{stats.artifacts.count} 个 · {formatBytes(stats.artifacts.bytes)}</dd></div>
              <div><dt>事实记录水位</dt><dd className="mono">seq {formatNumber(stats.events.latestSeq)}</dd></div>
            </dl>
          )}
        </section>
      )}

      <section className="panel">
        <div className="panel-head"><h2>边界</h2></div>
        <ul className="plain-list">
          <li>执行器在隔离任务工作区中运行</li>
          <li>默认禁用联网、网页搜索和 GitHub 凭据</li>
          <li>推送、评论、发布前必须单独审批</li>
          <li>失败不会重复已经执行的外部动作</li>
        </ul>
      </section>
    </div>
  );
}
