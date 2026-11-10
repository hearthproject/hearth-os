import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  Cpu,
  Download,
  Loader2,
  RefreshCw,
  Save,
  ShieldAlert,
  ShieldCheck,
  Wrench
} from "lucide-react";
import type {
  ExecutorId,
  ExecutorInstallJob,
  ExecutorProbeResult,
  ExecutorRuntimeSettings
} from "../lib/types.ts";
import { api } from "../lib/api.ts";

interface RuntimeDraft {
  command: string;
  executablePath: string;
  authMode: "" | "local" | "pat" | "env";
}

type Busy = `probe:${ExecutorId}` | `install:${ExecutorId}` | "save" | null;

const EMPTY_RUNTIME: RuntimeDraft = { command: "", executablePath: "", authMode: "" };

export function ExecutorSettingsPanel() {
  const queryClient = useQueryClient();
  const executorsQuery = useQuery({ queryKey: ["executors"], queryFn: api.executors, refetchInterval: 30_000 });
  const executorSettingsQuery = useQuery({ queryKey: ["executorSettings"], queryFn: api.executorSettings });
  const [drafts, setDrafts] = useState<Partial<Record<ExecutorId, RuntimeDraft>>>({});
  const [concurrency, setConcurrency] = useState<Record<ExecutorId, number> | null>(null);
  const [defaultApprovalMode, setDefaultApprovalMode] = useState<"necessary" | "full">("necessary");
  const [preferredExecutorId, setPreferredExecutorId] = useState<ExecutorId | "">("");
  const [busy, setBusy] = useState<Busy>(null);
  const [jobs, setJobs] = useState<Partial<Record<ExecutorId, ExecutorInstallJob>>>({});
  const [probes, setProbes] = useState<Partial<Record<ExecutorId, ExecutorProbeResult>>>({});
  const [notice, setNotice] = useState<{ tone: "ok" | "error" | "info"; text: string } | null>(null);
  const initialized = useRef(false);
  const settingsInitialized = useRef(false);

  const executors = executorsQuery.data?.executors ?? [];

  useEffect(() => {
    if (!executorSettingsQuery.data || settingsInitialized.current) return;
    settingsInitialized.current = true;
    setDefaultApprovalMode(executorSettingsQuery.data.settings.defaultApprovalMode);
    setPreferredExecutorId(executorSettingsQuery.data.settings.preferredExecutorId ?? "");
  }, [executorSettingsQuery.data]);

  useEffect(() => {
    if (!executorsQuery.data || initialized.current) return;
    initialized.current = true;
    const nextDrafts: Partial<Record<ExecutorId, RuntimeDraft>> = {};
    const nextConcurrency = {} as Record<ExecutorId, number>;
    for (const executor of executorsQuery.data.executors) {
      nextConcurrency[executor.id] = executor.concurrency;
      if (executor.id === "native" || executor.id === "codex") continue;
      nextDrafts[executor.id] = {
        command: executor.runtime.command ?? "",
        executablePath: executor.runtime.executablePath ?? "",
        authMode: executor.runtime.authMode ?? ""
      };
    }
    setDrafts(nextDrafts);
    setConcurrency(nextConcurrency);
    setPreferredExecutorId(executorsQuery.data.preferredExecutorId ?? "");
  }, [executorsQuery.data]);

  useEffect(() => {
    const running = Object.values(jobs).filter((job) => job?.status === "running");
    if (running.length === 0) return;
    let active = true;
    const timer = setInterval(() => {
      for (const job of running) {
        void api.executorInstall(job.id).then((result) => {
          if (!active) return;
          setJobs((prev) => ({ ...prev, [job.id]: result.job ?? prev[job.id] }));
          if (result.job?.status !== "running") void queryClient.invalidateQueries({ queryKey: ["executors"] });
        }).catch(() => undefined);
      }
    }, 1_500);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [jobs, queryClient]);

  function patchDraft(id: ExecutorId, patch: Partial<RuntimeDraft>) {
    setDrafts((prev) => ({ ...prev, [id]: { ...(prev[id] ?? EMPTY_RUNTIME), ...patch } }));
  }

  async function save() {
    if (!concurrency) return;
    setBusy("save");
    setNotice(null);
    try {
      const runtime: Partial<Record<ExecutorId, ExecutorRuntimeSettings>> = {};
      for (const [id, draft] of Object.entries(drafts) as [ExecutorId, RuntimeDraft][]) {
        const entry: ExecutorRuntimeSettings = {
          ...(draft.command.trim() ? { command: draft.command.trim() } : {}),
          ...(draft.executablePath.trim() ? { executablePath: draft.executablePath.trim() } : {}),
          ...(draft.authMode ? { authMode: draft.authMode } : {})
        };
        if (Object.keys(entry).length > 0) runtime[id] = entry;
      }
      const result = await api.saveExecutorSettings({
        defaultApprovalMode,
        preferredExecutorId: preferredExecutorId || null,
        concurrency,
        executors: runtime
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

  async function install(id: ExecutorId) {
    setBusy(`install:${id}`);
    setNotice(null);
    try {
      const result = await api.installExecutor(id);
      if (result.job) setJobs((prev) => ({ ...prev, [id]: result.job as ExecutorInstallJob }));
      setNotice({ tone: "info", text: `${id} 安装已启动，完成后会自动刷新状态。` });
      await queryClient.invalidateQueries({ queryKey: ["executors"] });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "安装启动失败" });
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
            <span>七个执行器统一安装、检测、路径与会话路由</span>
          </div>
          <span className={`status-chip ${defaultApprovalMode === "full" ? "warn" : "ok"}`}>
            {defaultApprovalMode === "full" ? <ShieldAlert size={13} /> : <ShieldCheck size={13} />}
            {defaultApprovalMode === "full" ? "完全权限" : "必要审批"}
          </span>
        </summary>
        <div className="settings-body">
          <p className="settings-lead">默认权限和优先执行器只影响之后新建的对话；已有对话保持自己的选择。</p>
          <div className="form-grid">
            <label>
              <span>新对话默认权限</span>
              <select value={defaultApprovalMode} onChange={(event) => setDefaultApprovalMode(event.target.value as "necessary" | "full")}>
                <option value="necessary">必要审批</option>
                <option value="full">完全权限（警示）</option>
              </select>
            </label>
            <label>
              <span>全局优先执行器</span>
              <select value={preferredExecutorId} onChange={(event) => setPreferredExecutorId(event.target.value as ExecutorId | "")}>
                <option value="">按任务自动选择</option>
                {executors.map((executor) => (
                  <option key={executor.id} value={executor.id}>{executor.name}{executor.health.canRun ? "" : "（当前不可用）"}</option>
                ))}
              </select>
            </label>
          </div>

          <div className="executor-manager">
            {executors.map((executor) => {
              const draft = drafts[executor.id] ?? EMPTY_RUNTIME;
              const editable = executor.id !== "native" && executor.id !== "codex";
              const job = jobs[executor.id] ?? executor.install.job;
              const probeResult = probes[executor.id];
              const lastProbe = probeResult?.health.lastProbe ?? executor.health.lastProbe;
              const healthState = executor.health.state ?? (executor.health.canRun ? "ready" : "unverified");
              const jobRunning = job?.status === "running";
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
                    {editable && (
                      <label>
                        <span>{executor.id === "qoder" ? "qodercli 命令" : "命令"}</span>
                        <input
                          value={draft.command}
                          onChange={(event) => patchDraft(executor.id, { command: event.target.value })}
                          placeholder={executor.id === "hermes" ? "hermes" : executor.id === "qoder" ? "qodercli" : "命令或留空自动检测"}
                          spellCheck={false}
                        />
                      </label>
                    )}
                    {editable && (
                      <label className="executor-path-field">
                        <span>程序 / 脚本路径</span>
                        <input
                          value={draft.executablePath}
                          onChange={(event) => patchDraft(executor.id, { executablePath: event.target.value })}
                          placeholder="可选；留空时自动检测安装目录和 PATH"
                          spellCheck={false}
                        />
                      </label>
                    )}
                    {executor.id === "qoder" && (
                      <label>
                        <span>认证方式</span>
                        <select value={draft.authMode || "local"} onChange={(event) => patchDraft(executor.id, { authMode: event.target.value as RuntimeDraft["authMode"] })}>
                          <option value="local">本机 qodercli 登录</option>
                          <option value="pat">个人访问令牌</option>
                          <option value="env">环境变量</option>
                        </select>
                      </label>
                    )}
                  </div>

                  <div className="executor-card-actions">
                    <button type="button" className="ghost-button compact" onClick={() => void probe(executor.id)} disabled={busy !== null}>
                      {busy === `probe:${executor.id}` ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
                      {busy === `probe:${executor.id}` ? "测试中…" : "测试可用性"}
                    </button>
                    {executor.install.supported && (
                      <button type="button" className="primary-button compact" onClick={() => void install(executor.id)} disabled={busy !== null || jobRunning}>
                        {busy === `install:${executor.id}` || jobRunning ? <Loader2 size={14} className="spin" /> : <Download size={14} />} 一键安装
                      </button>
                    )}
                    {executor.install.packageSpec && <code className="executor-package">{executor.install.packageSpec}</code>}
                  </div>

                  {!executor.install.supported && executor.install.hint && <p className="executor-card-hint">{executor.install.hint}</p>}
                  {executor.install.supported && executor.install.hint && <p className="executor-card-hint">{executor.install.hint}</p>}

                  {job && (
                    <div className={`executor-job ${job.status}`}>
                      <strong>{job.status === "running" ? "安装中" : job.status === "succeeded" ? "安装完成" : "安装失败"}</strong>
                      <span>{job.packageSpec} · {new Date(job.startedAt).toLocaleString()}</span>
                      {job.error && <p>{job.error}</p>}
                      {job.log && <pre>{tail(job.log, 2_000)}</pre>}
                    </div>
                  )}

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
          <p className="settings-hint"><ShieldAlert size={13} /> 完全权限会让执行器自行决定并执行所有步骤；外部执行器仍受各自 CLI 的沙箱和登录状态约束。</p>
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

function tail(text: string, length: number): string {
  return text.length > length ? text.slice(-length) : text;
}
