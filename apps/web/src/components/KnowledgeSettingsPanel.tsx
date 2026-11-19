import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, Save } from "lucide-react";
import { api } from "../lib/api.ts";
import type { KnowledgeSettingsPatch, KnowledgeSettingsView, KnowledgeStatusResponse } from "../lib/types.ts";

export function KnowledgeSettingsPanel() {
  const queryClient = useQueryClient();
  const statusQuery = useQuery({ queryKey: ["knowledge"], queryFn: api.knowledgeStatus, refetchInterval: 20_000 });
  const [draft, setDraft] = useState<KnowledgeSettingsView | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState<"save" | "test" | "sync" | "reconcile" | "reindex" | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "error" | "info"; text: string } | null>(null);

  useEffect(() => {
    if (!draft && statusQuery.data) setDraft(statusQuery.data.settings);
  }, [draft, statusQuery.data]);

  const status: KnowledgeStatusResponse | undefined = statusQuery.data;

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
      setNotice({ tone: "ok", text: "知识库设置已保存。" });
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
        setNotice({ tone: "ok", text: `同步完成：写入 ${result.result.written}，失败 ${result.result.failed}，跳过 ${result.result.skipped}` });
      } else if (action === "reconcile") {
        const result = await api.reconcileKnowledge();
        setNotice({ tone: "ok", text: `对账完成：记忆 ${result.result.memories}，任务 ${result.result.tasks}，来源 ${result.result.sources}` });
      } else {
        const result = await api.reindexKnowledge();
        setNotice({ tone: result.ok ? "ok" : "error", text: result.ok ? "已提交重建索引（后台执行）" : "重建索引失败" });
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
          <p className="inline-loading"><Loader2 size={15} className="spin" /> 正在读取知识库设置</p>
        </div>
      </section>
    );
  }

  return (
    <section className="panel settings-section">
      <div className="settings-body">
        <div className="section-heading">
          <div>
            <h3>知识库（OpenViking）</h3>
            <p>Hearth 持有唯一写权威，OpenViking 只是可重建的语义索引。关闭后不召回、不写回，任务照常运行。</p>
          </div>
          <span className={`status-chip ${status?.health.ok ? "ok" : "warn"}`}>
            <span className={`status-dot ${status?.health.ok ? "online" : "offline"}`} />
            {status?.health.ok ? `在线 · ${status.health.version ?? ""}` : "未连接"}
          </span>
        </div>

        {statusQuery.isError && <p className="form-error">{statusQuery.error.message}</p>}
        {notice && (
          <p className={notice.tone === "error" ? "form-error" : "form-hint"}>
            {notice.tone === "ok" ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />} {notice.text}
          </p>
        )}

        <div className="form-grid">
          <label className="checkbox-field span-2">
            <input type="checkbox" checked={draft.enabled} onChange={(event) => patchDraft({ enabled: event.target.checked })} />
            <span>启用语义检索与写回（需要本机 OpenViking 服务）</span>
          </label>
          <label>
            <span>服务地址</span>
            <input value={draft.baseUrl} onChange={(event) => patchDraft({ baseUrl: event.target.value })} spellCheck={false} />
          </label>
          <label>
            <span>API Key（可选）</span>
            <input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={draft.apiKeyMasked ?? "开发模式无需填写"} autoComplete="off" />
          </label>
          <label>
            <span>召回条目上限</span>
            <input type="number" min={1} max={20} value={draft.recall.maxItems} onChange={(event) => patchDraft({ recall: { ...draft.recall, maxItems: Number(event.target.value) } })} />
          </label>
          <label>
            <span>召回 token 预算</span>
            <input type="number" min={200} max={4000} value={draft.recall.maxTokens} onChange={(event) => patchDraft({ recall: { ...draft.recall, maxTokens: Number(event.target.value) } })} />
          </label>
          <label>
            <span>超时（毫秒）</span>
            <input type="number" min={500} max={10000} value={draft.recall.timeoutMs} onChange={(event) => patchDraft({ recall: { ...draft.recall, timeoutMs: Number(event.target.value) } })} />
          </label>
          <label>
            <span>最低相关度（0–1，留空不过滤）</span>
            <input
              type="number" min={0} max={1} step={0.01}
              value={draft.recall.minScore ?? ""}
              onChange={(event) => patchDraft({ recall: { ...draft.recall, minScore: event.target.value === "" ? null : Number(event.target.value) } })}
            />
          </label>
          <label className="checkbox-field">
            <input type="checkbox" checked={draft.recall.includeResources} onChange={(event) => patchDraft({ recall: { ...draft.recall, includeResources: event.target.checked } })} />
            <span>检索资源（项目/任务/来源）</span>
          </label>
          <label className="checkbox-field">
            <input type="checkbox" checked={draft.recall.includeMemories} onChange={(event) => patchDraft({ recall: { ...draft.recall, includeMemories: event.target.checked } })} />
            <span>检索记忆</span>
          </label>
          <label>
            <span>记忆写回</span>
            <select value={draft.write.memories} onChange={(event) => patchDraft({ write: { ...draft.write, memories: event.target.value as KnowledgeSettingsView["write"]["memories"] } })}>
              <option value="off">关闭</option>
              <option value="curated">仅 curated/instructions</option>
              <option value="all">全部干净记忆</option>
            </select>
          </label>
          <label>
            <span>任务写回</span>
            <select value={draft.write.tasks} onChange={(event) => patchDraft({ write: { ...draft.write, tasks: event.target.value as KnowledgeSettingsView["write"]["tasks"] } })}>
              <option value="off">关闭</option>
              <option value="completed">仅已完成</option>
              <option value="all">全部终态</option>
            </select>
          </label>
          <label className="checkbox-field">
            <input type="checkbox" checked={draft.write.sources} onChange={(event) => patchDraft({ write: { ...draft.write, sources: event.target.checked } })} />
            <span>来源正文写回</span>
          </label>
          <label>
            <span>夜间重建索引（cron）</span>
            <input value={draft.write.reindexCron} onChange={(event) => patchDraft({ write: { ...draft.write, reindexCron: event.target.value } })} spellCheck={false} />
          </label>
        </div>

        <div className="settings-actions">
          <button type="button" className="button primary" onClick={() => void save()} disabled={busy !== null}>
            {busy === "save" ? <Loader2 size={15} className="spin" /> : <Save size={15} />} 保存
          </button>
          <button type="button" className="button" onClick={() => void run("test")} disabled={busy !== null}>
            {busy === "test" ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />} 测试连接
          </button>
          <button type="button" className="button" onClick={() => void run("sync")} disabled={busy !== null}>立即同步</button>
          <button type="button" className="button" onClick={() => void run("reconcile")} disabled={busy !== null}>全量对账</button>
          <button type="button" className="button" onClick={() => void run("reindex")} disabled={busy !== null}>重建索引</button>
        </div>

        <div className="metric-grid">
          <Metric label="待同步" value={status?.jobs.pending ?? 0} />
          <Metric label="执行中" value={status?.jobs.running ?? 0} />
          <Metric label="失败待重试" value={status?.jobs.failed ?? 0} />
          <Metric label="死信" value={status?.jobs.dead ?? 0} {...(status?.jobs.dead ? { tone: "warn" as const } : {})} />
        </div>
        <p className="form-hint">
          上次对账：{status?.lastReconcileAt ?? "未执行"} ｜ 上次重建索引：{status?.lastReindexDate ?? "未执行"}
          {status?.health.detail ? ` ｜ ${status.health.detail}` : ""}
        </p>
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
