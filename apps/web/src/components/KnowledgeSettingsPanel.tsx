import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, Save } from "lucide-react";
import { api } from "../lib/api.ts";
import type { KnowledgeSettingsPatch, KnowledgeSettingsView, KnowledgeStatusResponse } from "../lib/types.ts";

export function KnowledgeSettingsPanel() {
  const queryClient = useQueryClient();
  const statusQuery = useQuery({ queryKey: ["knowledge"], queryFn: api.knowledgeStatus, refetchInterval: 20_000 });
  const setupQuery = useQuery({ queryKey: ["knowledgeSetup"], queryFn: api.knowledgeSetup, refetchInterval: 5_000 });
  const autoStartRef = useRef(false);
  const [setupBusy, setSetupBusy] = useState<"install" | "start" | "stop" | null>(null);
  const [draft, setDraft] = useState<KnowledgeSettingsView | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState<"save" | "test" | "sync" | "reconcile" | "reindex" | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "error" | "info"; text: string } | null>(null);

  useEffect(() => {
    if (!draft && statusQuery.data) setDraft(statusQuery.data.settings);
  }, [draft, statusQuery.data]);

  const status: KnowledgeStatusResponse | undefined = statusQuery.data;
  const setup = setupQuery.data;
  const enabled = status?.settings.enabled ?? false;
  const healthy = enabled && status?.health.ok === true;

  useEffect(() => {
    if (autoStartRef.current || !setup || !draft) return;
    if (!draft.enabled || !draft.manageProcess || !setup.installed || setup.running) return;
    autoStartRef.current = true;
    setSetupBusy("start");
    void api.startKnowledgeService()
      .catch(() => undefined)
      .finally(() => {
        setSetupBusy(null);
        void setupQuery.refetch();
      });
  }, [setup, draft, setupQuery]);

  async function runSetup(action: "install" | "start" | "stop") {
    setSetupBusy(action);
    setNotice(null);
    try {
      if (action === "install") {
        await api.installKnowledge();
        setNotice({ tone: "info", text: "已开始安装记忆服务，日志会实时显示在下方。" });
      } else if (action === "start") {
        const result = await api.startKnowledgeService();
        setNotice({ tone: result.setup.running ? "ok" : "error", text: result.setup.running ? "记忆服务已启动。" : "服务仍未就绪，请查看日志。" });
      } else {
        await api.stopKnowledgeService();
        setNotice({ tone: "info", text: "已请求停止记忆服务。" });
      }
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "操作失败" });
    } finally {
      setSetupBusy(null);
      void setupQuery.refetch();
    }
  }

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ["knowledge"] });
  }

  async function save() {
    if (!draft) return;
    setBusy("save");
    setNotice(null);
    const patch: KnowledgeSettingsPatch = {
      enabled: draft.enabled,
      baseUrl: draft.baseUrl,
      manageProcess: draft.manageProcess,
      serverCommand: draft.serverCommand,
      serverArgs: draft.serverArgs,
      recall: draft.recall,
      write: draft.write,
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {})
    };
    try {
      await api.saveKnowledgeSettings(patch);
      setApiKey("");
      await refresh();
      setNotice({ tone: "ok", text: "记忆助手设置已保存。" });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "保存失败" });
    } finally {
      setBusy(null);
    }
  }

  async function run(action: "test" | "sync" | "reconcile" | "reindex") {
    setBusy(action);
    setNotice(null);
    try {
      if (action === "test") {
        const result = await api.testKnowledge();
        setNotice({ tone: result.health.ok ? "ok" : "error", text: result.health.ok ? `连接正常 · ${result.health.latencyMs}ms · 命中 ${result.hits} 条` : result.health.detail ?? "连接失败" });
      } else if (action === "sync") {
        const result = await api.syncKnowledge();
        setNotice({ tone: "ok", text: `整理完成：加入 ${result.result.written} 条，跳过 ${result.result.skipped} 条，失败 ${result.result.failed} 条` });
      } else if (action === "reconcile") {
        const result = await api.reconcileKnowledge();
        setNotice({ tone: "ok", text: `整理完成：记忆 ${result.result.memories} 条，任务 ${result.result.tasks} 条，资料 ${result.result.sources} 条` });
      } else {
        const result = await api.reindexKnowledge();
        setNotice({ tone: result.ok ? "ok" : "error", text: result.ok ? "已开始重新整理，稍后完成。" : "重新整理失败" });
      }
      await refresh();
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "操作失败" });
    } finally {
      setBusy(null);
    }
  }

  function patchDraft(patch: Partial<KnowledgeSettingsView>) {
    setDraft((current) => (current ? { ...current, ...patch } : current));
  }

  if (!draft) {
    return (
      <section className="panel settings-section">
        <div className="settings-body">
          <p className="inline-loading"><Loader2 size={15} className="spin" /> 正在读取记忆助手设置</p>
        </div>
      </section>
    );
  }

  return (
    <section className="panel settings-section">
      <div className="settings-body">
        <div className="section-heading">
          <div>
            <h3>记忆助手</h3>
            <p>开启后，聊天和任务会自动参考你记住的内容。关闭后不影响聊天、任务和已有记忆。</p>
          </div>
          <span className={`status-chip ${healthy ? "ok" : "warn"}`}>
            <span className={`status-dot ${healthy ? "online" : "offline"}`} />
            {healthy ? "已开启" : enabled ? "未连接" : "未开启"}
          </span>
        </div>

        {setup && (
          <div className="knowledge-setup">
            <div className="knowledge-setup-head">
              <strong>
                {setup.installed
                  ? enabled
                    ? setup.running ? "记忆助手已开启" : "记忆助手暂时不可用"
                    : "记忆助手已安装，尚未开启"
                  : "记忆助手尚未安装"}
              </strong>
            </div>
            {!setup.installed && (
              <p className="form-hint">
                记忆助手是可选项，不开启也能正常聊天和完成任务。首次准备会下载所需组件，约占 0.8–1 GiB 磁盘空间。
              </p>
            )}
            {!setup.installed && (
              <details className="knowledge-log">
                <summary>高级信息</summary>
                <p className="form-hint">准备命令：<code>{setup.installCommand}</code></p>
              </details>
            )}
            {!setup.installed && !setup.uv && (
              <p className="form-error">缺少准备组件，请先安装 uv（https://docs.astral.sh/uv/）后重新检测。</p>
            )}
            <div className="settings-actions">
              {!setup.installed && (
                <button
                  type="button"
                  className="button primary"
                  onClick={() => void runSetup("install")}
                  disabled={setupBusy !== null || !setup.uv || setup.install.status === "running"}
                >
                  {setupBusy === "install" || setup.install.status === "running" ? <Loader2 size={15} className="spin" /> : null}
                  开启记忆助手
                </button>
              )}
              {setup.installed && !setup.running && (
                <button type="button" className="button primary" onClick={() => void runSetup("start")} disabled={setupBusy !== null}>
                  {setupBusy === "start" ? <Loader2 size={15} className="spin" /> : null} 开启
                </button>
              )}
              {setup.running && setup.managed && (
                <button type="button" className="button" onClick={() => void runSetup("stop")} disabled={setupBusy !== null}>
                  暂停
                </button>
              )}
              <button type="button" className="button" onClick={() => void setupQuery.refetch()} disabled={setupQuery.isFetching}>
                <RefreshCw size={15} /> 重新检测
              </button>
            </div>
            {setup.install.status !== "idle" && (
              <details className="knowledge-log">
                <summary>
                  准备日志 · {setup.install.status === "running" ? "进行中" : setup.install.status === "succeeded" ? "成功" : "失败"}
                </summary>
                <pre>{setup.install.log.slice(-8000) || "（暂无输出）"}</pre>
              </details>
            )}
          </div>
        )}

        {statusQuery.isError && <p className="form-error">{statusQuery.error.message}</p>}
        {notice && (
          <p className={notice.tone === "error" ? "form-error" : "form-hint"}>
            {notice.tone === "ok" ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />} {notice.text}
          </p>
        )}

        <div className="form-grid">
          <label className="checkbox-field span-2">
            <input type="checkbox" checked={draft.enabled} onChange={(event) => patchDraft({ enabled: event.target.checked })} />
            <span>让聊天和任务自动参考记忆</span>
          </label>
          <label>
            <span>把记忆加入自动参考</span>
            <select value={draft.write.memories} onChange={(event) => patchDraft({ write: { ...draft.write, memories: event.target.value as KnowledgeSettingsView["write"]["memories"] } })}>
              <option value="off">关闭</option>
              <option value="curated">只加入精选内容</option>
              <option value="all">加入全部可用内容</option>
            </select>
            <span className="form-hint">希望自动记录的任务经历也能被参考时，选择“加入全部可用内容”。</span>
          </label>
          <label>
            <span>把已完成任务加入自动参考</span>
            <select value={draft.write.tasks} onChange={(event) => patchDraft({ write: { ...draft.write, tasks: event.target.value as KnowledgeSettingsView["write"]["tasks"] } })}>
              <option value="off">关闭</option>
              <option value="completed">仅已完成</option>
              <option value="all">全部已结束的任务</option>
            </select>
          </label>
          <label className="checkbox-field">
            <input type="checkbox" checked={draft.recall.includeResources} onChange={(event) => patchDraft({ recall: { ...draft.recall, includeResources: event.target.checked } })} />
            <span>参考已完成任务和资料</span>
          </label>
          <label className="checkbox-field">
            <input type="checkbox" checked={draft.recall.includeMemories} onChange={(event) => patchDraft({ recall: { ...draft.recall, includeMemories: event.target.checked } })} />
            <span>参考记忆</span>
          </label>
          <label className="checkbox-field">
            <input type="checkbox" checked={draft.write.sources} onChange={(event) => patchDraft({ write: { ...draft.write, sources: event.target.checked } })} />
            <span>把资料正文加入自动参考</span>
          </label>
        </div>

        <details className="knowledge-advanced">
          <summary>高级设置</summary>
          <div className="form-grid">
            <label>
              <span>服务地址（一般不用改）</span>
              <input value={draft.baseUrl} onChange={(event) => patchDraft({ baseUrl: event.target.value })} spellCheck={false} />
            </label>
            <label>
              <span>API Key（可选）</span>
              <input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={draft.apiKeyMasked ?? "开发模式无需填写"} autoComplete="off" />
            </label>
            <label>
              <span>每次最多参考几条</span>
              <input type="number" min={1} max={20} value={draft.recall.maxItems} onChange={(event) => patchDraft({ recall: { ...draft.recall, maxItems: Number(event.target.value) } })} />
            </label>
            <label>
              <span>参考内容长度上限</span>
              <input type="number" min={200} max={4000} value={draft.recall.maxTokens} onChange={(event) => patchDraft({ recall: { ...draft.recall, maxTokens: Number(event.target.value) } })} />
            </label>
            <label>
              <span>最长等待时间（毫秒）</span>
              <input type="number" min={500} max={10000} value={draft.recall.timeoutMs} onChange={(event) => patchDraft({ recall: { ...draft.recall, timeoutMs: Number(event.target.value) } })} />
            </label>
            <label>
              <span>只使用更相关的内容（0–1，留空不限）</span>
              <input
                type="number" min={0} max={1} step={0.01}
                value={draft.recall.minScore ?? ""}
                onChange={(event) => patchDraft({ recall: { ...draft.recall, minScore: event.target.value === "" ? null : Number(event.target.value) } })}
              />
            </label>
            <label>
              <span>每晚自动整理</span>
              <input value={draft.write.reindexCron} onChange={(event) => patchDraft({ write: { ...draft.write, reindexCron: event.target.value } })} spellCheck={false} />
            </label>
          </div>
        </details>

        <div className="settings-actions">
          <button type="button" className="button primary" onClick={() => void save()} disabled={busy !== null}>
            {busy === "save" ? <Loader2 size={15} className="spin" /> : <Save size={15} />} 保存
          </button>
        </div>

        <details className="knowledge-advanced">
          <summary>检查与维护</summary>
          <div className="settings-actions">
            <button type="button" className="button" onClick={() => void run("test")} disabled={busy !== null}>
              {busy === "test" ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />} 检查记忆助手
            </button>
            <button type="button" className="button" onClick={() => void run("sync")} disabled={busy !== null}>整理新内容</button>
            <button type="button" className="button" onClick={() => void run("reconcile")} disabled={busy !== null}>全部重新整理</button>
            <button type="button" className="button" onClick={() => void run("reindex")} disabled={busy !== null}>重新整理查找内容</button>
          </div>
          <div className="metric-grid">
            <Metric label="等待整理" value={status?.jobs.pending ?? 0} />
            <Metric label="正在整理" value={status?.jobs.running ?? 0} />
            <Metric label="稍后重试" value={status?.jobs.failed ?? 0} />
            <Metric label="多次失败" value={status?.jobs.dead ?? 0} {...(status?.jobs.dead ? { tone: "warn" as const } : {})} />
          </div>
          <p className="form-hint">
            上次整理：{status?.lastReconcileAt ?? "未执行"} ｜ 上次重建：{status?.lastReindexDate ?? "未执行"}
            {status?.health.detail ? ` ｜ ${status.health.detail}` : ""}
          </p>
        </details>
      </div>
    </section>
  );
}

function Metric({ label, value, tone }: { label: string; value: number; tone?: "warn" }) {
  return (
    <div className={`metric-card ${tone === "warn" ? "warn" : ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
