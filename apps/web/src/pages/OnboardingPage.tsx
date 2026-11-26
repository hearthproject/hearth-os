import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Download,
  KeyRound,
  Loader2,
  RefreshCw,
  Sparkles,
  X
} from "lucide-react";
import { api } from "../lib/api.ts";
import type { ExecutorId, ExecutorView, ModelProtocol, ModelProviderPreset, OnboardingVerificationView } from "../lib/types.ts";
import { HearthMark } from "../components/HearthMark.tsx";
import { ExecutorBootstrapStatus } from "../components/ExecutorBootstrapStatus.tsx";
import { useExecutorBootstrap } from "../lib/use-executor-bootstrap.ts";

const STEPS = ["执行器", "模型", "验证"];
const EXTERNAL_EXECUTOR_IDS: ExecutorId[] = ["codex", "deepseek-harness"];
const EXECUTOR_DISPLAY_ORDER: ExecutorId[] = ["codex", "deepseek-harness", "native"];

interface ModelDraft {
  providerId: string;
  providerName: string;
  protocol: ModelProtocol;
  baseUrl: string;
  model: string;
  apiKey: string;
}

interface BindingOutcome {
  ok: boolean;
  message: string;
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
  const { installs, bootstrap } = useExecutorBootstrap();
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<ModelDraft>(EMPTY_DRAFT);
  const [draftReady, setDraftReady] = useState(false);
  const [busy, setBusy] = useState<"test" | "save" | "bind" | "finish" | "skip" | "verify" | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "error" | "info"; text: string } | null>(null);
  const [verification, setVerification] = useState<OnboardingVerificationView | null>(null);
  const [skipVerification, setSkipVerification] = useState(false);
  const [bindingOutcomes, setBindingOutcomes] = useState<Partial<Record<ExecutorId, BindingOutcome>>>({});

  const registryQuery = useQuery({ queryKey: ["modelRegistry"], queryFn: api.modelRegistry });
  const executorsQuery = useQuery({ queryKey: ["executors"], queryFn: api.executors, refetchInterval: 10_000 });

  const executors = executorsQuery.data?.executors ?? [];
  const selectedExecutorId = executorsQuery.data?.preferredExecutorId ?? "native";
  const selectedExecutor = executors.find((executor) => executor.id === selectedExecutorId) ?? null;
  const configured = Boolean(selectedExecutor?.effectiveModel);
  const nativeExecutor = executors.find((executor) => executor.id === "native");
  const nativeReady = Boolean(nativeExecutor?.health.canRun);
  const installedExternalIds = EXTERNAL_EXECUTOR_IDS.filter((id) => {
    const executor = executors.find((item) => item.id === id);
    return executor ? executorInstalled(executor) : false;
  });
  const installingAny = Object.values(installs).some((state) => state?.status === "installing");
  const bindingFailures = Object.values(bindingOutcomes).filter((outcome) => outcome && !outcome.ok);

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

  async function installExecutor(id: ExecutorId) {
    setNotice(null);
    try {
      const result = await bootstrap(id);
      setNotice({
        tone: "ok",
        text: result.probe.ok
          ? `${result.install.message} 真实可用性测试已通过。`
          : `${result.install.message} 执行器已检测到，选择模型后会自动完成绑定和真实测试。`
      });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "执行器下载或安装失败" });
    }
  }

  async function bindInstalledExecutors(): Promise<Partial<Record<ExecutorId, BindingOutcome>>> {
    setBusy("bind");
    const latest = await queryClient.fetchQuery({ queryKey: ["executors"], queryFn: api.executors });
    const targets = EXTERNAL_EXECUTOR_IDS.filter((id) => {
      const executor = latest.executors.find((item) => item.id === id);
      return executor ? executorInstalled(executor) : false;
    });
    const entries = await Promise.all(targets.map(async (id) => {
      try {
        const result = await api.autoBindExecutor(id);
        const name = latest.executors.find((item) => item.id === id)?.name ?? id;
        const model = result.binding.effectiveModel ?? draft.model;
        if (result.probe?.ok) {
          return [id, { ok: true, message: `${name} 已绑定 ${model}，真实测试通过。` }] as const;
        }
        return [id, {
          ok: false,
          message: `${name} 已绑定 ${model}，但真实测试未通过：${result.probe?.error ?? result.binding.issue ?? "未知原因"}`
        }] as const;
      } catch (error) {
        const name = latest.executors.find((item) => item.id === id)?.name ?? id;
        return [id, {
          ok: false,
          message: `${name} 绑定失败：${error instanceof Error ? error.message : "未知原因"}`
        }] as const;
      }
    }));
    const outcomes = Object.fromEntries(entries) as Partial<Record<ExecutorId, BindingOutcome>>;
    setBindingOutcomes(outcomes);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["executors"] }),
      queryClient.invalidateQueries({ queryKey: ["modelRegistry"] }),
      queryClient.invalidateQueries({ queryKey: ["health"] }),
      queryClient.invalidateQueries({ queryKey: ["onboarding"] }),
      queryClient.invalidateQueries({ queryKey: ["conversationDefaults"] })
    ]);
    return outcomes;
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
        setNotice({ tone: "error", text: "模型档案已保存，但还不能用于当前执行器。请补全 Key 后重试。" });
        return;
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["modelRegistry"] }),
        queryClient.invalidateQueries({ queryKey: ["health"] }),
        queryClient.invalidateQueries({ queryKey: ["conversationDefaults"] })
      ]);
      const outcomes = await bindInstalledExecutors();
      const failures = Object.values(outcomes).filter((outcome) => outcome && !outcome.ok);
      setNotice(failures.length > 0
        ? { tone: "error", text: `模型已保存。${failures.map((outcome) => outcome?.message).join(" ")}` }
        : { tone: "ok", text: "模型已保存，已检测到的执行器已完成自动绑定和真实测试。" });
      setStep(2);
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "保存模型失败" });
    } finally {
      setBusy(null);
    }
  }

  async function retryBindings() {
    setNotice(null);
    try {
      const outcomes = await bindInstalledExecutors();
      const failures = Object.values(outcomes).filter((outcome) => outcome && !outcome.ok);
      setNotice(failures.length > 0
        ? { tone: "error", text: failures.map((outcome) => outcome?.message).join(" ") }
        : { tone: "ok", text: "执行器已重新绑定，真实测试通过。" });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "重新绑定失败" });
    } finally {
      setBusy(null);
    }
  }

  async function verify() {
    setBusy("verify");
    setNotice(null);
    try {
      const result = await api.verifyOnboarding();
      setVerification(result.verification);
      setNotice(result.verification.ok
        ? { tone: "ok", text: "示例任务已跑通：模型写入了文件，并跑过了真实测试。" }
        : { tone: "error", text: result.verification.summary });
      await queryClient.invalidateQueries({ queryKey: ["onboarding"] });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "示例任务失败" });
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
    if (step === 0) setStep(1);
    else if (step === 1) void saveModel();
    else void finish();
  }

  const skipButton = (
    <button className="ghost-button mostly-ghost" onClick={() => void skip()} disabled={busy !== null || installingAny}>
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
              <h1>执行器</h1>
              <p className="wizard-note">
                Hearth 会自动检查本机和当前应用依赖。已安装的执行器直接标记为可用；未安装的可以在这里按需下载。
              </p>

              <div className="wizard-executor-list">
                {EXECUTOR_DISPLAY_ORDER.map((id) => {
                  const executor = executors.find((item) => item.id === id);
                  if (!executor) {
                    if (id === "native") return null;
                    return (
                      <article key={id} className="wizard-executor">
                        <Loader2 size={15} className="spin" />
                        <div className="wizard-executor-copy">
                          <strong>{id === "codex" ? "Codex" : "DeepSeek Harness"}</strong>
                          <small>{executorsQuery.isLoading ? "正在检测本机安装…" : "等待检测结果"}</small>
                        </div>
                      </article>
                    );
                  }
                  const install = installs[id];
                  const installed = executorInstalled(executor) || install?.status === "complete";
                  const healthy = executor.health.canRun;
                  const failed = install?.status === "error";
                  const installing = install?.status === "installing";
                  const stateTone = healthy ? "ok" : installed ? "detected" : failed ? "warn" : "warn";
                  return (
                    <article key={id} className={`wizard-executor ${stateTone}`}>
                      {healthy || installed
                        ? <CheckCircle2 size={15} className="summary-ok" />
                        : failed || !executorsQuery.isLoading
                          ? <AlertTriangle size={15} className="summary-warn" />
                          : <Loader2 size={15} className="spin" />}
                      <div className="wizard-executor-copy">
                        <div className="wizard-executor-title">
                          <strong>{executor.name}</strong>
                          <span className={`wizard-executor-badge ${healthy || installed ? "ok" : "warn"}`}>
                            {executorStatusLabel(executor, install?.status, healthy)}
                          </span>
                          {id === "native" && <span className="wizard-executor-badge">内置</span>}
                        </div>
                        <span className="wizard-executor-status">{executorDescription(executor, install?.status)}</span>
                        {id !== "native" && install && <ExecutorBootstrapStatus state={install} />}
                        {installed && !healthy && id !== "native" && (
                          <span className="wizard-executor-hint">选择模型后会自动绑定并运行一次真实请求。</span>
                        )}
                      </div>
                      {id !== "native" && (!installed || failed) && !installing && (
                        <button
                          type="button"
                          className="primary-button compact wizard-executor-action"
                          onClick={() => void installExecutor(id)}
                          disabled={busy !== null || installingAny}
                        >
                          <Download size={14} /> {failed ? "重试下载" : "一键下载并检测"}
                        </button>
                      )}
                    </article>
                  );
                })}
              </div>

              {!executorsQuery.isLoading && installedExternalIds.length === 0 && (
                <p className="wizard-note warn">
                  <AlertTriangle size={14} /> 暂未检测到 Codex 或 DeepSeek Harness。可以一键安装，也可以继续使用内置原生执行器。
                </p>
              )}

              <p className="wizard-note">
                托管安装只下载当前缺失的运行时。磁盘占用约 Codex 479 MiB、DeepSeek Harness 505 MiB；本机或应用依赖中已有时不会重复下载。
              </p>

              <div className="wizard-inline-actions">
                <button className="ghost-button" onClick={() => void executorsQuery.refetch()} disabled={executorsQuery.isFetching || installingAny}>
                  {executorsQuery.isFetching ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />} 重新检测
                </button>
              </div>
            </section>
          )}

          {step === 1 && (
            <section className="wizard-panel">
              <h1>选择模型</h1>
              <p className="wizard-note">
                模型保存后会为已检测到的 Codex 和 DeepSeek Harness 自动选择兼容档案，并运行真实请求测试。
              </p>

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

          {step === 2 && (
            <section className="wizard-panel">
              <h1>先跑一个真实任务</h1>
              <p className="wizard-note">
                这一步会用当前执行器绑定的模型，在一个临时文件夹里读写文件并运行测试。跑通才说明代理、工具和测试链路真的可用；不会碰你的项目。
              </p>

              <div className="wizard-summary">
                <SummaryRow ok={configured} label="执行器模型" value={configured ? `${draft.providerName} · ${draft.model}` : "尚未配置"} />
                <SummaryRow ok={nativeReady} label="原生执行器" value={nativeReady ? "已就绪" : "未就绪"} />
                {EXTERNAL_EXECUTOR_IDS.map((id) => {
                  const executor = executors.find((item) => item.id === id);
                  if (!executor || !executorInstalled(executor)) return null;
                  const outcome = bindingOutcomes[id];
                  const ok = outcome?.ok ?? executor.health.canRun;
                  return <SummaryRow key={id} ok={ok} label={executor.name} value={outcome?.ok ? "已绑定并通过真实测试" : outcome?.message ?? "已检测到，等待真实测试"} />;
                })}
                <SummaryRow ok={Boolean(verification?.ok)} label="首次示例" value={verification?.ok ? "已跑通" : skipVerification ? "已跳过" : "未运行"} />
              </div>

              {Object.keys(bindingOutcomes).length > 0 && (
                <div className="wizard-binding-list">
                  {Object.entries(bindingOutcomes).map(([id, outcome]) => outcome && (
                    <div key={id}>
                      {outcome.ok ? <CheckCircle2 size={15} className="summary-ok" /> : <AlertTriangle size={15} className="summary-warn" />}
                      <span>{outcome.message}</span>
                    </div>
                  ))}
                </div>
              )}

              {!configured && (
                <p className="wizard-note warn"><X size={14} /> 还没有可用的执行器模型，可以先跳过，在设置里补上。</p>
              )}

              <div className="wizard-verify">
                <button type="button" className="button" onClick={() => void verify()} disabled={!configured || busy !== null}>
                  {busy === "verify" ? <Loader2 size={15} className="spin" /> : <Sparkles size={15} />}
                  {verification ? "重新跑一次" : "跑一个真实示例"}
                </button>
                {bindingFailures.length > 0 && (
                  <button type="button" className="ghost-button" onClick={() => void retryBindings()} disabled={busy !== null}>
                    {busy === "bind" ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />} 重新绑定并测试执行器
                  </button>
                )}
                {verification && (
                  <div className="wizard-verify-result">
                    {verification.checks.map((check) => (
                      <div key={check.name} className={check.passed ? "summary-ok" : "summary-warn"}>
                        {check.passed ? <CheckCircle2 size={15} /> : <X size={15} />}
                        <strong>{check.name}</strong>
                        <span>{check.detail}</span>
                      </div>
                    ))}
                    {verification.filesChanged.length > 0 && <p className="form-hint">改动文件：{verification.filesChanged.join("、")}</p>}
                  </div>
                )}
                {!verification?.ok && !skipVerification && configured && (
                  <button type="button" className="ghost-button" onClick={() => { setSkipVerification(true); setNotice({ tone: "info", text: "已跳过示例。首次真实任务失败时，先检查模型、执行器和测试命令。" }); }}>
                    跳过验证，直接完成
                  </button>
                )}
              </div>
            </section>
          )}

          {notice && <div className={`settings-notice ${notice.tone}`}>{notice.tone === "ok" ? <CheckCircle2 size={15} /> : notice.tone === "error" ? <X size={15} /> : <KeyRound size={15} />}<span>{notice.text}</span></div>}
        </main>

        <footer className="wizard-footer">
          <button className="ghost-button" onClick={() => setStep((current) => Math.max(0, current - 1))} disabled={step === 0 || busy !== null || installingAny}>
            <ArrowLeft size={14} /> 上一步
          </button>
          <div className="wizard-footer-right">
            <button
              className="primary-button"
              onClick={next}
              disabled={busy !== null || installingAny || (step === 0 && executorsQuery.isLoading) || (step === 1 && !modelReady) || (step === 2 && !verification?.ok && !skipVerification)}
            >
              {busy === "save" || busy === "bind" || busy === "finish" ? <Loader2 size={15} className="spin" /> : null}
              {step === 2 ? "进入 Hearth" : step === 1 ? "保存模型并继续" : "继续选择模型"}
              {step < 2 && <ArrowRight size={14} />}
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

function executorInstalled(executor: ExecutorView): boolean {
  if (executor.id === "native") return true;
  const state = executor.health.installState;
  return state === "available" || state === "needs_repair" || state === "update_available" || Boolean(executor.health.version);
}

function executorStatusLabel(executor: ExecutorView, installStatus: "installing" | "complete" | "error" | undefined, healthy: boolean): string {
  if (installStatus === "installing") return "正在安装";
  if (installStatus === "error") return "安装失败";
  if (installStatus === "complete") return "检测完成";
  if (healthy) return executor.id === "native" ? "内置可用" : "已检测到";
  if (executorInstalled(executor)) return "已检测到";
  return "未检测到";
}

function executorDescription(executor: ExecutorView, installStatus: "installing" | "complete" | "error" | undefined): string {
  if (installStatus === "installing") return "正在下载和验证运行时，进度会实时更新。";
  if (installStatus === "error") return "下载或安装没有完成，可以重试。";
  if (executor.id === "native") return "无需外部依赖，配置模型后即可使用。";
  if (executor.health.canRun) return "真实请求通过，选择模型后即可使用。";
  if (executorInstalled(executor)) return "运行文件已存在，选择模型后自动启用。";
  return executor.health.issues[0] ?? "本机和应用依赖中都没有找到。";
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
