import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  Cpu,
  Loader2,
  RefreshCw,
  Save,
  Wrench
} from "lucide-react";
import type { ExecutorId, ExecutorProbeResult } from "../lib/types.ts";
import { api } from "../lib/api.ts";

type Busy = `probe:${ExecutorId}` | "save" | null;

export function ExecutorSettingsPanel() {
  const queryClient = useQueryClient();
  const executorsQuery = useQuery({ queryKey: ["executors"], queryFn: api.executors, refetchInterval: 30_000 });
  const executorSettingsQuery = useQuery({ queryKey: ["executorSettings"], queryFn: api.executorSettings });
  const [concurrency, setConcurrency] = useState<Record<ExecutorId, number> | null>(null);
  const [preferredExecutorId, setPreferredExecutorId] = useState<ExecutorId | "">("");
  const [busy, setBusy] = useState<Busy>(null);
  const [probes, setProbes] = useState<Partial<Record<ExecutorId, ExecutorProbeResult>>>({});
  const [notice, setNotice] = useState<{ tone: "ok" | "error" | "info"; text: string } | null>(null);
  const initialized = useRef(false);
  const settingsInitialized = useRef(false);

  const executors = executorsQuery.data?.executors ?? [];

  useEffect(() => {
    if (!executorSettingsQuery.data || settingsInitialized.current) return;
    settingsInitialized.current = true;
    setPreferredExecutorId(executorSettingsQuery.data.settings.preferredExecutorId ?? "");
  }, [executorSettingsQuery.data]);

  useEffect(() => {
    if (!executorsQuery.data || initialized.current) return;
    initialized.current = true;
    const nextConcurrency = {} as Record<ExecutorId, number>;
    for (const executor of executorsQuery.data.executors) {
      nextConcurrency[executor.id] = executor.concurrency;
    }
    setConcurrency(nextConcurrency);
    setPreferredExecutorId(executorsQuery.data.preferredExecutorId ?? "native");
  }, [executorsQuery.data]);

  async function save() {
    if (!concurrency) return;
    setBusy("save");
    setNotice(null);
    try {
      const result = await api.saveExecutorSettings({
        defaultApprovalMode: "full",
        preferredExecutorId: preferredExecutorId || "native",
        concurrency
      });
      setNotice({ tone: "ok", text: `执行器设置已保存${result.settings.updatedAt ? `，更新时间 ${new Date(result.settings.updatedAt).toLocaleTimeString()}` : ""}。` });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["executors"] }),
        queryClient.invalidateQueries({ queryKey: ["executorSettings"] })
      ]);
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "保存执行器设置失败" });
    } finally {
      setBusy(null);
    }
  }

  async function probe(id: ExecutorId) {
    setBusy(`probe:${id}`);
    setNotice(null);
    try {
      const result = await api.probeExecutor(id);
      setProbes((prev) => ({ ...prev, [id]: result }));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["executors"] }),
        queryClient.invalidateQueries({ queryKey: ["executorSettings"] })
      ]);
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "执行器检测失败" });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="panel settings-section">
      <details className="settings-fold">
        <summary className="settings-fold-summary">
          <div className="settings-fold-copy">
            <strong>执行器管理</strong>
            <span>三个内置执行器统一检测和会话路由</span>
          </div>
        </summary>
        <div className="settings-body">
          <p className="settings-lead">默认使用原生执行器；手动切换后会立即应用到所有对话，不会自动匹配。</p>
          <div className="form-grid">
            <label>
              <span>全局优先执行器</span>
              <select value={preferredExecutorId} onChange={(event) => setPreferredExecutorId(event.target.value as ExecutorId)}>
                {executors.map((executor) => (
                  <option key={executor.id} value={executor.id}>{executor.name}{executor.health.canRun ? "" : "（当前不可用）"}</option>
                ))}
              </select>
            </label>
          </div>

          <div className="executor-manager">
            {executors.map((executor) => {
              const probeResult = probes[executor.id];
              const lastProbe = probeResult?.health.lastProbe ?? executor.health.lastProbe;
              const healthState = executor.health.state ?? (executor.health.canRun ? "ready" : "unverified");
              return (
                <article className="executor-card" key={executor.id}>
                  <header className="executor-card-head">
                    <div className="executor-card-title">
                      <span className="executor-card-icon">{executor.id === "native" ? <Cpu size={17} /> : <Wrench size={17} />}</span>
                      <div>
                        <strong>{executor.name}{executor.experimental ? <small className="executor-badge">实验</small> : null}</strong>
                        <span>{executor.provider ? `${executor.provider} · ` : ""}{executor.description}</span>
                      </div>
                    </div>
                    <span className={`status-chip ${executor.health.canRun ? "ok" : "warn"}`}>
                      <span className={`status-dot ${executor.health.canRun ? "online" : "offline"}`} />
                      {executorStateLabel(healthState)}
                    </span>
                  </header>

                  <div className="executor-card-meta">
                    <span><small>版本</small>{executor.health.version ?? "未检测"}</span>
                    <span><small>入口</small><code>{executor.health.command || "未找到"}</code></span>
                    <span><small>安装</small>{installStateLabel(executor.health.installState)}</span>
                  </div>

                  {executor.health.issues.length > 0 && (
                    <div className="executor-card-issues">
                      {executor.health.issues.map((issue) => <p key={issue}><AlertTriangle size={13} /> {issue}</p>)}
                    </div>
                  )}

                  <div className="executor-card-grid">
                    <label>
                      <span>并行数</span>
                      <input
                        type="number"
                        min={1}
                        max={4}
                        value={concurrency?.[executor.id] ?? executor.concurrency}
                        onChange={(event) => setConcurrency((prev) => prev ? { ...prev, [executor.id]: clampConcurrency(event.target.value) } : prev)}
                      />
                    </label>
                  </div>

                  <div className="executor-card-actions">
                    <button type="button" className="ghost-button compact" onClick={() => void probe(executor.id)} disabled={busy !== null}>
                      {busy === `probe:${executor.id}` ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
                      {busy === `probe:${executor.id}` ? "测试中…" : "测试可用性"}
                    </button>
                  </div>

                  {probeResult && (
                    <div className={`executor-probe ${probeResult.ok ? "ok" : "error"}`}>
                      {probeResult.ok ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
                      <span>{probeResult.ok ? `真实请求通过 · ${probeResult.version ?? "版本未知"}` : probeResult.error ?? "真实请求失败"}（{probeResult.elapsedMs} ms）</span>
                    </div>
                  )}
                  {!probeResult && lastProbe && (
                    <div className={`executor-probe ${lastProbe.ok ? "ok" : "error"}`}>
                      {lastProbe.ok ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
                      <span>{lastProbe.ok ? "上次真实请求通过" : `上次真实请求失败：${lastProbe.error ?? lastProbe.code ?? "未知错误"}`} · {new Date(lastProbe.checkedAt).toLocaleString()}（{lastProbe.elapsedMs} ms）</span>
                    </div>
                  )}
                </article>
              );
            })}
          </div>

          <div className="settings-actions">
            <button className="primary-button" onClick={() => void save()} disabled={busy !== null || !concurrency}>
              {busy === "save" ? <Loader2 size={15} className="spin" /> : <Save size={15} />} 保存执行器设置
            </button>
          </div>
          {notice && <div className={`settings-notice ${notice.tone}`}>{notice.tone === "ok" ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}<span>{notice.text}</span></div>}
        </div>
      </details>
    </section>
  );
}

function clampConcurrency(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(1, Math.min(4, Math.round(parsed)));
}

function installStateLabel(state: string | undefined): string {
  if (state === "available") return "已就绪";
  if (state === "needs_repair") return "需要修复";
  if (state === "update_available") return "可更新";
  if (state === "unsupported") return "不支持托管安装";
  return "未安装";
}

function executorStateLabel(state: string): string {
  if (state === "ready") return "真实可用";
  if (state === "quota_exceeded") return "额度不可用";
  if (state === "failed") return "测试失败";
  if (state === "missing") return "未连接";
  if (state === "unverified") return "未验证";
  return "未配置";
}
