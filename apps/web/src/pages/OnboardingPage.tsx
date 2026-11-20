import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Cpu,
  KeyRound,
  Loader2,
  Sparkles,
  X
} from "lucide-react";
import { api } from "../lib/api.ts";
import type { ModelProtocol, ModelProviderPreset } from "../lib/types.ts";
import { HearthMark } from "../components/HearthMark.tsx";

const STEPS = ["模型", "执行器", "知识库", "偏好", "完成"];

interface ModelDraft {
  providerId: string;
  providerName: string;
  protocol: ModelProtocol;
  baseUrl: string;
  model: string;
  apiKey: string;
}

const EMPTY_DRAFT: ModelDraft = {
  providerId: "deepseek",
  providerName: "DeepSeek",
  protocol: "openai-chat",
  baseUrl: "https://api.deepseek.com/v1",
  model: "deepseek-flash",
  apiKey: ""
};

export function OnboardingPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<ModelDraft>(EMPTY_DRAFT);
  const [draftReady, setDraftReady] = useState(false);
  const [busy, setBusy] = useState<"test" | "save" | "finish" | "skip" | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "error" | "info"; text: string } | null>(null);

  const onboardingQuery = useQuery({ queryKey: ["onboarding"], queryFn: api.onboarding });
  const registryQuery = useQuery({ queryKey: ["modelRegistry"], queryFn: api.modelRegistry });
  const executorsQuery = useQuery({ queryKey: ["executors"], queryFn: api.executors, refetchInterval: 10_000 });
  const setupQuery = useQuery({ queryKey: ["knowledgeSetup"], queryFn: api.knowledgeSetup, refetchInterval: 4_000 });
  const [knowledgeBusy, setKnowledgeBusy] = useState<"install" | "start" | null>(null);

  const configured = Boolean(registryQuery.data?.chatConfigured);
  const nativeExecutor = (executorsQuery.data?.executors ?? []).find((executor) => executor.id === "native");
  const nativeReady = Boolean(nativeExecutor?.health.canRun);

  useEffect(() => {
    if (draftReady || !registryQuery.data) return;
    const registry = registryQuery.data;
    const current = registry.profiles.find((profile) => profile.id === registry.chatProfileId);
    if (current) {
      setDraft({
        providerId: current.providerId,
        providerName: current.providerName,
        protocol: current.protocol,
        baseUrl: current.baseUrl,
        model: current.model,
        apiKey: ""
      });
    } else {
      const preset = registry.presets.find((item) => item.models.length > 0) ?? registry.presets[0];
      if (preset) setDraft(presetDraft(preset));
    }
    setDraftReady(true);
  }, [draftReady, registryQuery.data]);

  function choosePreset(preset: ModelProviderPreset) {
    setDraft((current) => presetDraft(preset, current.apiKey));
    setNotice(null);
  }

  function updateDraft<K extends keyof ModelDraft>(key: K, value: ModelDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  const modelReady = Boolean(draft.baseUrl.trim() && draft.model.trim() && (draft.apiKey.trim() || configured));

  async function testConnection() {
    if (!modelReady) {
      setNotice({ tone: "error", text: "先填写服务地址、模型名和 API Key。" });
      return;
    }
    setBusy("test");
    setNotice(null);
    try {
      const result = await api.testModel({ ...draft, apiKey: draft.apiKey.trim() });
      setNotice(result.ok
        ? { tone: "ok", text: `连接成功${result.elapsedMs === undefined ? "" : `，${result.elapsedMs} ms`}。` }
        : { tone: "error", text: result.error ?? "连接失败，请检查地址、模型名和 Key。" });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "测试连接失败" });
    } finally {
      setBusy(null);
    }
  }

  async function saveModel() {
    if (!modelReady) {
      setNotice({ tone: "error", text: "先填写服务地址、模型名和 API Key。" });
      return;
    }
    setBusy("save");
    setNotice(null);
    try {
      const result = await api.saveModelSettings({
        providerId: draft.providerId,
        providerName: draft.providerName,
        protocol: draft.protocol,
        baseUrl: draft.baseUrl.trim(),
        model: draft.model.trim(),
        ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {})
      });
      if (!result.configured) {
        setNotice({ tone: "error", text: "模型档案已保存，但还不能用于聊天。请补全 Key 后重试。" });
        return;
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["modelRegistry"] }),
        queryClient.invalidateQueries({ queryKey: ["health"] }),
        queryClient.invalidateQueries({ queryKey: ["executors"] }),
        queryClient.invalidateQueries({ queryKey: ["onboarding"] }),
        queryClient.invalidateQueries({ queryKey: ["conversationDefaults"] })
      ]);
      setNotice({ tone: "ok", text: "模型已就绪，聊天和原生执行器都可以使用。" });
      setStep(1);
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "保存模型失败" });
    } finally {
      setBusy(null);
    }
  }

  async function finish() {
    setBusy("finish");
    setNotice(null);
    try {
      await api.completeOnboarding(false);
      await queryClient.invalidateQueries({ queryKey: ["onboarding"] });
      navigate("/", { replace: true });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "完成设置失败" });
      setBusy(null);
    }
  }

  async function skip() {
    setBusy("skip");
    setNotice(null);
    try {
      await api.completeOnboarding(true);
      await queryClient.invalidateQueries({ queryKey: ["onboarding"] });
      navigate("/", { replace: true });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "跳过失败" });
      setBusy(null);
    }
  }

  function next() {
    setNotice(null);
    if (step === 0) void saveModel();
    else if (step === 1) setStep(2);
    else if (step === 2) setStep(3);
    else void finish();
  }

  async function handleKnowledge(action: "install" | "start") {
    setKnowledgeBusy(action);
    setNotice(null);
    try {
      if (action === "install") {
        await api.installKnowledge();
        setNotice({ tone: "info", text: "已开始安装 OpenViking，完成后可以直接进入下一步。" });
      } else {
        const result = await api.startKnowledgeService();
        if (result.setup.running) {
          await api.saveKnowledgeSettings({ enabled: true, manageProcess: true });
          setNotice({ tone: "ok", text: "知识库已启动并启用。" });
        } else {
          setNotice({ tone: "error", text: "服务尚未就绪，可以稍后在设置里重试。" });
        }
      }
      await setupQuery.refetch();
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "操作失败" });
    } finally {
      setKnowledgeBusy(null);
    }
  }

  const skipButton = (
    <button className="ghost-button mostly-ghost" onClick={() => void skip()} disabled={busy !== null}>
      暂时跳过
    </button>
  );

  return (
    <div className="wizard-shell">
      <div className="wizard-card">
        <header className="wizard-head">
          <div className="wizard-brand">
            <HearthMark size={24} />
            <strong>Hearth</strong>
          </div>
          {skipButton}
        </header>

        <ol className="wizard-steps" aria-label="设置步骤">
          {STEPS.map((label, index) => (
            <li key={label} className={`${index === step ? "active" : ""} ${index < step ? "done" : ""}`}>
              <span>{label}</span>
            </li>
          ))}
        </ol>

        <main className="wizard-body">
          {step === 0 && (
            <section className="wizard-panel">
              <h1>模型</h1>

              <div className="wizard-provider-grid">
                {(registryQuery.data?.presets ?? []).map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    className={`wizard-provider ${draft.providerId === preset.id ? "active" : ""}`}
                    onClick={() => choosePreset(preset)}
                    title={preset.note}
                  >
                    <strong>{preset.name}</strong>
                  </button>
                ))}
              </div>

              <div className="wizard-form">
                <label className="span-2"><span>档案名称</span><input value={draft.providerName} onChange={(event) => updateDraft("providerName", event.target.value)} placeholder="例如：DeepSeek 主模型" /></label>
                <label><span>接口协议</span>
                  <select value={draft.protocol} onChange={(event) => updateDraft("protocol", event.target.value as ModelProtocol)}>
                    <option value="openai-chat">OpenAI Chat</option>
                    <option value="openai-responses">OpenAI Responses</option>
                    <option value="anthropic-messages">Anthropic Messages</option>
                    <option value="gemini">Gemini</option>
                  </select>
                </label>
                <label><span>模型名</span><input value={draft.model} onChange={(event) => updateDraft("model", event.target.value)} placeholder="例如：deepseek-chat" spellCheck={false} /></label>
                <label className="span-2"><span>服务地址</span><input value={draft.baseUrl} onChange={(event) => updateDraft("baseUrl", event.target.value)} placeholder="https://api.example.com/v1" spellCheck={false} /></label>
                <label className="span-2"><span>API Key</span><input type="password" value={draft.apiKey} onChange={(event) => updateDraft("apiKey", event.target.value)} placeholder={configured ? "留空保留当前 Key" : "sk-..."} autoComplete="off" /></label>
              </div>

              <div className="wizard-inline-actions">
                <button className="ghost-button" onClick={() => void testConnection()} disabled={busy !== null || !modelReady}>
                  {busy === "test" ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />} 测试连接
                </button>
              </div>
            </section>
          )}

          {step === 1 && (
            <section className="wizard-panel">
              <h1>执行器</h1>

              <div className="wizard-executor-list">
                {(["native", "codex", "deepseek-harness"] as const).map((id) => {
                  const executor = (executorsQuery.data?.executors ?? []).find((item) => item.id === id);
                  if (!executor) return null;
                  const healthy = executor.health.canRun;
                  return (
                    <article key={id} className="wizard-executor">
                      <span className={`status-dot ${healthy ? "online" : "offline"}`} />
                      <div>
                        <strong>{executor.name}</strong>
                        <small>{healthy ? "已就绪" : executor.health.issues.join("；") || "暂未就绪"}</small>
                      </div>
                    </article>
                  );
                })}
              </div>

              {!nativeReady && (
                <p className="wizard-note warn"><Cpu size={14} /> 原生执行器还需要模型绑定。</p>
              )}

              <div className="wizard-inline-actions">
                <button className="ghost-button" onClick={() => void executorsQuery.refetch()} disabled={executorsQuery.isFetching}>
                  {executorsQuery.isFetching ? <Loader2 size={14} className="spin" /> : <Cpu size={14} />} 重新检测
                </button>
              </div>
            </section>
          )}

          {step === 2 && (
            <section className="wizard-panel">
              <h1>知识库（可选）</h1>
              <p className="wizard-note">
                OpenViking 是本机语义索引服务，不安装也能正常聊天、执行任务和使用记忆。需要时可以在设置里随时补装。
              </p>
              {setupQuery.data && (
                <div className="wizard-knowledge">
                  <div className="wizard-knowledge-status">
                    <span className={`status-dot ${setupQuery.data.running ? "online" : "offline"}`} />
                    <strong>
                      {setupQuery.data.installed
                        ? setupQuery.data.running ? "已安装并在运行" : "已安装，服务未运行"
                        : "尚未安装"}
                    </strong>
                  </div>
                  <p className="wizard-note">
                    安装使用 uv 下载 OpenViking 与本地嵌入模型，首次约占用 0.8–1 GiB 磁盘，并需要联网。
                  </p>
                  <div className="wizard-inline-actions">
                    {!setupQuery.data.installed && (
                      <button
                        className="primary-button"
                        onClick={() => void handleKnowledge("install")}
                        disabled={knowledgeBusy !== null || !setupQuery.data.uv || setupQuery.data.install.status === "running"}
                      >
                        {knowledgeBusy === "install" || setupQuery.data.install.status === "running" ? <Loader2 size={14} className="spin" /> : null}
                        安装 OpenViking
                      </button>
                    )}
                    {setupQuery.data.installed && !setupQuery.data.running && (
                      <button className="primary-button" onClick={() => void handleKnowledge("start")} disabled={knowledgeBusy !== null}>
                        {knowledgeBusy === "start" ? <Loader2 size={14} className="spin" /> : null} 启动并启用
                      </button>
                    )}
                    {setupQuery.data.running && <span className="status-chip ok"><CheckCircle2 size={13} /> 已就绪</span>}
                  </div>
                  {!setupQuery.data.uv && !setupQuery.data.installed && (
                    <p className="wizard-note warn"><X size={14} /> 没有检测到 uv，可以先跳过，之后安装 uv 再回来设置。</p>
                  )}
                  {setupQuery.data.install.status === "running" && (
                    <pre className="wizard-install-log">{setupQuery.data.install.log.slice(-2000)}</pre>
                  )}
                </div>
              )}
            </section>
          )}

          {step === 3 && (
            <section className="wizard-panel">
              <h1>完成</h1>

              <div className="wizard-summary">
                <SummaryRow ok={configured} label="聊天模型" value={configured ? `${draft.providerName} · ${draft.model}` : "尚未配置"} />
                <SummaryRow ok={nativeReady} label="原生执行器" value={nativeReady ? "已就绪" : "未就绪"} />
                <SummaryRow ok label="记忆与技能" value="后台自动运行" />
              </div>

              {!configured && (
                <p className="wizard-note warn"><X size={14} /> 还没有可用的聊天模型，可以先跳过，在设置里补上。</p>
              )}
            </section>
          )}

          {notice && <div className={`settings-notice ${notice.tone}`}>{notice.tone === "ok" ? <CheckCircle2 size={15} /> : notice.tone === "error" ? <X size={15} /> : <KeyRound size={15} />}<span>{notice.text}</span></div>}
        </main>

        <footer className="wizard-footer">
          <button className="ghost-button" onClick={() => setStep((current) => Math.max(0, current - 1))} disabled={step === 0 || busy !== null}>
            <ArrowLeft size={14} /> 上一步
          </button>
          <div className="wizard-footer-right">
            <button className="primary-button" onClick={next} disabled={busy !== null || (step === 0 && !modelReady)}>
              {busy === "save" || busy === "finish" ? <Loader2 size={15} className="spin" /> : null}
              {step === 3 ? "完成" : step === 0 ? "保存并继续" : "继续"}
              {step < 3 && <ArrowRight size={14} />}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

function SummaryRow({ ok, label, value }: { ok: boolean; label: string; value: string }) {
  return (
    <div className="wizard-summary-row">
      <span className={ok ? "summary-ok" : "summary-warn"}>{ok ? <CheckCircle2 size={16} /> : <X size={16} />}</span>
      <strong>{label}</strong>
      <span>{value}</span>
    </div>
  );
}

function presetDraft(preset: ModelProviderPreset, apiKey = ""): ModelDraft {
  return {
    providerId: preset.id,
    providerName: preset.name,
    protocol: preset.protocol,
    baseUrl: preset.baseUrl,
    model: preset.models[0] ?? "",
    apiKey
  };
}
