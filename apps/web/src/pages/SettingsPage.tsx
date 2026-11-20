import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import {
  AlertTriangle,
  CheckCircle2,
  KeyRound,
  Loader2,
  Pencil,
  PlugZap,
  Plus,
  RefreshCw,
  Save,
  ShieldAlert,
  Sparkles,
  Trash2
} from "lucide-react";
import { api } from "../lib/api.ts";
import { formatNumber, relativeTime } from "../lib/format.ts";
import type {
  ExecutorId,
  ExecutorModelBindingView,
  ExecutorView,
  McpServerView,
  ModelProfileView,
  ModelProtocol,
  ModelProviderPreset,
  WebSearchProvider,
  WebSearchSettingsView
} from "../lib/types.ts";
import { ExecutorSettingsPanel } from "../components/ExecutorSettingsPanel.tsx";
import { DataSettingsPanel } from "../components/DataSettingsPanel.tsx";
import { BrowserSettingsPanel } from "../components/BrowserSettingsPanel.tsx";

type SettingsTab = "executors" | "models" | "extensions" | "browser" | "data";

interface ProfileDraft {
  name: string;
  providerId: string;
  providerName: string;
  protocol: ModelProtocol;
  baseUrl: string;
  model: string;
  contextWindowTokens: number;
  maxOutputTokens: number;
  apiKey: string;
}

const TABS: Array<{ id: SettingsTab; label: string }> = [
  { id: "executors", label: "执行器" },
  { id: "models", label: "模型" },
  { id: "extensions", label: "扩展" },
  { id: "browser", label: "浏览器" },
  { id: "data", label: "数据" }
];

function isSettingsTab(value: string | null): value is SettingsTab {
  return TABS.some((tab) => tab.id === value);
}

const PROTOCOLS: Array<{ id: ModelProtocol; label: string }> = [
  { id: "openai-chat", label: "OpenAI Chat" },
  { id: "openai-responses", label: "OpenAI Responses" },
  { id: "anthropic-messages", label: "Anthropic Messages" },
  { id: "gemini", label: "Gemini" }
];

const EMPTY_DRAFT: ProfileDraft = {
  name: "",
  providerId: "custom",
  providerName: "",
  protocol: "openai-chat",
  baseUrl: "",
  model: "",
  contextWindowTokens: 128000,
  maxOutputTokens: 8000,
  apiKey: ""
};

const EXECUTOR_LABELS: Record<ExecutorId, string> = {
  native: "Hearth 原生",
  codex: "Codex",
  "deepseek-harness": "DeepSeek Harness"
};

export function SettingsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedTab = searchParams.get("tab");
  const [tab, setTab] = useState<SettingsTab>(isSettingsTab(requestedTab) ? requestedTab : "executors");

  useEffect(() => {
    if (isSettingsTab(requestedTab)) setTab(requestedTab);
  }, [requestedTab]);

  function selectTab(next: SettingsTab) {
    setTab(next);
    setSearchParams({ tab: next }, { replace: true });
  }

  return (
    <div className="page settings-page">
      <header className="settings-head">
        <h1>设置</h1>
      </header>

      <div className="settings-layout">
        <nav className="settings-tabs" aria-label="设置分区">
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`settings-tab ${tab === item.id ? "active" : ""}`}
              onClick={() => selectTab(item.id)}
            >
              <strong>{item.label}</strong>
            </button>
          ))}
        </nav>

        <div className="settings-content">
          {tab === "executors" && <ExecutorsTab />}
          {tab === "models" && <ModelsTab />}
          {tab === "extensions" && <ExtensionsTab />}
          {tab === "browser" && <BrowserSettingsPanel />}
          {tab === "data" && <DataSettingsPanel />}
        </div>
      </div>
    </div>
  );
}

function ExecutorsTab() {
  const queryClient = useQueryClient();
  const registryQuery = useQuery({ queryKey: ["modelRegistry"], queryFn: api.modelRegistry });
  const executorsQuery = useQuery({ queryKey: ["executors"], queryFn: api.executors });
  const [busy, setBusy] = useState<ExecutorId | null>(null);
  const [notice, setNotice] = useState<NoticeState>(null);
  const registry = registryQuery.data;
  const executors = executorsQuery.data?.executors ?? [];
  const executorById = new Map(executors.map((executor) => [executor.id, executor]));
  const readyBindingCount = registry?.bindings.filter(
    (binding) => binding.available && executorById.get(binding.executorId)?.health.canRun
  ).length ?? 0;

  async function bind(executorId: ExecutorId, profileId: string) {
    setBusy(executorId);
    setNotice(null);
    try {
      await api.saveExecutorModelBinding(executorId, { profileId: profileId || null, protocolOverride: null, modelOverride: null });
      setNotice({ tone: "ok", text: `${EXECUTOR_LABELS[executorId]} 的模型绑定已更新。` });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["modelRegistry"] }),
        queryClient.invalidateQueries({ queryKey: ["executors"] }),
        queryClient.invalidateQueries({ queryKey: ["health"] })
      ]);
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "模型绑定保存失败" });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="settings-tab-panel">
      <ExecutorSettingsPanel />

      <section className="panel settings-section">
        <div className="settings-body">
          <div className="section-heading">
            <div><h3>模型绑定</h3><p>每个执行器独立选择模型档案。Codex 只显示 Responses 协议；本地模型不会出现在这里。</p></div>
            <span className="muted-count">{registryQuery.isLoading ? "正在检测" : `${readyBindingCount} / ${registry?.bindings.length ?? 7} 个模型与执行器均就绪`}</span>
          </div>
          {(registryQuery.isLoading || executorsQuery.isLoading) && <InlineLoading text="正在读取模型绑定与执行器状态" />}
          {registry && (
            <div className="binding-list">
              {registry.bindings.map((binding) => {
                const compatible = registry.profiles.filter((profile) => binding.allowedProtocols.includes(profile.protocol));
                const health = executorById.get(binding.executorId)?.health ?? null;
                const status = bindingStatus(binding, health);
                return (
                  <article key={binding.executorId} className="binding-row">
                    <div className="binding-name">
                      <strong>{EXECUTOR_LABELS[binding.executorId]}</strong>
                      <small>{binding.allowedProtocols.map(protocolLabel).join(" · ")}</small>
                    </div>
                    <label>
                      <span>使用的模型</span>
                      <select
                        value={binding.profileId ?? ""}
                        onChange={(event) => void bind(binding.executorId, event.target.value)}
                        disabled={busy === binding.executorId}
                      >
                        <option value="">未绑定</option>
                        {compatible.map((profile) => <option key={profile.id} value={profile.id}>{profile.name} · {profile.model}</option>)}
                      </select>
                    </label>
                    <div className="binding-effective">
                      <span className={`status-dot ${status.dot}`} />
                      <div>
                        <strong>{binding.effectiveModel ?? "未选择模型"}</strong>
                        <small>
                          {binding.effectiveProtocol ? protocolLabel(binding.effectiveProtocol) : "先创建兼容协议的模型档案"}
                          {binding.available && health && !health.canRun ? " · 执行器不可用" : ""}
                        </small>
                      </div>
                    </div>
                    <span className={`status-chip ${status.tone}`} title={status.title}>{status.label}</span>
                  </article>
                );
              })}
            </div>
          )}
          {notice && <Notice tone={notice.tone} text={notice.text} />}
          <p className="settings-hint"><ShieldAlert size={13} /> 执行器切换仍受上下文开关、风险策略和最大接管次数约束。</p>
        </div>
      </section>
    </section>
  );
}

function ModelsTab() {
  const queryClient = useQueryClient();
  const registryQuery = useQuery({ queryKey: ["modelRegistry"], queryFn: api.modelRegistry });
  const [draft, setDraft] = useState<ProfileDraft>(EMPTY_DRAFT);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState<"save" | "test" | "models" | "chat" | "delete" | null>(null);
  const [notice, setNotice] = useState<NoticeState>(null);
  const [models, setModels] = useState<string[]>([]);
  const [chatProfileId, setChatProfileId] = useState("");
  const registry = registryQuery.data;

  useEffect(() => {
    if (registry) setChatProfileId(registry.chatProfileId ?? "");
  }, [registry]);

  async function refreshRegistry() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["modelRegistry"] }),
      queryClient.invalidateQueries({ queryKey: ["modelSettings"] }),
      queryClient.invalidateQueries({ queryKey: ["health"] }),
      queryClient.invalidateQueries({ queryKey: ["executors"] })
    ]);
  }

  function update<K extends keyof ProfileDraft>(key: K, value: ProfileDraft[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  function pickPreset(preset: ModelProviderPreset) {
    setDraft((prev) => ({
      ...prev,
      providerId: preset.id,
      providerName: preset.name,
      protocol: preset.protocol,
      baseUrl: preset.baseUrl,
      model: preset.models[0] ?? "",
      name: prev.name || `${preset.name} · ${preset.models[0] ?? "模型"}`
    }));
    setModels(preset.models);
    setNotice(null);
  }

  function edit(profile: ModelProfileView) {
    setEditingId(profile.id);
    setDraft({
      name: profile.name,
      providerId: profile.providerId,
      providerName: profile.providerName,
      protocol: profile.protocol,
      baseUrl: profile.baseUrl,
      model: profile.model,
      contextWindowTokens: profile.contextWindowTokens,
      maxOutputTokens: profile.maxOutputTokens,
      apiKey: ""
    });
    setModels([]);
    setNotice({ tone: "info", text: "正在编辑模型档案；API Key 留空表示保留当前密钥。" });
  }

  function resetForm() {
    setEditingId(null);
    setDraft(EMPTY_DRAFT);
    setModels([]);
    setNotice(null);
  }

  async function save() {
    if (!draft.name.trim() || !draft.baseUrl.trim() || !draft.model.trim()) {
      setNotice({ tone: "error", text: "请填写档案名称、服务地址和模型名。" });
      return;
    }
    setBusy("save");
    setNotice(null);
    try {
      const input = {
        name: draft.name.trim(),
        providerId: draft.providerId.trim() || "custom",
        providerName: draft.providerName.trim() || draft.name.trim(),
        protocol: draft.protocol,
        baseUrl: draft.baseUrl.trim(),
        model: draft.model.trim(),
        contextWindowTokens: draft.contextWindowTokens,
        maxOutputTokens: draft.maxOutputTokens,
        ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {})
      };
      if (editingId) await api.updateModelProfile(editingId, input);
      else await api.createModelProfile(input);
      setNotice({ tone: "ok", text: editingId ? "模型档案已更新。" : "模型档案已创建，可以绑定给执行器。" });
      setEditingId(null);
      setDraft((prev) => ({ ...prev, apiKey: "" }));
      await refreshRegistry();
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "保存失败" });
    } finally {
      setBusy(null);
    }
  }

  async function remove(profile: ModelProfileView) {
    if (!window.confirm(`删除模型档案「${profile.name}」？使用它的执行器会变成未绑定。`)) return;
    setBusy("delete");
    setNotice(null);
    try {
      await api.deleteModelProfile(profile.id);
      if (editingId === profile.id) resetForm();
      setNotice({ tone: "ok", text: "模型档案已删除。" });
      await refreshRegistry();
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "删除失败" });
    } finally {
      setBusy(null);
    }
  }

  async function saveChatProfile() {
    setBusy("chat");
    setNotice(null);
    try {
      await api.setChatProfile(chatProfileId || null);
      setNotice({ tone: "ok", text: "Hearth 聊天与故障诊断模型已更新。" });
      await refreshRegistry();
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "聊天模型保存失败" });
    } finally {
      setBusy(null);
    }
  }

  async function fetchModels() {
    setBusy("models");
    setNotice(null);
    try {
      const result = await api.fetchModels({
        providerId: draft.providerId,
        providerName: draft.providerName,
        protocol: draft.protocol,
        baseUrl: draft.baseUrl,
        model: draft.model,
        ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {})
      });
      setModels(result.models);
      if (result.error) setNotice({ tone: "error", text: result.error });
      else if (result.models.length === 0) setNotice({ tone: "info", text: "服务没有返回模型列表，可以手工填写。" });
      else setNotice({ tone: "ok", text: `获取到 ${result.models.length} 个模型。` });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "获取失败" });
    } finally {
      setBusy(null);
    }
  }

  async function testConnection() {
    setBusy("test");
    setNotice(null);
    try {
      const result = await api.testModel({
        providerId: draft.providerId,
        providerName: draft.providerName,
        protocol: draft.protocol,
        baseUrl: draft.baseUrl,
        model: draft.model,
        ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {})
      });
      setNotice(result.ok
        ? { tone: "ok", text: `连接成功${result.elapsedMs === undefined ? "" : `，${result.elapsedMs} ms`}。` }
        : { tone: "error", text: result.error ?? "连接失败" });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "测试失败" });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="settings-tab-panel">
      <section className="panel settings-section">
        <div className="settings-body">
          <div className="section-heading">
            <div><h3>Hearth 聊天模型</h3><p>用于聊天、任务路由、失败诊断和上下文摘要。它不等同于某个执行器的模型。</p></div>
          </div>
          <div className="chat-profile-row">
            <label>
              <span>当前聊天模型</span>
              <select value={chatProfileId} onChange={(event) => setChatProfileId(event.target.value)}>
                <option value="">未选择</option>
                {(registry?.profiles ?? []).map((profile) => <option key={profile.id} value={profile.id}>{profile.name} · {profile.model}</option>)}
              </select>
            </label>
            <button className="primary-button" onClick={() => void saveChatProfile()} disabled={busy !== null}>
              {busy === "chat" ? <Loader2 size={15} className="spin" /> : <Save size={15} />} 保存聊天模型
            </button>
          </div>
        </div>
      </section>

      <div className="settings-split">
        <section className="panel settings-section model-catalog">
          <div className="settings-body">
            <div className="section-heading">
              <div><h3>模型档案</h3><p>API Key 使用 AES-256-GCM 加密保存在 SQLite，接口只返回掩码。</p></div>
              <button className="ghost-button compact" onClick={resetForm}><Plus size={14} /> 新建档案</button>
            </div>
            <div className="model-list">
              {(registry?.profiles ?? []).map((profile) => (
                <article key={profile.id} className={`model-card ${registry?.chatProfileId === profile.id ? "active" : ""}`}>
                  <div className="model-card-head">
                    <div><strong>{profile.name}</strong><small>{profile.providerName} · {protocolLabel(profile.protocol)}</small></div>
                    {registry?.chatProfileId === profile.id && <span className="status-chip ok">聊天模型</span>}
                  </div>
                  <dl className="model-meta">
                    <div><dt>模型</dt><dd>{profile.model}</dd></div>
                    <div><dt>上下文</dt><dd>{formatNumber(profile.contextWindowTokens)} / 输出 {formatNumber(profile.maxOutputTokens)}</dd></div>
                    <div><dt>地址</dt><dd title={profile.baseUrl}>{profile.baseUrl}</dd></div>
                    <div><dt>密钥</dt><dd>{profile.hasApiKey ? profile.apiKeyMasked ?? "已保存" : "未设置"}</dd></div>
                  </dl>
                  <div className="model-card-actions">
                    <button className="ghost-button compact" onClick={() => edit(profile)}><Pencil size={13} /> 编辑</button>
                    <button className="ghost-button compact danger" onClick={() => void remove(profile)} disabled={busy !== null}><Trash2 size={13} /> 删除</button>
                  </div>
                </article>
              ))}
              {registry && registry.profiles.length === 0 && <EmptyState text="还没有模型档案。使用右侧表单创建第一个。" />}
            </div>
          </div>
        </section>

        <section className="panel settings-section model-editor">
          <div className="settings-body">
            <div className="section-heading">
              <div><h3>{editingId ? "编辑模型档案" : "新建模型档案"}</h3><p>协议必须和执行器能力匹配，例如 Codex 只接受 Responses。</p></div>
              {editingId && <button className="ghost-button compact" onClick={resetForm}>取消编辑</button>}
            </div>
            <div className="provider-grid compact">
              {(registry?.presets ?? []).map((preset) => (
                <button key={preset.id} type="button" title={preset.note} className={`provider-card ${draft.providerId === preset.id ? "active" : ""}`} onClick={() => pickPreset(preset)}>
                  <strong>{preset.name}</strong><small>{protocolLabel(preset.protocol)}</small>
                </button>
              ))}
            </div>
            <div className="form-grid">
              <label className="span-2"><span>档案名称</span><input value={draft.name} onChange={(event) => update("name", event.target.value)} placeholder="例如：DeepSeek 主模型" /></label>
              <label><span>接口协议</span><select value={draft.protocol} onChange={(event) => update("protocol", event.target.value as ModelProtocol)}>{PROTOCOLS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
              <label><span>服务名称</span><input value={draft.providerName} onChange={(event) => update("providerName", event.target.value)} placeholder="例如：DeepSeek" /></label>
              <label className="span-2"><span>服务地址</span><input value={draft.baseUrl} onChange={(event) => update("baseUrl", event.target.value)} placeholder="https://api.deepseek.com/v1" spellCheck={false} /></label>
              <label><span>模型</span><div className="input-with-action"><input value={draft.model} onChange={(event) => update("model", event.target.value)} placeholder="手工填写或拉取" list="settings-model-options" spellCheck={false} /><button type="button" className="ghost-button compact" onClick={() => void fetchModels()} disabled={busy !== null}>{busy === "models" ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />} 拉取</button></div><datalist id="settings-model-options">{models.map((model) => <option key={model} value={model} />)}</datalist></label>
              <label><span>API Key</span><input type="password" value={draft.apiKey} onChange={(event) => update("apiKey", event.target.value)} placeholder={editingId ? "留空保留原密钥" : "sk-..."} autoComplete="off" /></label>
              <label><span>上下文窗口（Token）</span><input type="number" min={4096} max={10000000} step={1000} value={draft.contextWindowTokens} onChange={(event) => update("contextWindowTokens", Number(event.target.value))} /></label>
              <label><span>单次最大输出（Token）</span><input type="number" min={256} max={1000000} step={256} value={draft.maxOutputTokens} onChange={(event) => update("maxOutputTokens", Number(event.target.value))} /></label>
            </div>
            <div className="settings-actions">
              <button className="primary-button" onClick={() => void save()} disabled={busy !== null}>{busy === "save" ? <Loader2 size={15} className="spin" /> : <Save size={15} />} {editingId ? "保存修改" : "创建档案"}</button>
              <button className="ghost-button" onClick={() => void testConnection()} disabled={busy !== null}>{busy === "test" ? <Loader2 size={15} className="spin" /> : <PlugZap size={15} />} 测试连接</button>
            </div>
            {notice && <Notice tone={notice.tone} text={notice.text} />}
            <p className="settings-hint"><KeyRound size={13} /> 本地模型（localhost / 127.0.0.1 / 内网地址）不进入统一模型管理，请在本地工具中直接使用。</p>
          </div>
        </section>
      </div>
    </section>
  );
}

function ExtensionsTab() {
  const queryClient = useQueryClient();
  const mcpQuery = useQuery({ queryKey: ["mcpServers"], queryFn: api.mcpServers });
  const searchQuery = useQuery({ queryKey: ["webSearchSettings"], queryFn: api.webSearchSettings });
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [argsText, setArgsText] = useState("");
  const [envText, setEnvText] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [search, setSearch] = useState<WebSearchSettingsView | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<NoticeState>(null);

  useEffect(() => {
    if (searchQuery.data) setSearch(searchQuery.data);
  }, [searchQuery.data]);

  async function addServer() {
    setBusy("create");
    setNotice(null);
    try {
      const env = parseEnvText(envText);
      const result = await api.createMcpServer({
        name,
        command,
        args: argsText.split("\n").map((entry) => entry.trim()).filter(Boolean),
        ...(Object.keys(env).length ? { env } : {}),
        enabled
      });
      setNotice({
        tone: result.server.status === "ready" ? "ok" : "error",
        text: result.server.status === "ready"
          ? `已连接 ${result.server.name}，发现 ${result.server.tools.length} 个工具。`
          : `服务器已保存，但探测失败：${result.server.error ?? "未知错误"}`
      });
      setName("");
      setCommand("");
      setArgsText("");
      setEnvText("");
      await queryClient.invalidateQueries({ queryKey: ["mcpServers"] });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
  }

  async function probe(server: McpServerView) {
    setBusy(server.id);
    setNotice(null);
    try {
      const result = await api.probeMcpServer(server.id);
      setNotice({
        tone: result.server.status === "ready" ? "ok" : "error",
        text: result.server.status === "ready"
          ? `${result.server.name} 探测成功，共 ${result.server.tools.length} 个工具。`
          : `${result.server.name} 探测失败：${result.server.error ?? "未知错误"}`
      });
      await queryClient.invalidateQueries({ queryKey: ["mcpServers"] });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
  }

  async function toggleServer(server: McpServerView, nextEnabled: boolean) {
    setBusy(server.id);
    try {
      await api.updateMcpServer(server.id, { enabled: nextEnabled });
      await queryClient.invalidateQueries({ queryKey: ["mcpServers"] });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
  }

  async function removeServer(server: McpServerView) {
    if (!window.confirm(`删除 MCP 服务器“${server.name}”？这不会删除它的程序或数据。`)) return;
    setBusy(server.id);
    try {
      await api.deleteMcpServer(server.id);
      await queryClient.invalidateQueries({ queryKey: ["mcpServers"] });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
  }

  async function saveSearch() {
    if (!search) return;
    setBusy("search");
    setNotice(null);
    try {
      const saved = await api.saveWebSearchSettings({
        enabled: search.enabled,
        provider: search.provider,
        searxngUrl: search.searxngUrl,
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {})
      });
      setSearch(saved);
      setApiKey("");
      setNotice({ tone: "ok", text: saved.enabled ? "网页搜索已启用。" : "网页搜索已关闭。" });
      await queryClient.invalidateQueries({ queryKey: ["webSearchSettings"] });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
  }

  const servers = mcpQuery.data?.servers ?? [];
  return (
    <section className="settings-tab-panel">
      <section className="panel settings-section">
        <div className="settings-body">
          <div className="section-heading"><div><h3>添加本地 MCP 服务器</h3><p>命令直接以参数数组启动，不经过 shell。参数一行一个；环境变量一行一个 <code>KEY=VALUE</code>。</p></div><PlugZap size={20} /></div>
          <div className="form-grid">
            <label><span>名称</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="filesystem" /></label>
            <label><span>启动命令</span><input value={command} onChange={(event) => setCommand(event.target.value)} placeholder="npx" spellCheck={false} /></label>
            <label className="span-2"><span>启动参数（一行一个）</span><textarea value={argsText} onChange={(event) => setArgsText(event.target.value)} rows={4} placeholder={"-y\n@modelcontextprotocol/server-filesystem\nD:\\\\projects"} spellCheck={false} /></label>
            <label className="span-2"><span>环境变量（密钥会加密）</span><textarea value={envText} onChange={(event) => setEnvText(event.target.value)} rows={3} placeholder="MCP_API_KEY=..." spellCheck={false} /></label>
          </div>
          <label className="checkbox-row"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /> 启用并立即探测</label>
          <div className="settings-actions">
            <button className="primary-button" onClick={() => void addServer()} disabled={busy !== null || !name.trim() || !command.trim()}>{busy === "create" ? <Loader2 size={15} className="spin" /> : <Plus size={15} />} 添加并探测</button>
            <button className="ghost-button" onClick={() => void mcpQuery.refetch()} disabled={busy !== null}><RefreshCw size={15} /> 刷新</button>
          </div>
        </div>
      </section>

      <section className="panel settings-section">
        <div className="settings-body">
          <div className="section-heading"><div><h3>已配置服务器</h3><p>探测会启动一次独立进程；崩溃或超时只会把当前服务器标记为错误，不影响 Hearth。</p></div></div>
          {mcpQuery.isLoading && <InlineLoading text="正在读取 MCP 服务器" />}
          {!mcpQuery.isLoading && servers.length === 0 && <EmptyState text="还没有配置 MCP 服务器。" />}
          <div className="data-table-list">
            {servers.map((server) => (
              <article key={server.id} className="migration-row">
                <span className={`status-dot ${server.status === "ready" ? "online" : "offline"}`} />
                <div>
                  <strong>{server.name} {server.enabled ? "" : "（已停用）"}</strong>
                  <small><code>{server.command} {server.args.join(" ")}</code>{server.envKeys.length ? ` · 环境键 ${server.envKeys.join(", ")}` : ""}</small>
                  <small>{server.tools.length} 个工具{server.lastProbeAt ? ` · 最近探测 ${relativeTime(server.lastProbeAt)}` : ""}</small>
                  {server.tools.length > 0 && <p>{server.tools.map((tool) => tool.name).join(" · ")}</p>}
                  {server.error && <p className="form-error">{server.error}</p>}
                </div>
                <div className="row-actions">
                  <button className="ghost-button compact" onClick={() => void probe(server)} disabled={busy !== null}>{busy === server.id ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />} 探测</button>
                  <button className="ghost-button compact" onClick={() => void toggleServer(server, !server.enabled)} disabled={busy !== null}>{server.enabled ? "停用" : "启用"}</button>
                  <button className="ghost-button danger compact" onClick={() => void removeServer(server)} disabled={busy !== null}><Trash2 size={14} /> 删除</button>
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="panel settings-section">
        <div className="settings-body">
          <div className="section-heading"><div><h3>网页搜索</h3><p>默认关闭。只有研究任务获得公共网络权限时才会暴露搜索工具；抓取网页仍需逐次审批。</p></div><KeyRound size={20} /></div>
          {searchQuery.isLoading && <InlineLoading text="正在读取搜索设置" />}
          {search && (
            <div className="form-grid">
              <label><span>服务</span><select value={search.provider} onChange={(event) => setSearch({ ...search, provider: event.target.value as WebSearchProvider })}><option value="tavily">Tavily</option><option value="searxng">SearXNG</option></select></label>
              <label><span>Tavily API Key {search.apiKeyMasked ? `（当前 ${search.apiKeyMasked}）` : ""}</span><input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={search.hasApiKey ? "留空则保留原密钥" : "填写 API Key"} autoComplete="off" /></label>
              <label className="span-2"><span>SearXNG 实例地址</span><input value={search.searxngUrl} onChange={(event) => setSearch({ ...search, searxngUrl: event.target.value })} placeholder="http://127.0.0.1:8888" spellCheck={false} /></label>
            </div>
          )}
          <label className="checkbox-row"><input type="checkbox" checked={search?.enabled ?? false} onChange={(event) => setSearch(search ? { ...search, enabled: event.target.checked } : search)} /> 启用网页搜索</label>
          <div className="settings-actions"><button className="primary-button" onClick={() => void saveSearch()} disabled={busy !== null || !search}>{busy === "search" ? <Loader2 size={15} className="spin" /> : <Save size={15} />} 保存搜索设置</button></div>
        </div>
      </section>
      {notice && <Notice tone={notice.tone} text={notice.text} />}
    </section>
  );
}

function parseEnvText(value: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of value.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) throw new Error(`环境变量格式不正确：${trimmed}`);
    env[trimmed.slice(0, separator).trim()] = trimmed.slice(separator + 1);
  }
  return env;
}

type NoticeState = { tone: "ok" | "error" | "info"; text: string } | null;

function Notice({ tone, text }: { tone: "ok" | "error" | "info"; text: string }) {
  return <div className={`settings-notice ${tone}`}>{tone === "ok" ? <CheckCircle2 size={15} /> : tone === "error" ? <AlertTriangle size={15} /> : <KeyRound size={15} />}<span>{text}</span></div>;
}

function InlineLoading({ text }: { text: string }) {
  return <p className="inline-loading"><Loader2 size={15} className="spin" /> {text}</p>;
}

function EmptyState({ text }: { text: string }) {
  return <p className="empty-state">{text}</p>;
}

function protocolLabel(protocol: ModelProtocol): string {
  return PROTOCOLS.find((item) => item.id === protocol)?.label ?? protocol;
}

type BindingStatus = {
  tone: "ok" | "warn";
  dot: "online" | "offline" | "idle";
  label: string;
  title: string;
};

function bindingStatus(binding: ExecutorModelBindingView, health: ExecutorView["health"] | null): BindingStatus {
  if (!binding.profileId) {
    return { tone: "warn", dot: "idle", label: "未绑定", title: "还没有为这个执行器选择模型档案" };
  }
  if (binding.issue) {
    return { tone: "warn", dot: "offline", label: binding.issue, title: binding.issue };
  }
  if (!health) {
    return { tone: "warn", dot: "offline", label: "执行器未检测", title: "没有读取到执行器健康状态" };
  }
  if (!health.canRun) {
    const label = health.installState === "missing" ? "执行器未安装" : "执行器不可用";
    return {
      tone: "warn",
      dot: "offline",
      label,
      title: health.issues.join("；") || "执行器健康检查未通过"
    };
  }
  return { tone: "ok", dot: "online", label: "可执行", title: "模型档案与执行器都可用" };
}
