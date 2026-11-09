import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  Cpu,
  KeyRound,
  Loader2,
  ShieldCheck,
  Sparkles,
  X
} from "lucide-react";
import { api } from "../lib/api.ts";
import type { ModelProtocol, ModelProviderPreset } from "../lib/types.ts";
import { HearthMark } from "../components/HearthMark.tsx";

const STEPS = ["接入模型", "检查执行器", "自动与主动", "开始使用"];

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
  const [proactive, setProactive] = useState(true);
  const [preferencesReady, setPreferencesReady] = useState(false);
  const [busy, setBusy] = useState<"test" | "save" | "preferences" | "finish" | "skip" | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "error" | "info"; text: string } | null>(null);

  const onboardingQuery = useQuery({ queryKey: ["onboarding"], queryFn: api.onboarding });
  const registryQuery = useQuery({ queryKey: ["modelRegistry"], queryFn: api.modelRegistry });
  const executorsQuery = useQuery({ queryKey: ["executors"], queryFn: api.executors, refetchInterval: 10_000 });

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

  useEffect(() => {
    if (preferencesReady || !onboardingQuery.data) return;
    setProactive(onboardingQuery.data.state === null ? true : onboardingQuery.data.checks.proactiveEnabled);
    setPreferencesReady(true);
  }, [preferencesReady, onboardingQuery.data]);

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

  async function savePreferences() {
    setBusy("preferences");
    setNotice(null);
    try {
      await Promise.all([
        api.updateMemorySettings({ autoCapture: "experience" }),
        api.updateProactiveSettings({ enabled: proactive })
      ]);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["memory"] }),
        queryClient.invalidateQueries({ queryKey: ["proactive"] }),
        queryClient.invalidateQueries({ queryKey: ["onboarding"] })
      ]);
      setStep(3);
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "保存偏好失败" });
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
    else if (step === 2) void savePreferences();
    else void finish();
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
            <HearthMark size={28} />
            <div>
              <strong>Hearth</strong>
              <small>把第一件事交给它</small>
            </div>
          </div>
          {skipButton}
        </header>

        <ol className="wizard-steps" aria-label="设置步骤">
          {STEPS.map((label, index) => (
            <li key={label} className={`${index === step ? "active" : ""} ${index < step ? "done" : ""}`}>
              <span className="wizard-step-dot">{index < step ? <Check size={12} /> : index + 1}</span>
              <span>{label}</span>
            </li>
          ))}
        </ol>

        <main className="wizard-body">
          {step === 0 && (
            <section className="wizard-panel">
              <span className="eyebrow">第一步</span>
              <h1>先让 Hearth 能说话</h1>
              <p className="wizard-lead">选一个模型服务商，填入 API Key。保存后会自动设为聊天模型，并绑定 Hearth 原生执行器。</p>

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
                    <small>{preset.protocol}</small>
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
                <span className="wizard-hint"><ShieldCheck size={13} /> Key 只保存在本机 SQLite，加密存储，界面只显示掩码。</span>
              </div>
              {configured && (
                <p className="wizard-note"><CheckCircle2 size={14} /> 当前已有聊天模型；只改想改的字段，Key 留空即可。</p>
              )}
            </section>
          )}

          {step === 1 && (
            <section className="wizard-panel">
              <span className="eyebrow">第二步</span>
              <h1>执行器检查</h1>
              <p className="wizard-lead">Hearth 原生执行器已经随聊天模型就绪。Codex、Hermes 等外部执行器可以稍后在设置里接入。</p>

              <div className="wizard-executor-list">
                {(["native", "codex", "hermes"] as const).map((id) => {
                  const executor = (executorsQuery.data?.executors ?? []).find((item) => item.id === id);
                  if (!executor) return null;
                  const healthy = executor.health.canRun;
                  return (
                    <article key={id} className={`wizard-executor ${id === "native" ? "featured" : ""}`}>
                      <span className={`status-dot ${healthy ? "online" : "offline"}`} />
                      <div>
                        <strong>{executor.name}{id === "native" ? " · 推荐" : ""}</strong>
                        <small>{healthy ? "已就绪" : executor.health.issues.join("；") || "暂未就绪"}</small>
                      </div>
                      <span className={`status-chip ${healthy ? "ok" : "warn"}`}>{healthy ? "可用" : "未就绪"}</span>
                    </article>
                  );
                })}
              </div>

              {!nativeReady && (
                <p className="wizard-note warn"><Cpu size={14} /> 原生执行器还需要模型绑定。保存模型后通常会自动完成；如果仍不可用，可以到执行器设置里手动绑定。</p>
              )}

              <div className="wizard-inline-actions">
                <button className="ghost-button" onClick={() => void executorsQuery.refetch()} disabled={executorsQuery.isFetching}>
                  {executorsQuery.isFetching ? <Loader2 size={14} className="spin" /> : <Cpu size={14} />} 重新检测
                </button>
                <button className="ghost-button mostly-ghost" onClick={() => navigate("/settings")}>管理全部执行器</button>
              </div>
            </section>
          )}

          {step === 2 && (
            <section className="wizard-panel">
              <span className="eyebrow">第三步</span>
              <h1>让它自动记住并变熟练</h1>
              <p className="wizard-lead">记忆和技能会在后台自动整理，不需要确认。你只需要决定是否接收主动提醒。</p>

              <div className="wizard-preferences">
                <label className="wizard-toggle">
                  <input type="checkbox" checked={proactive} onChange={(event) => setProactive(event.target.checked)} />
                  <span>
                    <strong>主动提醒</strong>
                    <small>只在任务需要你确认、失败或临近截止时出现。默认每天最多 5 条，22:00–08:00 静默。</small>
                  </span>
                </label>
              </div>

              <p className="wizard-note"><KeyRound size={14} /> 自动记忆与技能无需手工管理；提醒预算和安静时段仍可在“设置 → 主动”里调整。</p>
            </section>
          )}

          {step === 3 && (
            <section className="wizard-panel wizard-finish">
              <span className="eyebrow">最后一步</span>
              <h1>可以开始了</h1>
              <p className="wizard-lead">Hearth 会先回答问题；需要动手的任务会进入任务页，外部动作仍然要经过你的审批。</p>

              <div className="wizard-summary">
                <SummaryRow ok={configured} label="聊天模型" value={configured ? `${draft.providerName} · ${draft.model}` : "尚未配置，可稍后补上"} />
                <SummaryRow ok={nativeReady} label="原生执行器" value={nativeReady ? "已就绪" : "未就绪，可到设置里检查"} />
                <SummaryRow ok label="记忆与技能" value="后台自动运行" />
                <SummaryRow ok label="主动提醒" value={proactive ? "已开启" : "保持关闭"} />
              </div>

              <div className="wizard-tip">
                <Sparkles size={16} />
                <div>
                  <strong>第一件事可以很小</strong>
                  <p>比如“整理这周的会议记录”“分析一个网址并给出要点”，或者让 Hearth 帮你写一个批量重命名脚本。</p>
                </div>
              </div>

              {!configured && (
                <p className="wizard-note warn"><X size={14} /> 还没有可用的聊天模型。可以返回上一步配置，或者先跳过，在设置里随时补上。</p>
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
            <span className="wizard-footer-hint">{step === 0 ? "保存后可随时更换" : step === 3 ? "之后都能在设置里修改" : "大约还需要 1 分钟"}</span>
            <button className="primary-button" onClick={next} disabled={busy !== null || (step === 0 && !modelReady)}>
              {busy === "save" || busy === "preferences" || busy === "finish" ? <Loader2 size={15} className="spin" /> : null}
              {step === 3 ? "进入 Hearth" : step === 0 ? "保存并继续" : "继续"}
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
