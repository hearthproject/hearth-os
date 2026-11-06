import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  KeyRound,
  Loader2,
  PlugZap,
  RefreshCw,
  Save,
  Sparkles,
  Trash2
} from "lucide-react";
import { api } from "../lib/api.ts";
import type { CodexProbeResponse, ModelProviderPreset } from "../lib/types.ts";

interface ModelForm {
  providerId: string;
  providerName: string;
  baseUrl: string;
  model: string;
  apiKey: string;
}

const EMPTY_FORM: ModelForm = { providerId: "custom", providerName: "自定义 OpenAI 兼容服务", baseUrl: "", model: "", apiKey: "" };

export function SettingsPage() {
  const queryClient = useQueryClient();
  const settingsQuery = useQuery({ queryKey: ["modelSettings"], queryFn: api.modelSettings });
  const healthQuery = useQuery({ queryKey: ["health"], queryFn: api.health, refetchInterval: 20_000 });
  const [form, setForm] = useState<ModelForm>(EMPTY_FORM);
  const [busy, setBusy] = useState<"save" | "test" | "models" | "probe" | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "error" | "info"; text: string } | null>(null);
  const [probe, setProbe] = useState<CodexProbeResponse | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const initialized = useRef(false);

  const settings = settingsQuery.data?.settings;
  const presets = settingsQuery.data?.presets ?? [];
  const configured = settingsQuery.data?.configured ?? false;
  const codex = healthQuery.data?.codex;

  useEffect(() => {
    if (!settings || initialized.current) return;
    initialized.current = true;
    setForm({
      providerId: settings.providerId,
      providerName: settings.providerName,
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
      baseUrl: preset.baseUrl,
      model: preset.models[0] ?? "",
      apiKey: ""
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
        baseUrl: form.baseUrl,
        model: form.model,
        ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {})
      });
      setModels(result.models);
      if (result.error) setNotice({ tone: "error", text: result.error });
      else if (result.models.length === 0) setNotice({ tone: "info", text: "服务没有返回模型列表，可以手工填写模型名。" });
      else setNotice({ tone: "ok", text: `获取到 ${result.models.length} 个模型。` });
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

  return (
    <div className="page settings-page">
      <div className="page-head">
        <div>
          <h1>设置</h1>
          <p className="page-meta">聊天模型和执行器分开配置。Key 只保存在本机，不会发到浏览器之外。</p>
        </div>
      </div>

      <section className="panel settings-section">
        <div className="panel-head">
          <h2>对话模型</h2>
          <span className={`status-chip ${configured ? "ok" : "warn"}`}>
            <span className={`status-dot ${configured ? "online" : "offline"}`} />
            {configured ? "已接入" : "未完成"}
          </span>
        </div>
        <div className="settings-body">
          <p className="settings-lead">选择一家服务商，填入 API Key 即可。所有服务都走 OpenAI 兼容协议。</p>

          <div className="provider-grid">
            {presets.map((preset) => (
              <button
                key={preset.id}
                className={`provider-card ${form.providerId === preset.id ? "active" : ""}`}
                onClick={() => pickPreset(preset)}
              >
                <strong>{preset.name}</strong>
                <small>{preset.note}</small>
              </button>
            ))}
          </div>

          <div className="form-grid">
            <label>
              <span>服务名称</span>
              <input value={form.providerName} onChange={(event) => update("providerName", event.target.value)} placeholder="例如：DeepSeek" />
            </label>
            <label>
              <span>服务地址（Base URL）</span>
              <input value={form.baseUrl} onChange={(event) => update("baseUrl", event.target.value)} placeholder="https://api.deepseek.com/v1" spellCheck={false} />
            </label>
            <label>
              <span>模型</span>
              <input value={form.model} onChange={(event) => update("model", event.target.value)} placeholder="deepseek-chat" list="model-options" spellCheck={false} />
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
            <button className="ghost-button" onClick={() => void fetchModels()} disabled={busy !== null}>
              {busy === "models" ? <Loader2 size={15} className="spin" /> : <Sparkles size={15} />} 获取模型列表
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
      </section>

      <section className="panel settings-section">
        <div className="panel-head">
          <h2>Codex 执行器</h2>
          <span className={`status-chip ${codex?.canRun ? "ok" : "warn"}`}>
            <span className={`status-dot ${codex?.canRun ? "online" : "offline"}`} />
            {codex?.canRun ? "可以执行任务" : "连接有问题"}
          </span>
        </div>
        <div className="settings-body">
          <p className="settings-lead">
            Hearth 通过本机的 <code>~/.codex/config.toml</code> 调用 Codex，不在这里保存执行器密钥。
          </p>
          <dl className="settings-kv">
            <div><dt>Provider</dt><dd>{codex?.providerName ?? "—"} <small>{codex?.providerId}</small></dd></div>
            <div><dt>模型</dt><dd>{codex?.model ?? "默认模型"}</dd></div>
            <div><dt>地址</dt><dd className="mono">{codex?.baseUrl ?? "—"}</dd></div>
            <div><dt>协议</dt><dd className="mono">{codex?.wireApi ?? "—"}</dd></div>
            <div><dt>环境变量</dt><dd className="mono">{codex?.envKey ?? "未声明"} {codex?.envKey ? (codex.envKeyPresent ? "已读取" : "未读取") : ""}</dd></div>
            <div><dt>配置文件</dt><dd className="mono">{codex?.configPath ?? "—"}</dd></div>
          </dl>

          {codex && codex.issues.length > 0 && (
            <div className="issue-list">
              {codex.issues.map((issue) => <p key={issue}><AlertTriangle size={14} /> {issue}</p>)}
            </div>
          )}

          {codex && !codex.canRun && codex.envKey && (
            <div className="help-card">
              <strong>最常见的连接问题</strong>
              <p>Codex 已切到 Provider 环境变量模式，但 Hearth 服务进程没有读到 <code>{codex.envKey}</code>。在同一个终端里设置变量后重启 Hearth：</p>
              <pre>{`set ${codex.envKey}=你的Key\nnpm.cmd start`}</pre>
              <p>如果显示 “Not logged in”，这是 Provider 环境变量模式的正常现象，不代表配置损坏。</p>
            </div>
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
          </div>
          <p className="settings-hint"><Download size={13} /> 修改 <code>config.toml</code> 或环境变量后，需要重启 Hearth 服务才会生效。</p>
        </div>
      </section>
    </div>
  );
}

function Notice({ tone, text }: { tone: "ok" | "error" | "info"; text: string }) {
  return <div className={`settings-notice ${tone}`}>{tone === "ok" ? <CheckCircle2 size={15} /> : tone === "error" ? <AlertTriangle size={15} /> : <KeyRound size={15} />}<span>{text}</span></div>;
}