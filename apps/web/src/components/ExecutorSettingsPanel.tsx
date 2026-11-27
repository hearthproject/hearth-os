import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  Cpu,
  Download,
  Loader2,
  RefreshCw,
  Wrench
} from "lucide-react";
import type { ExecutorId, ExecutorModelBindingView, ExecutorProbeResult, ExecutorTeamCapability, ExecutorView, TaskFollowUpMode } from "../lib/types.ts";
import { api } from "../lib/api.ts";
import { ExecutorBootstrapStatus } from "./ExecutorBootstrapStatus.tsx";
import { useExecutorBootstrap } from "../lib/use-executor-bootstrap.ts";

type Busy = `probe:${ExecutorId}` | `bootstrap:${ExecutorId}` | `bind:${ExecutorId}` | `team:${ExecutorId}` | "settings" | null;
type Notice = { tone: "ok" | "error" | "info"; text: string } | null;

const EXECUTOR_LABELS: Record<ExecutorId, string> = {
  native: "Hearth 原生",
  codex: "Codex",
  "deepseek-harness": "DeepSeek Harness"
};

export function ExecutorSettingsPanel() {
  const queryClient = useQueryClient();
  const { installs, bootstrap: runBootstrap } = useExecutorBootstrap();
  const executorsQuery = useQuery({ queryKey: ["executors"], queryFn: api.executors, refetchInterval: 30_000 });
  const executorSettingsQuery = useQuery({ queryKey: ["executorSettings"], queryFn: api.executorSettings });
  const registryQuery = useQuery({ queryKey: ["modelRegistry"], queryFn: api.modelRegistry });
  const [preferredExecutorId, setPreferredExecutorId] = useState<ExecutorId | "">("native");
  const [followUpMode, setFollowUpMode] = useState<TaskFollowUpMode>("queue");
  const [busy, setBusy] = useState<Busy>(null);
  const [probes, setProbes] = useState<Partial<Record<ExecutorId, ExecutorProbeResult>>>({});
  const [notice, setNotice] = useState<Notice>(null);

  useEffect(() => {
    const settings = executorSettingsQuery.data?.settings;
    if (!settings) return;
    setPreferredExecutorId(settings.preferredExecutorId ?? "native");
    setFollowUpMode(settings.followUpMode ?? "queue");
  }, [executorSettingsQuery.data?.settings]);

  const executors = executorsQuery.data?.executors ?? [];
  const bindings = registryQuery.data?.bindings ?? [];
  const profiles = registryQuery.data?.profiles ?? [];

  async function refreshAll() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["executors"] }),
      queryClient.invalidateQueries({ queryKey: ["executorSettings"] }),
      queryClient.invalidateQueries({ queryKey: ["modelRegistry"] }),
      queryClient.invalidateQueries({ queryKey: ["health"] })
    ]);
  }

  async function savePreferredExecutor(next: ExecutorId) {
    setBusy("settings");
    setNotice(null);
    try {
      const result = await api.saveExecutorSettings({ preferredExecutorId: next });
      setPreferredExecutorId(result.settings.preferredExecutorId ?? "native");
      setNotice({ tone: "ok", text: "执行器偏好已保存。" });
      await refreshAll();
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "保存执行器设置失败" });
      const settings = executorSettingsQuery.data?.settings;
      if (settings) setPreferredExecutorId(settings.preferredExecutorId ?? "native");
    } finally {
      setBusy(null);
    }
  }

  function choosePreferred(next: ExecutorId) {
    setPreferredExecutorId(next);
    void savePreferredExecutor(next);
  }

  async function saveFollowUpMode(next: TaskFollowUpMode) {
    setFollowUpMode(next);
    setBusy("settings");
    setNotice(null);
    try {
      const result = await api.saveExecutorSettings({ followUpMode: next });
      setFollowUpMode(result.settings.followUpMode);
      queryClient.setQueryData(["executorSettings"], result);
      setNotice({ tone: "ok", text: next === "queue" ? "后续消息将默认排队。" : "后续消息将默认中止当前轮并引导执行。" });
    } catch (error) {
      setFollowUpMode(executorSettingsQuery.data?.settings.followUpMode ?? "queue");
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "保存后续消息设置失败" });
    } finally {
      setBusy(null);
    }
  }

  async function bind(executorId: ExecutorId, profileId: string) {
    setBusy(`bind:${executorId}`);
    setNotice(null);
    try {
      const result = await api.saveExecutorModelBinding(executorId, { profileId: profileId || null, protocolOverride: null, modelOverride: null });
      setNotice({
        tone: result.health && !result.health.canRun && result.health.state === "unverified" ? "info" : "ok",
        text: result.health && !result.health.canRun && result.health.state === "unverified"
          ? `${EXECUTOR_LABELS[executorId]} 已绑定模型，运行一次真实测试后启用。`
          : `${EXECUTOR_LABELS[executorId]} 的模型已更新。`
      });
      await refreshAll();
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "模型绑定保存失败" });
    } finally {
      setBusy(null);
    }
  }

  async function installTeam(executorId: ExecutorId) {
    setBusy(`team:${executorId}`);
    setNotice({ tone: "info", text: "正在安装团队运行时，请保持设置页打开。" });
    try {
      const result = await api.installTeamRuntime(executorId);
      setNotice({ tone: "ok", text: result.result.message });
      await refreshAll();
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "团队运行时安装失败" });
    } finally {
      setBusy(null);
    }
  }

  async function probe(executorId: ExecutorId) {    setBusy(`probe:${executorId}`);
    setNotice(null);
    try {
      const result = await api.probeExecutor(executorId);
      setProbes((previous) => ({ ...previous, [executorId]: result }));
      setNotice(result.ok
        ? { tone: "ok", text: `${EXECUTOR_LABELS[executorId]} 真实测试通过。` }
        : { tone: "error", text: `${EXECUTOR_LABELS[executorId]} 真实测试未通过：${result.error ?? "未知原因"}` });
      await refreshAll();
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "测试失败" });
    } finally {
      setBusy(null);
    }
  }

  async function bootstrap(executorId: ExecutorId) {
    setBusy(`bootstrap:${executorId}`);
    setNotice({ tone: "info", text: "正在准备执行器。首次下载可能需要几分钟，请不要关闭设置页。" });
    try {
      const result = await runBootstrap(executorId);
      setProbes((previous) => ({ ...previous, [executorId]: result.probe }));
      const bound = result.binding?.effectiveModel ?? "";
      setNotice(result.probe.ok
        ? { tone: "ok", text: `${result.install.message}${bound ? ` 已绑定 ${bound}，` : ""}真实测试通过。` }
        : { tone: result.bindingError ? "info" : "error", text: result.bindingError ? `${result.install.message} 配置兼容模型后可自动绑定。` : `${result.install.message} 但测试未通过：${result.probe.error ?? "未知原因"}` });
      await refreshAll();
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "执行器安装失败" });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="executor-settings-panel">
      <div className="section-heading">
        <div><h3>执行器</h3></div>
        {busy === "settings" && <span className="settings-save-state"><Loader2 size={12} className="spin" /> 正在保存</span>}
      </div>

      <div className="executor-global-settings">
        <label>
          <span>优先执行器</span>
          <select
            aria-label="全局优先执行器"
            value={preferredExecutorId}
            disabled={busy === "settings"}
            onChange={(event) => choosePreferred(event.target.value as ExecutorId)}
          >
            {executors.map((executor) => (
              <option key={executor.id} value={executor.id}>
                {executor.name}{executor.health.canRun ? "" : "（当前不可用）"}
              </option>
            ))}
          </select>
        </label>
        <div className="executor-setting-field">
          <span>后续消息处理方式</span>
          <div className="segmented executor-follow-up-mode" role="group" aria-label="后续消息处理方式">
            <button
              type="button"
              className={followUpMode === "queue" ? "active" : ""}
              aria-pressed={followUpMode === "queue"}
              disabled={busy === "settings"}
              onClick={() => void saveFollowUpMode("queue")}
            >
              排队
            </button>
            <button
              type="button"
              className={followUpMode === "steer" ? "active" : ""}
              aria-pressed={followUpMode === "steer"}
              disabled={busy === "settings"}
              onClick={() => void saveFollowUpMode("steer")}
            >
              引导
            </button>
          </div>
          <small>{followUpMode === "queue" ? "当前轮结束后再处理新消息。" : "安全中止当前轮并立即应用新指令。"} Ctrl+Enter 可对单条消息采用相反方式。</small>
        </div>
      </div>

      {(executorsQuery.isLoading || registryQuery.isLoading) && (
        <p className="inline-loading"><Loader2 size={14} className="spin" /> 正在读取执行器</p>
      )}

      <div className="executor-list">
        {executors.map((executor) => {
          const binding = bindings.find((item) => item.executorId === executor.id);
          const profileOptions = binding
            ? profiles.filter((profile) => binding.allowedProtocols.includes(profile.protocol))
            : [];
          const probeResult = probes[executor.id];
          const lastProbe = probeResult?.health.lastProbe ?? executor.health.lastProbe;
          const state = executor.health.state ?? (executor.health.canRun ? "ready" : "unverified");
          const install = installs[executor.id];
          const detected = executor.id === "native" || executor.health.installState !== "missing";
          const status = bindingStatus(binding, executor);
          const needsSetup = executor.id !== "native" && (!executor.health.canRun || !binding?.available);
          const rowBusy = busy === `bind:${executor.id}` || busy === `probe:${executor.id}` || busy === `bootstrap:${executor.id}` || busy === `team:${executor.id}`;
          const teamCapability = executor.teamCapability;
          const teamStatus = teamCapability ? teamCapabilityStatus(teamCapability.state) : null;

          return (
            <article className="executor-row" key={executor.id}>
              <div className="executor-row-head">
                <div className="executor-row-title">
                  <span className="executor-row-icon">{executor.id === "native" ? <Cpu size={16} /> : <Wrench size={16} />}</span>
                  <div>
                    <strong>{executor.name}{executor.experimental ? <small className="executor-badge">实验</small> : null}</strong>
                    <span>{executor.provider ?? executorStateLabel(state, detected)}</span>
                  </div>
                </div>
                <span className={`status-chip ${status.tone}`}>
                  <span className={`status-dot ${status.dot}`} />
                  {status.label}
                </span>
              </div>

              {teamCapability && teamStatus && (
                <div className="executor-team-row">
                  <span className={`status-chip ${teamStatus.tone}`}>
                    <span className={`status-dot ${teamStatus.dot}`} />
                    团队 · {teamStatus.label}
                  </span>
                  <span className="executor-team-detail">{teamCapabilityDescription(teamCapability, executor.id)}</span>
                  {teamCapability.repair === "install-team-runtime" && (
                    <button type="button" className="ghost-button compact" onClick={() => void installTeam(executor.id)} disabled={busy !== null}>
                      {busy === `team:${executor.id}` ? <Loader2 size={13} className="spin" /> : <Download size={13} />}
                      安装团队运行时
                    </button>
                  )}
                  {teamCapability.repair === "update-executor" && (
                    <span className="executor-team-hint">更新执行器后可用</span>
                  )}
                </div>
              )}

              <div className="executor-row-controls">
                <label>
                  <span>模型</span>
                  <select
                    aria-label={`${executor.name} 模型`}
                    value={binding?.profileId ?? ""}
                    disabled={rowBusy || !binding}
                    onChange={(event) => void bind(executor.id, event.target.value)}
                  >
                    <option value="">未绑定</option>
                    {profileOptions.map((profile) => (
                      <option key={profile.id} value={profile.id}>{profile.name} · {profile.model}</option>
                    ))}
                  </select>
                </label>
                <div className="executor-row-actions">
                  {needsSetup && (
                    <button type="button" className="primary-button compact" onClick={() => void bootstrap(executor.id)} disabled={busy !== null}>
                      {busy === `bootstrap:${executor.id}` ? <Loader2 size={14} className="spin" /> : <Download size={14} />}
                      {executor.health.installState === "missing" ? "安装并启用" : "绑定并启用"}
                    </button>
                  )}
                  <button type="button" className="ghost-button compact" onClick={() => void probe(executor.id)} disabled={busy !== null}>
                    {busy === `probe:${executor.id}` ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />} 测试
                  </button>
                </div>
              </div>

              {install && <ExecutorBootstrapStatus state={install} />}

              <details className="executor-technical">
                <summary>技术信息</summary>
                <div className="executor-technical-body">
                  <p>{executor.description}</p>
                  <dl>
                    <div><dt>版本</dt><dd>{executor.health.version ?? "未检测"}</dd></div>
                    <div><dt>入口</dt><dd><code>{executor.health.command || "未找到"}</code></dd></div>
                    <div><dt>安装</dt><dd>{installStateLabel(executor.health.installState)}</dd></div>
                    {binding && <div><dt>协议</dt><dd>{binding.allowedProtocols.join(" · ")}</dd></div>}
                  </dl>
                  {executor.health.issues.length > 0 && executor.health.issues.map((issue) => (
                    <p className="executor-issue" key={issue}><AlertTriangle size={13} /> {issue}</p>
                  ))}
                  {probeResult && (
                    <p className={probeResult.ok ? "executor-probe ok" : "executor-probe error"}>
                      {probeResult.ok ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />}
                      {probeResult.ok ? `真实请求通过 · ${probeResult.version ?? "版本未知"}` : probeResult.error ?? "真实请求失败"}（{probeResult.elapsedMs} ms）
                    </p>
                  )}
                  {!probeResult && lastProbe && (
                    <p className={lastProbe.ok ? "executor-probe ok" : "executor-probe error"}>
                      {lastProbe.ok ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />}
                      {lastProbe.ok ? "上次真实请求通过" : `上次真实请求失败：${lastProbe.error ?? lastProbe.code ?? "未知错误"}`} · {new Date(lastProbe.checkedAt).toLocaleString()}（{lastProbe.elapsedMs} ms）
                    </p>
                  )}
                </div>
              </details>
            </article>
          );
        })}
      </div>

      {notice && (
        <div className={`settings-notice ${notice.tone}`}>
          {notice.tone === "ok" ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}
          <span>{notice.text}</span>
        </div>
      )}
    </section>
  );
}

function teamCapabilityStatus(state: ExecutorTeamCapability["state"]): { tone: "ok" | "warn"; dot: "online" | "offline" | "idle"; label: string } {
  if (state === "available") return { tone: "ok", dot: "online", label: "可用" };
  if (state === "probe_failed") return { tone: "warn", dot: "idle", label: "无法确认" };
  return { tone: "warn", dot: "offline", label: "不可用" };
}

function teamCapabilityDescription(capability: ExecutorTeamCapability, executorId: ExecutorId): string {
  if (capability.state === "unavailable" || capability.state === "probe_failed") {
    return capability.reason ?? "当前执行器不支持原生团队";
  }
  const owner = executorId === "native" ? "Hearth 编排" : executorId === "codex" ? "Codex 原生" : "DSH 原生";
  const visibility = capability.visibility === "members"
    ? "成员可见"
    : capability.visibility === "session-tree"
      ? "会话树可见"
      : "成员不可见";
  const limit = capability.limits
    ? capability.limits.maxDepth !== undefined
      ? `${capability.limits.maxConcurrent} 并发 / ${capability.limits.maxTotal} 累计 / 深度 ${capability.limits.maxDepth}`
      : `${capability.limits.maxConcurrent} 成员`
    : "";
  return [owner, visibility, limit].filter(Boolean).join(" · ");
}

function bindingStatus(binding: ExecutorModelBindingView | undefined, executor: ExecutorView) {  if (!binding?.profileId) return { tone: "warn", dot: "idle", label: "未绑定" };
  if (binding.issue) return { tone: "warn", dot: "offline", label: binding.issue };
  if (!executor.health.canRun) {
    const label = executor.health.installState === "missing"
      ? "未安装"
      : executor.health.state === "unverified"
        ? "待测试"
        : "不可用";
    return { tone: "warn", dot: "offline", label };
  }
  return { tone: "ok", dot: "online", label: "可用" };
}

function installStateLabel(state: string | undefined): string {
  if (state === "available") return "已就绪";
  if (state === "needs_repair") return "需要修复";
  if (state === "update_available") return "可更新";
  if (state === "unsupported") return "不支持托管安装";
  return "未安装";
}

function executorStateLabel(state: string, detected: boolean): string {
  if (state === "ready") return "真实可用";
  if (detected && (state === "unconfigured" || state === "unverified")) return "已检测到";
  if (state === "quota_exceeded") return "额度不可用";
  if (state === "failed") return "测试失败";
  if (state === "missing") return "未连接";
  if (state === "unverified") return "未验证";
  return "未配置";
}
