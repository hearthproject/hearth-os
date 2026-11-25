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
  Save,
  Sparkles,
  Trash2
} from "lucide-react";
import { api } from "../lib/api.ts";
import { formatNumber } from "../lib/format.ts";
import { DEFAULT_CONTEXT_WINDOW_TOKENS, DEFAULT_MAX_OUTPUT_TOKENS } from "@hearth/core/constants";
import { suggestContextWindowTokens } from "@hearth/core";
import type {
  ModelProfileView,
  ModelProtocol,
  ModelProviderPreset
} from "../lib/types.ts";
import { ExecutorSettingsPanel } from "../components/ExecutorSettingsPanel.tsx";
import { DataSettingsPanel } from "../components/DataSettingsPanel.tsx";
import { DossierPanel } from "../components/DossierPanel.tsx";
import { AppearanceSettingsPanel } from "../components/AppearanceSettingsPanel.tsx";

type SettingsTab = "appearance" | "executors" | "models" | "dossier" | "data";

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
  { id: "appearance", label: "外观" },
  { id: "executors", label: "执行器" },
  { id: "models", label: "模型" },
  { id: "dossier", label: "档案" },
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
  contextWindowTokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
  maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
  apiKey: ""
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
          {tab === "appearance" && <AppearanceSettingsPanel />}
          {tab === "executors" && <ExecutorsTab />}
          {tab === "models" && <ModelsTab />}
          {tab === "dossier" && <DossierPanel />}
          {tab === "data" && <DataSettingsPanel />}
        </div>
      </div>
    </div>
  );
}

function ExecutorsTab() {
  return (
    <section className="settings-tab-panel">
      <ExecutorSettingsPanel />
    </section>
  );
}

function ModelsTab() {
  const queryClient = useQueryClient();
  const registryQuery = useQuery({ queryKey: ["modelRegistry"], queryFn: api.modelRegistry });
  const [draft, setDraft] = useState<ProfileDraft>(EMPTY_DRAFT);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
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
    setDraft((previous) => ({ ...previous, [key]: value }));
  }

  function pickPreset(preset: ModelProviderPreset) {
    const presetModel = preset.models[0] ?? "";
    const sibling = registry?.profiles.find((profile) => profile.baseUrl === preset.baseUrl && profile.model === presetModel);
    setDraft((previous) => ({
      ...previous,
      providerId: preset.id,
      providerName: preset.name,
      protocol: preset.protocol,
      baseUrl: preset.baseUrl,
      model: presetModel,
      name: previous.name || `${preset.name} · ${preset.models[0] ?? "模型"}`,
      ...(sibling
        ? { contextWindowTokens: sibling.contextWindowTokens, maxOutputTokens: sibling.maxOutputTokens }
        : { contextWindowTokens: suggestContextWindowTokens(presetModel, previous.contextWindowTokens) })
    }));
    setModels(preset.models);
    setNotice(null);
  }

  function pickProvider(id: string) {
    if (id === "custom") {
      setDraft((previous) => ({ ...previous, providerId: "custom", providerName: "", baseUrl: "", protocol: "openai-chat" }));
      setModels([]);
      return;
    }
    const preset = registry?.presets.find((item) => item.id === id);
    if (preset) pickPreset(preset);
  }

  function updateModel(value: string) {
    const sibling = registry?.profiles.find((profile) => profile.baseUrl === draft.baseUrl && profile.model === value);
    setDraft((previous) => ({
      ...previous,
      model: value,
      ...(sibling
        ? { contextWindowTokens: sibling.contextWindowTokens, maxOutputTokens: sibling.maxOutputTokens }
        : { contextWindowTokens: suggestContextWindowTokens(value, previous.contextWindowTokens) })
    }));
  }

  function startNew() {
    setEditingId(null);
    setDraft(EMPTY_DRAFT);
    setModels([]);
    setNotice(null);
    setEditorOpen(true);
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
    setNotice(null);
    setEditorOpen(true);
  }

  function closeEditor() {
    setEditingId(null);
    setDraft(EMPTY_DRAFT);
    setModels([]);
    setEditorOpen(false);
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
      setNotice({ tone: "ok", text: editingId ? "模型档案已更新。" : "模型档案已创建。" });
      closeEditor();
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
      if (editingId === profile.id) closeEditor();
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
      setNotice({ tone: "ok", text: "聊天模型已更新。" });
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

  const selectedPresetId = registry?.presets.some((preset) => preset.id === draft.providerId) ? draft.providerId : "custom";

  return (
    <section className="settings-tab-panel model-settings-panel">
      <section className="panel settings-section">
        <div className="settings-body">
          <div className="section-heading"><div><h3>聊天模型</h3></div></div>
          <div className="chat-profile-row">
            <label>
              <span>当前使用</span>
              <select value={chatProfileId} onChange={(event) => setChatProfileId(event.target.value)}>
                <option value="">未选择</option>
                {(registry?.profiles ?? []).map((profile) => <option key={profile.id} value={profile.id}>{profile.name} · {profile.model}</option>)}
              </select>
            </label>
            <button className="primary-button" onClick={() => void saveChatProfile()} disabled={busy !== null}>
              {busy === "chat" ? <Loader2 size={15} className="spin" /> : <Save size={15} />} 保存
            </button>
          </div>
        </div>
      </section>

      {!editorOpen && (
        <section className="panel settings-section model-catalog">
          <div className="settings-body">
            <div className="section-heading">
              <div><h3>模型档案</h3></div>
              <button className="ghost-button compact" onClick={startNew}><Plus size={14} /> 新建模型</button>
            </div>
            {registryQuery.isLoading && <InlineLoading text="正在读取模型档案" />}
            <div className="model-list">
              {(registry?.profiles ?? []).map((profile) => (
                <article key={profile.id} className="model-card">
                  <div className="model-card-head">
                    <div>
                      <strong>{profile.name}</strong>
                      <small>{profile.providerName} · {profile.model}</small>
                    </div>
                    {registry?.chatProfileId === profile.id && <span className="status-chip ok">聊天模型</span>}
                  </div>
                  <div className="model-card-actions">
                    <button className="ghost-button compact" onClick={() => edit(profile)}><Pencil size={13} /> 编辑</button>
                    <button className="ghost-button compact danger" onClick={() => void remove(profile)} disabled={busy !== null}><Trash2 size={13} /> 删除</button>
                  </div>
                </article>
              ))}
              {registry && registry.profiles.length === 0 && <EmptyState text="还没有模型档案。" />}
            </div>
          </div>
        </section>
      )}

      {editorOpen && (
        <section className="panel settings-section model-editor-inline">
          <div className="settings-body">
            <div className="section-heading">
              <div><h3>{editingId ? "编辑模型" : "新建模型"}</h3></div>
              <button className="ghost-button compact" onClick={closeEditor}>取消</button>
            </div>

            <div className="form-grid">
              <label>
                <span>服务</span>
                <select value={selectedPresetId} onChange={(event) => pickProvider(event.target.value)}>
                  {(registry?.presets ?? []).map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
                  <option value="custom">自定义服务</option>
                </select>
              </label>
              <label><span>名称</span><input value={draft.name} onChange={(event) => update("name", event.target.value)} placeholder="例如：DeepSeek 主模型" /></label>
              <label className="span-2"><span>服务地址</span><input value={draft.baseUrl} onChange={(event) => update("baseUrl", event.target.value)} placeholder="https://api.deepseek.com/v1" spellCheck={false} /></label>
              <label><span>模型</span><div className="input-with-action"><input value={draft.model} onChange={(event) => updateModel(event.target.value)} placeholder="手工填写或拉取" list="settings-model-options" spellCheck={false} /><button type="button" className="ghost-button compact" onClick={() => void fetchModels()} disabled={busy !== null}>{busy === "models" ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />} 拉取</button></div><datalist id="settings-model-options">{models.map((model) => <option key={model} value={model} />)}</datalist></label>
              <label><span>API Key</span><input type="password" value={draft.apiKey} onChange={(event) => update("apiKey", event.target.value)} placeholder={editingId ? "留空保留原密钥" : "sk-..."} autoComplete="off" /></label>
            </div>

            <details className="form-advanced">
              <summary>高级参数<span>{formatNumber(draft.contextWindowTokens)} 上下文 · {formatNumber(draft.maxOutputTokens)} 输出</span></summary>
              <div className="form-grid">
                <label><span>接口协议</span><select value={draft.protocol} onChange={(event) => update("protocol", event.target.value as ModelProtocol)}>{PROTOCOLS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
                <label><span>服务名称</span><input value={draft.providerName} onChange={(event) => update("providerName", event.target.value)} placeholder="例如：DeepSeek" /></label>
                <label><span>上下文窗口（Token）</span><input type="number" min={4096} max={10000000} step={1000} value={draft.contextWindowTokens} onChange={(event) => update("contextWindowTokens", Number(event.target.value))} /></label>
                <label><span>单次最大输出（Token）</span><input type="number" min={256} max={1000000} step={256} value={draft.maxOutputTokens} onChange={(event) => update("maxOutputTokens", Number(event.target.value))} /></label>
              </div>
            </details>

            <div className="settings-actions">
              <button className="primary-button" onClick={() => void save()} disabled={busy !== null}>{busy === "save" ? <Loader2 size={15} className="spin" /> : <Save size={15} />} {editingId ? "保存修改" : "创建模型"}</button>
              <button className="ghost-button" onClick={() => void testConnection()} disabled={busy !== null}>{busy === "test" ? <Loader2 size={15} className="spin" /> : <PlugZap size={15} />} 测试连接</button>
            </div>
            <p className="settings-hint"><KeyRound size={13} /> API Key 只保存在本机。</p>
          </div>
        </section>
      )}

      {notice && <Notice tone={notice.tone} text={notice.text} />}
    </section>
  );
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
