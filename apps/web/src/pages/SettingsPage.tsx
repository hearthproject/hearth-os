import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  KeyRound,
  Loader2,
  PlugZap,
  RefreshCw,
  Save,
  ShieldAlert,
  Sparkles,
  Trash2
} from "lucide-react";
import { api } from "../lib/api.ts";
import { formatDuration, formatNumber } from "../lib/format.ts";
import type { CodexProbeResponse, ContextSettings, ModelProtocol, ModelProviderPreset } from "../lib/types.ts";
import { ExecutorSettingsPanel } from "../components/ExecutorSettingsPanel.tsx";

interface ModelForm {
  providerId: string;
  providerName: string;
  protocol: ModelProtocol;
  baseUrl: string;
  model: string;
  apiKey: string;
}

const PROTOCOLS: { id: ModelProtocol; label: string }[] = [
  { id: "openai-chat", label: "OpenAI Chat" },
  { id: "openai-responses", label: "OpenAI Responses" },
  { id: "anthropic-messages", label: "Anthropic Messages" },
  { id: "gemini", label: "Gemini" }
];

const EMPTY_FORM: ModelForm = {
  providerId: "custom",
  providerName: "自定义服务",
  protocol: "openai-chat",
  baseUrl: "",
  model: "",
  apiKey: ""
};

export function SettingsPage() {
  const queryClient = useQueryClient();
  const settingsQuery = useQuery({ queryKey: ["modelSettings"], queryFn: api.modelSettings });
  const healthQuery = useQuery({ queryKey: ["health"], queryFn: api.health, refetchInterval: 20_000 });
  const contextQuery = useQuery({ queryKey: ["contextSettings"], queryFn: api.contextSettings });
  const contextMetricsQuery = useQuery({ queryKey: ["contextMetrics"], queryFn: api.contextMetrics, refetchInterval: 30_000 });
  const [form, setForm] = useState<ModelForm>(EMPTY_FORM);
  const [busy, setBusy] = useState<"save" | "test" | "models" | "probe" | "refresh" | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "error" | "info"; text: string } | null>(null);
  const [probe, setProbe] = useState<CodexProbeResponse | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [contextForm, setContextForm] = useState<ContextSettings | null>(null);
  const [contextNotice, setContextNotice] = useState<{ tone: "ok" | "error" | "info"; text: string } | null>(null);
  const [contextBusy, setContextBusy] = useState(false);
  const [cleanupTaskId, setCleanupTaskId] = useState("");
  const initialized = useRef(false);

  const settings = settingsQuery.data?.settings;
  const presets = settingsQuery.data?.presets ?? [];
  const configured = settingsQuery.data?.configured ?? false;
  const codex = healthQuery.data?.codex;
  const chatModel = healthQuery.data?.chatModel;
  const contextInitialized = useRef(false);

  useEffect(() => {
    if (!contextQuery.data?.settings || contextInitialized.current) return;
    contextInitialized.current = true;
    setContextForm(contextQuery.data.settings);
  }, [contextQuery.data]);

  useEffect(() => {
    if (!settings || initialized.current) return;
    initialized.current = true;
    setForm({
      providerId: settings.providerId,
      providerName: settings.providerName,
      protocol: settings.protocol ?? "openai-chat",
      baseUrl: settings.baseUrl,
      model: settings.model,
      apiKey: ""
    });
    setModels([]);
  }, [settings]);

  function pickPreset(preset: ModelProviderPreset) {
    setForm((prev) => ({
      ...prev,
      providerId: preset.id,
      providerName: preset.name,
      protocol: preset.protocol,
      baseUrl: preset.baseUrl,
      model: preset.models[0] ?? ""
    }));
    setModels(preset.models);
    setNotice(null);
  }

  function update<K extends keyof ModelForm>(key: K, value: ModelForm[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function save() {
    if (!form.providerName.trim() || !form.baseUrl.trim() || !form.model.trim()) {
      setNotice({ tone: "error", text: "请填写服务名称、服务地址和模型。" });
      return;
    }
    setBusy("save");
    setNotice(null);
    try {
      const result = await api.saveModelSettings({
        providerId: form.providerId,
        providerName: form.providerName.trim(),
        protocol: form.protocol,
        baseUrl: form.baseUrl.trim(),
        model: form.model.trim(),
        ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {})
      });
      setForm((prev) => ({ ...prev, apiKey: "" }));
      setNotice({ tone: "ok", text: result.configured ? "已保存，聊天模型可以使用了。" : "已保存，但还缺少 API Key。" });
      await queryClient.invalidateQueries({ queryKey: ["modelSettings"] });
      await queryClient.invalidateQueries({ queryKey: ["health"] });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "保存失败" });
    } finally {
      setBusy(null);
    }
  }

  async function testConnection() {
    setBusy("test");
    setNotice(null);
    try {
      const result = await api.testModel({
        providerId: form.providerId,
        providerName: form.providerName,
        protocol: form.protocol,
        baseUrl: form.baseUrl,
        model: form.model,
        ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {})
      });
      setNotice(result.ok
        ? { tone: "ok", text: `连接成功：${result.reply || "OK"}（${result.elapsedMs ?? 0} ms）` }
        : { tone: "error", text: result.error ?? "连接失败" });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "连接失败" });
    } finally {
      setBusy(null);
    }
  }

  async function fetchModels() {
    setBusy("models");
    setNotice(null);
    try {
      const result = await api.fetchModels({
        providerId: form.providerId,
        providerName: form.providerName,
        protocol: form.protocol,
        baseUrl: form.baseUrl,
        model: form.model,
        ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {})
      });
      setModels(result.models);
      if (result.error) setNotice({ tone: "error", text: result.error });
      else if (result.models.length === 0) setNotice({ tone: "info", text: "服务没有返回模型列表，可以手工填写模型名。" });
      else setNotice({ tone: "ok", text: `获取到 ${result.models.length} 个模型，点模型输入框选择。` });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "获取失败" });
    } finally {
      setBusy(null);
    }
  }

  async function clearKey() {
    if (!window.confirm("确定清除已保存的 API Key？")) return;
    setBusy("save");
    try {
      await api.saveModelSettings({ apiKey: "" });
      setNotice({ tone: "info", text: "API Key 已清除。" });
      await queryClient.invalidateQueries({ queryKey: ["modelSettings"] });
      await queryClient.invalidateQueries({ queryKey: ["health"] });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "清除失败" });
    } finally {
      setBusy(null);
    }
  }

  async function probeExecutor() {
    setBusy("probe");
    setProbe(null);
    try {
      const result = await api.probeCodex();
      setProbe(result);
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "测试失败" });
    } finally {
      setBusy(null);
    }
  }

  async function refreshHealth() {
    setBusy("refresh");
    try {
      await healthQuery.refetch();
    } finally {
      setBusy(null);
    }
  }

  async function saveContextSettings() {
    if (!contextForm) return;
    setContextBusy(true);
    setContextNotice(null);
    try {
      const result = await api.saveContextSettings({
        mode: contextForm.mode,
        maxHandoffs: contextForm.maxHandoffs,
        maxSameExecutorRetries: contextForm.maxSameExecutorRetries,
        retentionDays: contextForm.retentionDays,
        maxInlineBytes: contextForm.maxInlineBytes,
        projectionTokenBudget: contextForm.projectionTokenBudget,
        summarizeAfterTokens: contextForm.summarizeAfterTokens,
        autoHandoffRisk: contextForm.autoHandoffRisk,
        allowCodexNetwork: contextForm.allowCodexNetwork
      });
      setContextForm(result.settings);
      setContextNotice({ tone: "ok", text: "上下文与接管设置已保存，对之后的运行生效。" });
      await queryClient.invalidateQueries({ queryKey: ["contextSettings"] });
    } catch (error) {
      setContextNotice({ tone: "error", text: error instanceof Error ? error.message : "保存失败" });
    } finally {
      setContextBusy(false);
    }
  }

  async function cleanupTaskContext() {
    const taskId = cleanupTaskId.trim();
    if (!taskId) {
      setContextNotice({ tone: "info", text: "请填写要清理的任务 ID。" });
      return;
    }
    if (!window.confirm("确定删除这个任务的上下文、摘要、接管记录和 blob？此操作不可撤销。")) return;
    setContextBusy(true);
    setContextNotice(null);
    try {
      const receipt = await api.deleteTaskContext(taskId);
      setContextNotice({ tone: "ok", text: `已删除 ${receipt.deletedItems} 条上下文、${receipt.deletedHandoffs} 条接管记录、${receipt.deletedBlobs} 个 blob。` });
      setCleanupTaskId("");
    } catch (error) {
      setContextNotice({ tone: "error", text: error instanceof Error ? error.message : "清理失败" });
    } finally {
      setContextBusy(false);
    }
  }

  return (
    <div className="page settings-page">
      <div className="page-head">
        <div>
          <h1>设置</h1>
          <p className="page-meta">执行器开关与权限在对话输入框上方调整；这里只配置模型连接，Key 只保存在本机。</p>
        </div>
      </div>

      <section className="panel settings-section">
        <details className="settings-fold">
          <summary className="settings-fold-summary">
            <div className="settings-fold-copy">
              <strong>对话模型</strong>
              <span>{settings ? `${settings.providerName} · ${settings.model || "未选择模型"}` : "读取本机配置中"}</span>
            </div>
            <span className={`status-chip ${configured ? "ok" : "warn"}`}>
              <span className={`status-dot ${configured ? "online" : "offline"}`} />
              {configured ? "已接入" : "未完成"}
            </span>
          </summary>
          <div className="settings-body">
          <p className="settings-lead">选择服务商并填入 Key。模型名可以直接从服务商拉取。</p>

          <div className="provider-grid compact">
            {presets.map((preset) => (
              <button
                key={preset.id}
                title={preset.note}
                className={`provider-card ${form.providerId === preset.id ? "active" : ""}`}
                onClick={() => pickPreset(preset)}
              >
                <strong>{preset.name}</strong>
                <small>{protocolLabel(preset.protocol)}</small>
              </button>
            ))}
          </div>

          <div className="form-grid">
            <label>
              <span>接口协议</span>
              <select value={form.protocol} onChange={(event) => update("protocol", event.target.value as ModelProtocol)}>
                {PROTOCOLS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
              </select>
            </label>
            <label>
              <span>服务名称</span>
              <input value={form.providerName} onChange={(event) => update("providerName", event.target.value)} placeholder="例如：DeepSeek" />
            </label>
            <label className="span-2">
              <span>服务地址（Base URL）</span>
              <input value={form.baseUrl} onChange={(event) => update("baseUrl", event.target.value)} placeholder="https://api.deepseek.com/v1" spellCheck={false} />
            </label>
            <label>
              <span>模型</span>
              <div className="input-with-action">
                <input value={form.model} onChange={(event) => update("model", event.target.value)} placeholder="点右侧拉取，或手工填写" list="model-options" spellCheck={false} />
                <button type="button" className="ghost-button compact" onClick={() => void fetchModels()} disabled={busy !== null}>
                  {busy === "models" ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />} 获取
                </button>
              </div>
              <datalist id="model-options">
                {models.map((model) => <option key={model} value={model} />)}
              </datalist>
            </label>
            <label>
              <span>API Key</span>
              <input
                type="password"
                value={form.apiKey}
                onChange={(event) => update("apiKey", event.target.value)}
                placeholder={settings?.hasApiKey ? `已保存 ${settings.apiKeyMasked ?? ""}，留空不修改` : "sk-..."}
                autoComplete="off"
              />
            </label>
          </div>

          <div className="settings-actions">
            <button className="primary-button" onClick={() => void save()} disabled={busy !== null}>
              {busy === "save" ? <Loader2 size={15} className="spin" /> : <Save size={15} />} 保存
            </button>
            <button className="ghost-button" onClick={() => void testConnection()} disabled={busy !== null}>
              {busy === "test" ? <Loader2 size={15} className="spin" /> : <PlugZap size={15} />} 测试连接
            </button>
            {settings?.hasApiKey && (
              <button className="ghost-button danger" onClick={() => void clearKey()} disabled={busy !== null}>
                <Trash2 size={15} /> 清除 Key
              </button>
            )}
          </div>
          {notice && <Notice tone={notice.tone} text={notice.text} />}
          <p className="settings-hint"><KeyRound size={13} /> Key 保存在本机 <code>.hearth/model-settings.json</code>，接口只返回掩码。</p>
          </div>
        </details>
      </section>

      <section className="panel settings-section">
        <details className="settings-fold">
          <summary className="settings-fold-summary">
            <div className="settings-fold-copy">
              <strong>Codex 执行器</strong>
              <span>{codex ? `${codex.providerName} · ${codex.model ?? "默认模型"}` : "读取本机配置中"}</span>
            </div>
            <span className={`status-chip ${codex?.canRun ? "ok" : "warn"}`}>
              <span className={`status-dot ${codex?.canRun ? "online" : "offline"}`} />
              {codex?.canRun ? "可以执行任务" : "未连接"}
            </span>
          </summary>
          <div className="settings-body">
          <div className="codex-summary">
            <span className={`status-dot ${codex?.canRun ? "online" : "offline"}`} />
            <div>
              <strong>{codex?.canRun ? "已连接" : "未连接"}</strong>
              <small>{codex ? `${codex.providerName} · ${codex.model ?? "默认模型"}` : "读取本机配置中"}</small>
            </div>
            <span className="codex-key-state">{keyStateText(codex)}</span>
          </div>

          {codex && !codex.canRun && (
            <p className="codex-hint">
              需要环境变量 <code>{codex.envKey ?? "API Key"}</code>。可写入 Windows 用户环境变量，然后点重新检测。
            </p>
          )}

          {probe && (
            <div className={`result-banner ${probe.ok ? "ok" : "error"}`}>
              {probe.ok ? <CheckCircle2 size={17} /> : <AlertTriangle size={17} />}
              <div>
                <strong>{probe.ok ? "执行器测试通过" : "执行器测试失败"}</strong>
                <p>{probe.ok ? probe.text : probe.error}</p>
                <small>{probe.elapsedMs} ms</small>
              </div>
            </div>
          )}

          <div className="settings-actions">
            <button className="primary-button" onClick={() => void probeExecutor()} disabled={busy !== null}>
              {busy === "probe" ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />} 测试执行器
            </button>
            <button className="ghost-button" onClick={() => void refreshHealth()} disabled={busy !== null}>
              {busy === "refresh" ? <Loader2 size={15} className="spin" /> : <PlugZap size={15} />} 重新检测
            </button>
          </div>

          <details className="settings-details">
            <summary>连接详情</summary>
            <dl className="settings-kv">
              <div><dt>Provider</dt><dd>{codex?.providerName ?? "—"} <small>{codex?.providerId}</small></dd></div>
              <div><dt>模型</dt><dd>{codex?.model ?? "默认模型"}</dd></div>
              <div><dt>地址</dt><dd className="mono">{codex?.baseUrl ?? "—"}</dd></div>
              <div><dt>协议</dt><dd className="mono">{codex?.wireApi ?? "—"}</dd></div>
              <div><dt>环境变量</dt><dd className="mono">{codex?.envKey ?? "未声明"} {codex?.envKeyPresent ? "已读取" : ""}</dd></div>
              <div><dt>配置文件</dt><dd className="mono">{codex?.configPath ?? "—"}</dd></div>
            </dl>
            {codex && codex.issues.length > 0 && (
              <div className="issue-list">
                {codex.issues.map((issue) => <p key={issue}><AlertTriangle size={14} /> {issue}</p>)}
              </div>
            )}
          </details>
          <p className="settings-hint">修改 <code>config.toml</code> 或环境变量后，点重新检测即可。</p>
          </div>
        </details>
      </section>

      <ExecutorSettingsPanel />

      <section className="panel settings-section">
        <details className="settings-fold">
          <summary className="settings-fold-summary">
            <div className="settings-fold-copy">
              <strong>上下文与接管</strong>
              <span>统一上下文账本 · Native 失败后可交给 Codex</span>
            </div>
            <span className={`status-chip ${contextForm?.mode === "on" ? "ok" : "warn"}`}>
              <span className={`status-dot ${contextForm?.mode === "on" ? "online" : "offline"}`} />
              {contextForm?.mode === "on" ? "自动接管已开启" : contextForm?.mode === "shadow" ? "仅记录诊断" : "已关闭"}
            </span>
          </summary>
          <div className="settings-body">
            <p className="settings-lead">所有执行器的会话、工具调用、失败证据和接管记录都会写入 Hearth 自己的上下文账本。shadow 模式只记录诊断，不会自动切换执行器。</p>
            {contextMetricsQuery.data && (
              <div className="context-metrics">
                <span>接管 {contextMetricsQuery.data.handoffs.total} 次 · 成功 {contextMetricsQuery.data.handoffs.successRate === null ? "未记录" : `${Math.round(contextMetricsQuery.data.handoffs.successRate * 100)}%`}</span>
                <span>平均上下文 {contextMetricsQuery.data.handoffs.averageContextTokens === null ? "未记录" : `${formatNumber(Math.round(contextMetricsQuery.data.handoffs.averageContextTokens))} tokens`}</span>
                <span>诊断耗时 {formatDuration(contextMetricsQuery.data.diagnosis.averageDurationMs)}</span>
                <span>平均恢复 {formatDuration(contextMetricsQuery.data.handoffs.averageRecoveryMs)}</span>
                <span>账本 {formatNumber(contextMetricsQuery.data.ledger.tasks)} 个任务 · {formatNumber(contextMetricsQuery.data.ledger.items)} 条记录</span>
              </div>
            )}
            <div className="form-grid">
              <label>
                <span>模式</span>
                <select value={contextForm?.mode ?? "on"} onChange={(event) => setContextForm((prev) => (prev ? { ...prev, mode: event.target.value as ContextSettings["mode"] } : prev))}>
                  <option value="on">开启：低风险自动接管</option>
                  <option value="shadow">仅记录：不自动接管</option>
                  <option value="off">关闭</option>
                </select>
              </label>
              <label>
                <span>自动接管风险</span>
                <select value={contextForm?.autoHandoffRisk ?? "low"} onChange={(event) => setContextForm((prev) => (prev ? { ...prev, autoHandoffRisk: event.target.value as ContextSettings["autoHandoffRisk"] } : prev))}>
                  <option value="low">低风险自动，高风险确认</option>
                  <option value="none">全部需要用户确认</option>
                </select>
              </label>
              <label>
                <span>最大接管次数</span>
                <input type="number" min={0} max={5} value={contextForm?.maxHandoffs ?? 1} onChange={(event) => setContextForm((prev) => (prev ? { ...prev, maxHandoffs: Number(event.target.value) } : prev))} />
              </label>
              <label>
                <span>同执行器重试</span>
                <input type="number" min={0} max={3} value={contextForm?.maxSameExecutorRetries ?? 1} onChange={(event) => setContextForm((prev) => (prev ? { ...prev, maxSameExecutorRetries: Number(event.target.value) } : prev))} />
              </label>
              <label>
                <span>保留天数</span>
                <input type="number" min={1} max={3650} value={contextForm?.retentionDays ?? 30} onChange={(event) => setContextForm((prev) => (prev ? { ...prev, retentionDays: Number(event.target.value) } : prev))} />
              </label>
              <label>
                <span>投影预算（tokens）</span>
                <input type="number" min={1000} max={200000} step={1000} value={contextForm?.projectionTokenBudget ?? 12000} onChange={(event) => setContextForm((prev) => (prev ? { ...prev, projectionTokenBudget: Number(event.target.value) } : prev))} />
              </label>
              <label>
                <span>摘要阈值（tokens）</span>
                <input type="number" min={1000} max={500000} step={1000} value={contextForm?.summarizeAfterTokens ?? 8000} onChange={(event) => setContextForm((prev) => (prev ? { ...prev, summarizeAfterTokens: Number(event.target.value) } : prev))} />
              </label>
              <label className="checkbox-field">
                <input type="checkbox" checked={contextForm?.allowCodexNetwork ?? false} onChange={(event) => setContextForm((prev) => (prev ? { ...prev, allowCodexNetwork: event.target.checked } : prev))} />
                <span>允许 Codex 网络访问（不开启时，需要网络的任务不会自动接管）</span>
              </label>
            </div>
            <div className="settings-actions">
              <button className="primary-button" onClick={() => void saveContextSettings()} disabled={contextBusy || !contextForm}>
                {contextBusy ? <Loader2 size={15} className="spin" /> : <Save size={15} />} 保存上下文设置
              </button>
            </div>
            {contextNotice && <Notice tone={contextNotice.tone} text={contextNotice.text} />}
            <div className="context-cleanup">
              <strong>手动清理任务上下文</strong>
              <p>删除后，该任务的上下文条目、摘要、接管记录和 blob 都会移除，任务本身保留。</p>
              <div className="input-with-action">
                <input value={cleanupTaskId} onChange={(event) => setCleanupTaskId(event.target.value)} placeholder="任务 ID（任务详情 URL 最后一段）" spellCheck={false} />
                <button className="ghost-button danger" onClick={() => void cleanupTaskContext()} disabled={contextBusy}>
                  <Trash2 size={14} /> 删除上下文
                </button>
              </div>
            </div>
            <p className="settings-hint"><ShieldAlert size={13} /> 接管只共享工作区、产物、摘要和证据，不承诺模型内部状态的位级连续。</p>
          </div>
        </details>
      </section>
    </div>
  );
}

function protocolLabel(protocol: ModelProtocol): string {
  return PROTOCOLS.find((item) => item.id === protocol)?.label ?? protocol;
}

function keyStateText(codex: { envKeySource?: string; authSource?: string } | undefined): string {
  if (!codex) return "";
  if (codex.envKeySource === "windows-user") return "密钥来自 Windows 用户环境变量";
  if (codex.envKeySource === "process") return "密钥来自当前进程";
  if (codex.authSource === "openai-login") return "已登录 OpenAI";
  return "";
}

function Notice({ tone, text }: { tone: "ok" | "error" | "info"; text: string }) {
  return <div className={`settings-notice ${tone}`}>{tone === "ok" ? <CheckCircle2 size={15} /> : tone === "error" ? <AlertTriangle size={15} /> : <KeyRound size={15} />}<span>{text}</span></div>;
}
