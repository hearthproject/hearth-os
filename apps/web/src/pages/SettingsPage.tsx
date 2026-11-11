import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import {
  AlertTriangle,
  Bell,
  Bot,
  CheckCircle2,
  Cpu,
  Database,
  FolderTree,
  KeyRound,
  Layers,
  Link2,
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
import { formatDuration, formatNumber, relativeTime } from "../lib/format.ts";
import { TASK_STATUS_LABELS } from "../lib/labels.ts";
import type {
  ContextSettings,
  ExecutorId,
  ExecutorModelBindingView,
  ExecutorView,
  ModelProfileView,
  ModelProtocol,
  ModelProviderPreset,
  TrashItem,
  TrashKind
} from "../lib/types.ts";
import { ProactiveSettingsPanel } from "../components/ProactiveSettingsPanel.tsx";
import { ExecutorSettingsPanel } from "../components/ExecutorSettingsPanel.tsx";
import { FeishuSettingsPanel } from "../components/FeishuSettingsPanel.tsx";
import { desktopNotificationsEnabled, requestDesktopPermission, setDesktopNotificationsEnabled } from "../lib/notifications.ts";

type SettingsTab = "executors" | "models" | "proactive" | "automation" | "connections" | "context" | "data";

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

const TABS: Array<{ id: SettingsTab; label: string; hint: string; icon: typeof Cpu }> = [
  { id: "executors", label: "执行器", hint: "默认执行器、安装状态与模型绑定", icon: Cpu },
  { id: "models", label: "模型", hint: "模型档案、聊天模型与连接测试", icon: Layers },
  { id: "proactive", label: "主动", hint: "提醒预算、安静时段与触发器", icon: Bell },
  { id: "automation", label: "记忆与技能", hint: "自动运行状态，无需手工管理", icon: Sparkles },
  { id: "connections", label: "连接", hint: "飞书消息入口与外部账户", icon: Link2 },
  { id: "context", label: "上下文", hint: "接管策略、指标与清理", icon: Bot },
  { id: "data", label: "数据", hint: "SQLite、目录结构与迁移记录", icon: Database }
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
  "deepseek-harness": "DeepSeek Harness",
  hermes: "Hermes",
  qoder: "Qoder",
  workbuddy: "WorkBuddy",
  kimi: "Kimi Code"
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
      <div className="page-head settings-hero">
        <div>
          <span className="eyebrow">本机控制台</span>
          <h1>设置</h1>
          <p className="page-meta">按“执行器 → 模型 → 主动 → 记忆与技能 → 连接 → 上下文 → 数据”完成配置。密钥只保存在本机 SQLite，浏览器只能看到掩码。</p>
        </div>
        <div className="settings-defaults">
          <strong>一等执行器</strong>
          <span>DeepSeek Harness · Codex · Hearth 原生</span>
          <small>失败后由 Hearth 当前聊天模型诊断，并按权限模式决定是否切换。</small>
        </div>
      </div>

      <nav className="settings-tabs" aria-label="设置分区">
        {TABS.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              className={`settings-tab ${tab === item.id ? "active" : ""}`}
              onClick={() => selectTab(item.id)}
            >
              <Icon size={18} />
              <span><strong>{item.label}</strong><small>{item.hint}</small></span>
            </button>
          );
        })}
      </nav>

      {tab === "executors" && <ExecutorsTab />}
      {tab === "models" && <ModelsTab />}
      {tab === "proactive" && <ProactiveTab />}
      {tab === "automation" && <AutomationTab />}
      {tab === "connections" && <ConnectionsTab />}
      {tab === "context" && <ContextTab />}
      {tab === "data" && <DataTab />}
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
  const onlineExecutorCount = executors.filter((executor) => executor.health.canRun).length;
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
      <div className="settings-section-intro">
        <div><h2>执行器</h2><p>先安装并检测执行器，再指定它使用哪个模型。外部执行器仍使用各自 CLI 的登录与沙箱。</p></div>
        <span className={`status-chip ${onlineExecutorCount > 0 ? "ok" : "warn"}`}>
          <span className={`status-dot ${onlineExecutorCount > 0 ? "online" : "offline"}`} />
          {executorsQuery.isLoading ? "检测执行器中" : `${onlineExecutorCount} / ${executors.length} 个执行器可用`}
        </span>
      </div>

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
          <p className="settings-hint"><ShieldAlert size={13} /> 完全权限只影响执行过程中的审批；切换执行器仍受上下文开关、风险策略和最大接管次数约束。</p>
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
      <div className="settings-section-intro">
        <div><h2>模型</h2><p>一个模型档案只描述一个接口地址和模型。先建档案，再给聊天或其他执行器绑定。</p></div>
        <span className={`status-chip ${registry?.chatConfigured ? "ok" : "warn"}`}>{registry?.chatConfigured ? "聊天模型已就绪" : "尚未配置聊天模型"}</span>
      </div>

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

function ProactiveTab() {
  const snapshotQuery = useQuery({ queryKey: ["proactive"], queryFn: api.proactive, refetchInterval: 20_000 });
  const [desktopEnabled, setDesktopEnabled] = useState(() => desktopNotificationsEnabled());
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">(() =>
    typeof window !== "undefined" && "Notification" in window ? Notification.permission : "unsupported"
  );

  async function toggleDesktop(enabled: boolean) {
    if (enabled) {
      const result = await requestDesktopPermission();
      setPermission(result);
      if (result !== "granted") {
        setDesktopNotificationsEnabled(false);
        setDesktopEnabled(false);
        return;
      }
    }
    setDesktopNotificationsEnabled(enabled);
    setDesktopEnabled(enabled);
  }

  return (
    <section className="settings-tab-panel">
      <div className="settings-section-intro">
        <div>
          <h2>主动服务</h2>
          <p>系统只在需要你判断、授权或任务出问题时提醒。建议仍会回到普通任务和审批链，不会因为“主动”获得额外权限。</p>
        </div>
        <span className={`status-chip ${snapshotQuery.data?.settings.enabled ? "ok" : "warn"}`}>
          {snapshotQuery.data?.settings.enabled ? "主动模式已开启" : "主动模式已关闭"}
        </span>
      </div>

      {snapshotQuery.isLoading && <InlineLoading text="正在读取主动设置" />}
      {snapshotQuery.isError && <p className="form-error">{snapshotQuery.error.message}</p>}
      {snapshotQuery.data && <ProactiveSettingsPanel snapshot={snapshotQuery.data} />}
      <section className="panel settings-section">
        <div className="settings-body">
          <div className="section-heading">
            <div><h3>桌面通知</h3><p>页面打开时，审批、主动建议和异常会在系统通知里出现。页面关闭后不会推送。</p></div>
          </div>
          <label className="checkbox-field">
            <input
              type="checkbox"
              checked={desktopEnabled}
              disabled={permission === "unsupported"}
              onChange={(event) => void toggleDesktop(event.target.checked)}
            />
            <span>允许浏览器发送桌面通知</span>
          </label>
          <p className="settings-hint">
            {permission === "unsupported"
              ? "当前浏览器不支持 Notification API。"
              : permission === "denied"
                ? "浏览器已拒绝通知权限；可在浏览器站点设置里重新允许。"
                : "只在页面处于后台时发送，避免重复打断。"}
          </p>
        </div>
      </section>
      <p className="settings-hint">邮件新消息目前通过“来源新条目”触发；日历账户尚未接入。</p>
    </section>
  );
}

function ConnectionsTab() {
  return (
    <section className="settings-tab-panel">
      <div className="settings-section-intro">
        <div>
          <h2>连接</h2>
          <p>把 Hearth 接到你已经在用的消息入口。所有外部动作仍然经过审批和回执，不会因为来自手机而获得额外权限。</p>
        </div>
        <span className="status-chip">长连接 · 本机发起</span>
      </div>
      <FeishuSettingsPanel />
      <p className="settings-hint">下一步会加入邮件账户；当前邮件发送仍只写入本机发件箱。</p>
    </section>
  );
}

function ContextTab() {
  const queryClient = useQueryClient();
  const contextQuery = useQuery({ queryKey: ["contextSettings"], queryFn: api.contextSettings });
  const metricsQuery = useQuery({ queryKey: ["contextMetrics"], queryFn: api.contextMetrics, refetchInterval: 30_000 });
  const [form, setForm] = useState<ContextSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<NoticeState>(null);
  const [cleanupTaskId, setCleanupTaskId] = useState("");

  useEffect(() => {
    if (contextQuery.data?.settings && !form) setForm(contextQuery.data.settings);
  }, [contextQuery.data, form]);

  async function save() {
    if (!form) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await api.saveContextSettings({
        mode: form.mode,
        maxHandoffs: form.maxHandoffs,
        maxSameExecutorRetries: form.maxSameExecutorRetries,
        retentionDays: form.retentionDays,
        maxInlineBytes: form.maxInlineBytes,
        projectionTokenBudget: form.projectionTokenBudget,
        summarizeAfterTokens: form.summarizeAfterTokens,
        autoHandoffRisk: form.autoHandoffRisk,
        allowCodexNetwork: form.allowCodexNetwork
      });
      setForm(result.settings);
      setNotice({ tone: "ok", text: "上下文设置已保存，对之后的运行生效。" });
      await queryClient.invalidateQueries({ queryKey: ["contextSettings"] });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "保存失败" });
    } finally {
      setBusy(false);
    }
  }

  async function cleanup() {
    const taskId = cleanupTaskId.trim();
    if (!taskId) return setNotice({ tone: "info", text: "请填写要清理的任务 ID。" });
    if (!window.confirm("确定删除这个任务的上下文、摘要、接管记录和 blob？此操作不可撤销。")) return;
    setBusy(true);
    setNotice(null);
    try {
      const receipt = await api.deleteTaskContext(taskId);
      setNotice({ tone: "ok", text: `已删除 ${receipt.deletedItems} 条上下文、${receipt.deletedHandoffs} 条接管记录和 ${receipt.deletedBlobs} 个 blob。` });
      setCleanupTaskId("");
      await queryClient.invalidateQueries({ queryKey: ["contextMetrics"] });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "清理失败" });
    } finally {
      setBusy(false);
    }
  }

  const metrics = metricsQuery.data;

  return (
    <section className="settings-tab-panel">
      <div className="settings-section-intro">
        <div><h2>上下文</h2><p>所有执行器共享同一份上下文账本。切换执行器时传递摘要、产物、失败证据和未决问题，而不是各存一份历史。</p></div>
        <span className={`status-chip ${form?.mode === "on" ? "ok" : "warn"}`}>{contextModeLabel(form?.mode)}</span>
      </div>

      <div className="context-metrics settings-metric-grid">
        <Metric label="上下文条目" value={metrics ? formatNumber(metrics.ledger.items) : "—"} />
        <Metric label="自动接管" value={metrics ? formatNumber(metrics.handoffs.automatic) : "—"} />
        <Metric label="接管成功率" value={metrics?.handoffs.successRate == null ? "—" : `${Math.round(metrics.handoffs.successRate * 100)}%`} />
        <Metric label="模型诊断" value={metrics ? formatNumber(metrics.diagnosis.model) : "—"} />
      </div>

      <section className="panel settings-section">
        <div className="settings-body">
          <div className="section-heading"><div><h3>接管规则</h3><p>完全权限下执行器故障会自动切换；必要审批下只询问“是否切换执行器”。非执行器错误直接说明原因。</p></div></div>
          {!form && <InlineLoading text="正在读取上下文设置" />}
          {form && (
            <div className="form-grid context-form">
              <label><span>上下文模式</span><select value={form.mode} onChange={(event) => setForm({ ...form, mode: event.target.value as ContextSettings["mode"] })}><option value="on">开启</option><option value="shadow">只诊断，不接管</option><option value="off">关闭</option></select></label>
              <label><span>自动接管风险</span><select value={form.autoHandoffRisk} onChange={(event) => setForm({ ...form, autoHandoffRisk: event.target.value as ContextSettings["autoHandoffRisk"] })}><option value="low">低风险自动</option><option value="none">全部需要确认</option></select></label>
              <label><span>最大接管次数</span><input type="number" min={0} max={5} value={form.maxHandoffs} onChange={(event) => setForm({ ...form, maxHandoffs: Number(event.target.value) })} /></label>
              <label><span>同执行器重试</span><input type="number" min={0} max={3} value={form.maxSameExecutorRetries} onChange={(event) => setForm({ ...form, maxSameExecutorRetries: Number(event.target.value) })} /></label>
              <label><span>保留天数</span><input type="number" min={1} max={3650} value={form.retentionDays} onChange={(event) => setForm({ ...form, retentionDays: Number(event.target.value) })} /></label>
              <label><span>单条内联上限（字节）</span><input type="number" min={1024} max={1000000} step={1024} value={form.maxInlineBytes} onChange={(event) => setForm({ ...form, maxInlineBytes: Number(event.target.value) })} /></label>
              <label><span>投影预算（tokens）</span><input type="number" min={1000} max={200000} step={1000} value={form.projectionTokenBudget} onChange={(event) => setForm({ ...form, projectionTokenBudget: Number(event.target.value) })} /></label>
              <label><span>摘要阈值（tokens）</span><input type="number" min={1000} max={500000} step={1000} value={form.summarizeAfterTokens} onChange={(event) => setForm({ ...form, summarizeAfterTokens: Number(event.target.value) })} /></label>
              <label className="checkbox-field span-2"><input type="checkbox" checked={form.allowCodexNetwork} onChange={(event) => setForm({ ...form, allowCodexNetwork: event.target.checked })} /><span>允许 Codex 网络访问（不开启时，需要网络的任务不会自动切换到 Codex）</span></label>
            </div>
          )}
          <div className="settings-actions"><button className="primary-button" onClick={() => void save()} disabled={busy || !form}>{busy ? <Loader2 size={15} className="spin" /> : <Save size={15} />} 保存上下文设置</button></div>
          {notice && <Notice tone={notice.tone} text={notice.text} />}
        </div>
      </section>

      <section className="panel settings-section">
        <div className="settings-body">
          <div className="section-heading"><div><h3>清理任务上下文</h3><p>只删除上下文条目、摘要、接管记录和 blob，不删除任务本身。</p></div></div>
          <div className="input-with-action"><input value={cleanupTaskId} onChange={(event) => setCleanupTaskId(event.target.value)} placeholder="任务 ID（任务详情 URL 最后一段）" spellCheck={false} /><button className="ghost-button danger" onClick={() => void cleanup()} disabled={busy}><Trash2 size={14} /> 删除上下文</button></div>
        </div>
      </section>

      {metrics && (
        <section className="panel settings-section">
          <div className="settings-body">
            <div className="section-heading"><div><h3>运行指标</h3><p>最近刷新：{new Date(metrics.generatedAt).toLocaleString()}</p></div><button className="ghost-button compact" onClick={() => void metricsQuery.refetch()}><RefreshCw size={14} /> 刷新</button></div>
            <dl className="settings-kv">
              <div><dt>接管</dt><dd>{metrics.handoffs.total} 次 · 待确认 {metrics.handoffs.pendingUser} · 完成 {metrics.handoffs.completed} · 失败 {metrics.handoffs.failed}</dd></div>
              <div><dt>平均恢复</dt><dd>{metrics.handoffs.averageRecoveryMs == null ? "—" : formatDuration(metrics.handoffs.averageRecoveryMs)}</dd></div>
              <div><dt>平均接管上下文</dt><dd>{metrics.handoffs.averageContextTokens == null ? "—" : `${formatNumber(metrics.handoffs.averageContextTokens)} tokens`}</dd></div>
              <div><dt>诊断</dt><dd>{metrics.diagnosis.total} 次 · 模型 {metrics.diagnosis.model} · 规则 {metrics.diagnosis.rules}</dd></div>
            </dl>
          </div>
        </section>
      )}
    </section>
  );
}

function DataTab() {
  const storageQuery = useQuery({ queryKey: ["settingsStorage"], queryFn: api.settingsStorage });
  const storage = storageQuery.data;
  return (
    <section className="settings-tab-panel">
      <div className="settings-section-intro">
        <div><h2>数据</h2><p>设置、模型档案、执行器绑定、任务、事件和上下文元数据统一写入 SQLite；大块正文放在受控 blob 目录。</p></div>
        {storage && <span className="status-chip ok">SQLite schema v{storage.schemaVersion}</span>}
      </div>

      {storageQuery.isLoading && <InlineLoading text="正在读取存储信息" />}
      {storage && (
        <>
          <section className="panel settings-section">
            <div className="settings-body">
              <div className="section-heading"><div><h3>目录结构</h3><p>所有运行时数据都在 <code>{storage.dataDir}</code> 下。</p></div><FolderTree size={20} /></div>
              <dl className="settings-kv path-list">
                <div><dt>SQLite 数据库</dt><dd><code>{storage.paths.database}</code></dd></div>
                <div><dt>执行器运行时</dt><dd><code>{storage.paths.executors}</code><small>Codex 与 DeepSeek Harness 使用各自独立目录，避免污染全局登录。</small></dd></div>
                <div><dt>上下文 blob</dt><dd><code>{storage.paths.contextBlobs}</code></dd></div>
                <div><dt>加密备份</dt><dd><code>{storage.paths.backups}</code></dd></div>
                <div><dt>附件</dt><dd><code>{storage.paths.attachments}</code></dd></div>
              </dl>
              <pre className="storage-tree">{`.hearth/
├─ hearth.sqlite              # 设置、任务、事件、上下文索引
├─ executors/
│  ├─ codex/                  # 独立 CODEX_HOME
│  └─ deepseek-harness/       # DSH 运行时 home
├─ context/blobs/             # 大段上下文正文（内容寻址）
├─ backups/legacy-dev/        # 旧 JSON 设置迁移备份
├─ workspaces/                # 隔离任务工作区
├─ artifacts/                 # 受管产物
└─ outbox/                    # 本地发件箱`}</pre>
            </div>
          </section>

          <section className="panel settings-section">
            <div className="settings-body">
              <div className="section-heading"><div><h3>SQLite 设置表</h3><p>运行时以 SQLite 为唯一事实来源；旧 JSON 只在迁移时读取。</p></div></div>
              <div className="data-table-list">
                <DataRow name="app_settings" text="聊天模型、界面级键值和注册表更新时间" />
                <DataRow name="model_profiles" text="模型供应商、协议、地址、模型名和加密 API Key" />
                <DataRow name="executor_model_bindings" text="执行器与模型档案的绑定、协议覆盖和模型覆盖" />
                <DataRow name="settings_migrations" text="旧 JSON 迁移状态、源路径和备份路径" />
                <DataRow name="context_items / context_summaries" text="统一上下文账本与任务摘要" />
                <DataRow name="handoffs / diagnoses" text="执行器接管记录与模型诊断证据" />
              </div>
            </div>
          </section>

          <section className="panel settings-section">
            <div className="settings-body">
              <div className="section-heading"><div><h3>旧设置迁移</h3><p>启动时幂等迁移，失败回滚并保留原 JSON。</p></div></div>
              <dl className="settings-kv">
                <div><dt>旧模型设置</dt><dd><code>{storage.legacy.modelSettings}</code></dd></div>
                <div><dt>旧执行器设置</dt><dd><code>{storage.legacy.executorSettings}</code></dd></div>
              </dl>
              <div className="migration-list">
                {storage.migrations.length === 0 && <EmptyState text="没有迁移记录；这是干净的 SQLite 配置。" />}
                {storage.migrations.map((migration) => (
                  <article key={migration.id} className="migration-row">
                    <span className={`status-dot ${migration.status === "completed" ? "online" : migration.status === "failed" ? "offline" : "idle"}`} />
                    <div><strong>{migration.sourcePath}</strong><small>{migration.backupPath ?? "无备份路径"} · {new Date(migration.updatedAt).toLocaleString()}</small>{migration.error && <p>{migration.error}</p>}</div>
                    <span className={`status-chip ${migration.status === "completed" ? "ok" : "warn"}`}>{migration.status}</span>
                  </article>
                ))}
              </div>
            </div>
          </section>
        </>
      )}
      <TrashPanel />
    </section>
  );
}

function TrashPanel() {
  const queryClient = useQueryClient();
  const [olderThanDays, setOlderThanDays] = useState<7 | 15 | 30 | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<NoticeState>(null);
  const trashQuery = useQuery({
    queryKey: ["trash", olderThanDays ?? "all"],
    queryFn: () => api.trash(olderThanDays ? { olderThanDays } : {}),
    refetchInterval: 30_000
  });
  const items = trashQuery.data?.items ?? [];
  const selectedItems = items.filter((item) => selected.has(trashKey(item)));

  function toggle(item: TrashItem) {
    const key = trashKey(item);
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function restoreSelected() {
    if (selectedItems.length === 0) return;
    setNotice(null);
    try {
      await api.restoreTrash(selectedItems.map(({ kind, id }) => ({ kind, id })));
      setSelected(new Set());
      setNotice({ tone: "ok", text: `已恢复 ${selectedItems.length} 个项目` });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["trash"] }),
        queryClient.invalidateQueries({ queryKey: ["conversations"] }),
        queryClient.invalidateQueries({ queryKey: ["tasks"] })
      ]);
    } catch (caught) {
      setNotice({ tone: "error", text: caught instanceof Error ? caught.message : "恢复失败" });
    }
  }

  async function purgeSelected() {
    if (selectedItems.length === 0) return;
    if (!window.confirm(`要彻底删除所选的 ${selectedItems.length} 个项目吗？此操作不能撤销。`)) return;
    if (!window.confirm("再次确认：数据库记录、受管工作区和产物将被永久移除。")) return;
    setNotice(null);
    try {
      const result = await api.purgeTrash(selectedItems.map(({ kind, id }) => ({ kind, id })));
      setSelected(new Set());
      setNotice({
        tone: "ok",
        text: `已彻底删除 ${result.purgedConversations} 个对话、${result.purgedTasks} 个任务，并清理 ${result.removedAttachments} 个孤立附件`
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["trash"] }),
        queryClient.invalidateQueries({ queryKey: ["conversations"] }),
        queryClient.invalidateQueries({ queryKey: ["tasks"] })
      ]);
    } catch (caught) {
      setNotice({ tone: "error", text: caught instanceof Error ? caught.message : "彻底删除失败" });
    }
  }

  return (
    <details className="trash-disclosure">
      <summary><Trash2 size={14} /> 回收站{items.length > 0 ? ` · ${items.length}` : ""}</summary>
      <div className="trash-body">
        <div className="trash-toolbar">
          <label><span>删除时间</span><select value={olderThanDays ?? ""} onChange={(event) => { setSelected(new Set()); setOlderThanDays(event.target.value ? Number(event.target.value) as 7 | 15 | 30 : null); }}><option value="">全部</option><option value="7">7 天以前</option><option value="15">15 天以前</option><option value="30">30 天以前</option></select></label>
          <div>
            <button className="ghost-button compact" onClick={() => void restoreSelected()} disabled={selectedItems.length === 0}>恢复所选</button>
            <button className="ghost-button compact danger" onClick={() => void purgeSelected()} disabled={selectedItems.length === 0}>彻底删除</button>
          </div>
        </div>
        {trashQuery.isLoading && <InlineLoading text="正在读取回收站" />}
        {!trashQuery.isLoading && items.length === 0 && <EmptyState text="回收站是空的。" />}
        {items.length > 0 && (
          <div className="trash-list">
            {items.map((item) => (
              <label key={trashKey(item)} className="trash-row">
                <input type="checkbox" checked={selected.has(trashKey(item))} onChange={() => toggle(item)} />
                <span className="trash-kind">{item.kind === "conversation" ? "对话" : "任务"}</span>
                <span className="trash-title">{item.title}</span>
                {item.status && <span className="trash-status">{TASK_STATUS_LABELS[item.status]}</span>}
                <time>{relativeTime(item.deletedAt)}</time>
              </label>
            ))}
          </div>
        )}
        {notice && <Notice tone={notice.tone} text={notice.text} />}
        <p className="settings-hint">这里只恢复经 Hearth 删除的对话和任务；在文件系统中直接删除的文件不会进入回收站。</p>
      </div>
    </details>
  );
}

function trashKey(item: { kind: TrashKind; id: string }): string {
  return `${item.kind}:${item.id}`;
}

function AutomationTab() {
  const memoryQuery = useQuery({ queryKey: ["memory"], queryFn: api.memory, refetchInterval: 30_000 });
  const methodsQuery = useQuery({ queryKey: ["methods"], queryFn: api.methods, refetchInterval: 30_000 });
  const activeMemories = (memoryQuery.data?.memories ?? []).filter((memory) => memory.status === "active");
  const adoptedMethods = (methodsQuery.data?.methods ?? []).filter((method) => method.status === "adopted");
  const latestRecall = memoryQuery.data?.recalls[0] ?? null;
  const latestApplication = methodsQuery.data?.applications[0] ?? null;

  return (
    <section className="settings-tab-panel">
      <div className="settings-section-intro">
        <div>
          <h2>记忆与技能</h2>
          <p>任务结束后会自动提炼经历、启用记忆，并从成功任务中学习可复用技能。没有候选确认、试跑或晋升步骤。</p>
        </div>
        <span className={`status-chip ${memoryQuery.isError || methodsQuery.isError ? "warn" : "ok"}`}>
          <span className={`status-dot ${memoryQuery.isError || methodsQuery.isError ? "offline" : "online"}`} />
          全自动运行
        </span>
      </div>

      <section className="panel settings-section">
        <div className="settings-body">
          <dl className="settings-kv">
            <div>
              <dt>自动记忆</dt>
              <dd>
                自动提炼并参与后续对话
                <small>
                  {memoryQuery.isLoading ? "正在读取…" : `${activeMemories.length} 条已启用`}
                  {latestRecall ? ` · 最近召回于 ${relativeTime(latestRecall.createdAt)}` : ""}
                </small>
              </dd>
            </div>
            <div>
              <dt>自动技能</dt>
              <dd>
                成功任务自动学习并用于同模板任务
                <small>
                  {methodsQuery.isLoading ? "正在读取…" : `${adoptedMethods.length} 个技能生效中`}
                  {latestApplication ? ` · 最近复用于 ${relativeTime(latestApplication.createdAt)}` : ""}
                </small>
              </dd>
            </div>
          </dl>
          <p className="settings-hint"><ShieldAlert size={13} /> 自动化只复用已有任务的成功路径，并继承或收窄原任务权限；外部动作仍按原有审批边界执行。</p>
        </div>
      </section>
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

function Metric({ label, value }: { label: string; value: string }) {
  return <div><span>{label}</span><strong>{value}</strong></div>;
}

function DataRow({ name, text }: { name: string; text: string }) {
  return <div className="data-row"><code>{name}</code><span>{text}</span></div>;
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

function contextModeLabel(mode: ContextSettings["mode"] | undefined): string {
  if (mode === "on") return "上下文已开启";
  if (mode === "shadow") return "只诊断，不接管";
  if (mode === "off") return "上下文已关闭";
  return "读取中";
}
