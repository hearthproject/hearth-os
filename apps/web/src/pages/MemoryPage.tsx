import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  BookOpen,
  Check,
  CheckCircle2,
  Database,
  Download,
  EyeOff,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Search,
  Settings2,
  ShieldAlert,
  Trash2
} from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api.ts";
import { formatDate, formatNumber, relativeTime } from "../lib/format.ts";
import type {
  CorrectMemoryRequest,
  CreateMemoryRequest,
  KnowledgeHit,
  KnowledgeSetupState,
  KnowledgeStatusResponse,
  MemoryConflict,
  MemoryKind,
  MemoryRecord,
  MemorySnapshot
} from "../lib/types.ts";

const KIND_LABELS: Record<MemoryKind, string> = {
  fact: "事实",
  preference: "偏好",
  project: "项目",
  commitment: "承诺",
  experience: "经历",
  method: "方法"
};

const STATUS_LABELS: Record<MemoryRecord["status"], string> = {
  candidate: "待确认",
  active: "已启用",
  conflict: "冲突",
  forgotten: "已遗忘",
  superseded: "已替代"
};

const SENSITIVITY_LABELS: Record<MemoryRecord["sensitivity"], string> = {
  normal: "普通",
  sensitive: "敏感",
  secret: "机密"
};

const CONFIDENCE_LABELS: Record<MemoryRecord["confidence"], string> = {
  low: "低",
  medium: "中",
  high: "高"
};

const CONTEXT_LABELS: Record<KnowledgeHit["contextType"], string> = {
  memory: "记忆",
  resource: "资料",
  skill: "技能",
  unknown: "知识"
};

const FORGET_TARGET_LABELS = {
  projection: "当前记录",
  versions: "历史版本",
  "event-log": "事件日志",
  "recall-audit": "召回审计",
  devices: "设备副本",
  derivations: "派生记忆",
  consolidation: "巩固报告"
} as const;

type MemoryFilter = "active" | "candidate" | "all";
type MemoryWriteMode = "off" | "curated" | "all";
type Notice = { tone: "ok" | "error" | "info"; text: string };

export function MemoryPage() {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<MemoryFilter>("active");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [creating, setCreating] = useState(false);
  const [searchText, setSearchText] = useState("");
  const [searchResults, setSearchResults] = useState<KnowledgeHit[] | null>(null);
  const [showEvaluation, setShowEvaluation] = useState(false);
  const [knowledgeBusy, setKnowledgeBusy] = useState<"enable" | "start" | "test" | "sync" | "write" | null>(null);

  const snapshotQuery = useQuery({ queryKey: ["memory"], queryFn: api.memory, refetchInterval: 20_000 });
  const knowledgeQuery = useQuery({ queryKey: ["knowledge"], queryFn: api.knowledgeStatus, refetchInterval: 20_000 });
  const setupQuery = useQuery({ queryKey: ["knowledgeSetup"], queryFn: api.knowledgeSetup, refetchInterval: 10_000 });

  const refreshAll = () => {
    void queryClient.invalidateQueries({ queryKey: ["memory"] });
    void queryClient.invalidateQueries({ queryKey: ["knowledge"] });
    void queryClient.invalidateQueries({ queryKey: ["knowledgeSetup"] });
  };

  const actionMutation = useMutation({
    mutationFn: async (input: { action: string; id: string; payload?: unknown }) => {
      if (input.action === "confirm") return api.confirmMemory(input.id);
      if (input.action === "forget") return api.forgetMemory(input.id);
      if (input.action === "correct") return api.correctMemory(input.id, input.payload as CorrectMemoryRequest);
      if (input.action === "sensitive") return api.markMemorySensitive(input.id, "sensitive", false);
      if (input.action === "unsensitive") return api.markMemorySensitive(input.id, "normal", true);
      return api.resolveMemoryConflict(input.id, input.payload as { resolution: "keep_left" | "keep_right" | "merged"; note?: string; content?: string });
    },
    onSuccess: (_result, input) => {
      setNotice({ tone: "ok", text: actionNotice(input.action) });
      refreshAll();
    },
    onError: (error: Error) => setNotice({ tone: "error", text: error.message })
  });

  const searchMutation = useMutation({
    mutationFn: (query: string) => api.knowledgeSearch(query),
    onSuccess: (data) => setSearchResults(data.hits),
    onError: (error: Error) => {
      setSearchResults([]);
      setNotice({ tone: "error", text: error.message });
    }
  });

  const snapshot = snapshotQuery.data;
  const status = knowledgeQuery.data;
  const setup = setupQuery.data;
  const enabled = status?.settings.enabled ?? false;
  const connected = enabled && status?.health.ok === true;
  const writeMode: MemoryWriteMode = status?.settings.write.memories ?? "curated";
  const allMemories = snapshot?.memories ?? [];
  const evaluationCount = allMemories.filter(isEvaluationMemory).length;
  const visibleMemories = showEvaluation ? allMemories : allMemories.filter((memory) => !isEvaluationMemory(memory));
  const indexable = allMemories.filter(isIndexable);
  const eligible = {
    curated: indexable.filter((memory) => ["instructions", "curated"].includes(memory.tier)).length,
    all: indexable.length
  };
  const counts = {
    active: visibleMemories.filter((memory) => memory.status === "active").length,
    candidate: visibleMemories.filter((memory) => memory.status === "candidate").length,
    all: visibleMemories.length
  };
  const memories = visibleMemories.filter((memory) => filter === "all" || memory.status === filter);
  const pendingConflicts = snapshot?.conflicts.filter((item) => item.status === "pending") ?? [];
  function runKnowledgeAction(action: "test" | "sync") {
    setKnowledgeBusy(action);
    setNotice(null);
    const task = action === "test"
      ? api.testKnowledge()
      : api.reconcileKnowledge().then(async (reconciled) => ({
          result: reconciled.result,
          flushed: (await api.syncKnowledge()).result
        }));
    task
      .then((result) => {
        if (action === "test") {
          const tested = result as Awaited<ReturnType<typeof api.testKnowledge>>;
          setNotice({
            tone: tested.health.ok ? "ok" : "error",
            text: tested.health.ok
              ? `OpenViking 连接正常 · ${tested.health.latencyMs}ms · 命中 ${tested.hits} 条`
              : tested.health.detail ?? "连接失败"
          });
        } else {
          const synced = result as Awaited<ReturnType<typeof api.reconcileKnowledge>> & {
            flushed: Awaited<ReturnType<typeof api.syncKnowledge>>["result"];
          };
          setNotice({
            tone: "ok",
            text: `同步完成：对账记忆 ${synced.result.memories} 条、任务 ${synced.result.tasks} 条、来源 ${synced.result.sources} 条；写入 ${synced.flushed.written}，失败 ${synced.flushed.failed}，跳过 ${synced.flushed.skipped}`
          });
        }
        refreshAll();
      })
      .catch((error: Error) => setNotice({ tone: "error", text: error.message }))
      .finally(() => setKnowledgeBusy(null));
  }

  function enableKnowledge() {
    setKnowledgeBusy("enable");
    setNotice(null);
    if (setup && !setup.installed) {
      setNotice({ tone: "info", text: "还没有检测到 OpenViking。请先在 设置 → 知识库连接 中安装。" });
      setKnowledgeBusy(null);
      return;
    }
    api
      .saveKnowledgeSettings({ enabled: true })
      .then(async () => {
        if (setup?.installed && !setup.running) await api.startKnowledgeService();
        const reconciled = await api.reconcileKnowledge();
        setNotice({
          tone: "ok",
          text: writeMode === "all"
            ? `OpenViking 已启用，已对账 ${reconciled.result.memories} 条记忆；评测经历已排除。`
            : eligible.curated === 0 && eligible.all > 0
              ? `OpenViking 已启用。精选范围目前 0 条；把上方范围改为“全部干净记忆”，即可索引 ${eligible.all} 条任务经历。`
              : `OpenViking 已启用，已对账 ${reconciled.result.memories} 条精选记忆。`
        });
        refreshAll();
      })
      .catch((error: Error) => setNotice({ tone: "error", text: error.message }))
      .finally(() => setKnowledgeBusy(null));
  }

  function startKnowledge() {
    setKnowledgeBusy("start");
    setNotice(null);
    api
      .startKnowledgeService()
      .then((result) => {
        setNotice({
          tone: result.setup.running ? "ok" : "error",
          text: result.setup.running ? "OpenViking 服务已启动。" : "服务仍未就绪，请查看设置中的安装日志。"
        });
        refreshAll();
      })
      .catch((error: Error) => setNotice({ tone: "error", text: error.message }))
      .finally(() => setKnowledgeBusy(null));
  }

  function setMemoryWriteMode(mode: MemoryWriteMode) {
    setKnowledgeBusy("write");
    setNotice(null);
    api
      .saveKnowledgeSettings({ write: { memories: mode } })
      .then(async () => {
        if (mode === "off") {
          setNotice({ tone: "info", text: "已停止写入新记忆；OpenViking 中已有的索引不会自动删除。" });
        } else {
          const result = await api.reconcileKnowledge();
          setNotice({
            tone: "ok",
            text: `索引范围已更新；对账记忆 ${result.result.memories} 条、任务 ${result.result.tasks} 条、来源 ${result.result.sources} 条。`
          });
        }
        refreshAll();
      })
      .catch((error: Error) => setNotice({ tone: "error", text: error.message }))
      .finally(() => setKnowledgeBusy(null));
  }

  function createMemory(input: CreateMemoryRequest) {
    api
      .createMemory(input)
      .then(() => {
        setNotice({ tone: "ok", text: "已加入待确认。确认后才会被召回和写入索引。" });
        setCreating(false);
        refreshAll();
      })
      .catch((error: Error) => setNotice({ tone: "error", text: error.message }));
  }

  function saveMemorySettings(input: Partial<MemorySnapshot["settings"]>, done: () => void) {
    api
      .updateMemorySettings(input)
      .then(() => {
        setNotice({ tone: "ok", text: "记忆设置已保存。" });
        refreshAll();
        done();
      })
      .catch((error: Error) => {
        setNotice({ tone: "error", text: error.message });
        done();
      });
  }

  function search() {
    const query = searchText.trim();
    if (!query || !connected) return;
    setSearchResults(null);
    searchMutation.mutate(query);
  }

  return (
    <div className="page workbench-page memory-page">
      <div className="page-head memory-page-head">
        <div>
          <h1>知识库</h1>
          <p className="page-meta">Hearth 决定记住什么，OpenViking 把这些内容变成可搜索的语义索引。</p>
        </div>
        <div className="page-actions">
          <button className="ghost-button" onClick={api.exportMemories}><Download size={15} /> 导出</button>
          <Link className="ghost-button" to="/settings?tab=knowledge"><Settings2 size={15} /> 连接设置</Link>
        </div>
      </div>

      {notice && (
        <div className={`memory-notice ${notice.tone}`}>
          {notice.tone === "ok" ? <CheckCircle2 size={15} /> : notice.tone === "error" ? <AlertTriangle size={15} /> : <Database size={15} />}
          <span>{notice.text}</span>
          <button type="button" className="icon-button" onClick={() => setNotice(null)} aria-label="关闭提示">×</button>
        </div>
      )}

      {snapshotQuery.isLoading && <p className="section-empty">正在读取记忆…</p>}
      {snapshotQuery.isError && <p className="form-error">{snapshotQuery.error.message}</p>}

      <KnowledgeOverview
        status={status}
        setup={setup}
        eligible={eligible}
        busy={knowledgeBusy}
        onEnable={enableKnowledge}
        onStart={startKnowledge}
        onTest={() => runKnowledgeAction("test")}
        onSync={() => runKnowledgeAction("sync")}
        onMemoryWriteMode={setMemoryWriteMode}
      />

      <KnowledgeSearchPanel
        connected={connected}
        query={searchText}
        setQuery={setSearchText}
        pending={searchMutation.isPending}
        results={searchResults}
        onSearch={search}
      />

      {snapshot && pendingConflicts.length > 0 && (
        <section className="panel memory-conflicts">
          <div className="panel-head"><h2>需要解决的冲突</h2><span className="panel-meta">{pendingConflicts.length} 条</span></div>
          {pendingConflicts.map((conflict) => (
            <ConflictCard
              key={conflict.id}
              conflict={conflict}
              memories={snapshot.memories}
              busy={actionMutation.isPending}
              onResolve={(input) => actionMutation.mutate({ action: "resolve", id: conflict.id, payload: input })}
            />
          ))}
        </section>
      )}

      {snapshot && (
        <section className="memory-section">
          <div className="memory-section-head">
            <div>
              <h2><BookOpen size={16} /> 记忆</h2>
              <p>自动记录的任务经历，以及你手动添加的长期背景。</p>
            </div>
            <div className="memory-section-actions">
              <span className="page-meta">召回 {snapshot.settings.maxItems} 条 / {formatNumber(snapshot.settings.maxChars)} 字符</span>
              <button type="button" className="ghost-button compact" onClick={() => setCreating((current) => !current)}>
                <Plus size={15} /> 手动添加
              </button>
            </div>
          </div>

          {creating && <MemoryCreateForm onCreate={createMemory} onCancel={() => setCreating(false)} />}

          <div className="inbox-toolbar memory-toolbar">
            <div className="segmented">
              <button className={filter === "active" ? "active" : ""} onClick={() => setFilter("active")}>已启用 {formatNumber(counts.active)}</button>
              <button className={filter === "candidate" ? "active" : ""} onClick={() => setFilter("candidate")}>待确认 {formatNumber(counts.candidate)}</button>
              <button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>全部 {formatNumber(counts.all)}</button>
            </div>
            {evaluationCount > 0 && (
              <label className="memory-check">
                <input type="checkbox" checked={showEvaluation} onChange={(event) => setShowEvaluation(event.target.checked)} />
                显示评测经历 {formatNumber(evaluationCount)}
              </label>
            )}
          </div>

          {actionMutation.error && <p className="form-error">{actionMutation.error.message}</p>}

          {memories.length === 0 ? (
            <p className="section-empty">{filter === "candidate" ? "没有待确认的记忆。" : filter === "active" ? "还没有已启用的真实工作记忆。" : "这里还没有记忆。"}{!showEvaluation && evaluationCount > 0 ? " 评测经历默认隐藏，可勾选右上角查看。" : ""}</p>
          ) : (
            <div className="memory-list">
              {memories.map((memory) => (
                <MemoryCard
                  key={memory.id}
                  memory={memory}
                  busy={actionMutation.isPending}
                  knowledgeEnabled={enabled}
                  writeMode={writeMode}
                  onAction={(action, payload) => actionMutation.mutate({ action, id: memory.id, payload })}
                />
              ))}
            </div>
          )}

          <details className="memory-fold">
            <summary>自动记录与召回预算</summary>
            <MemorySettingsPanel key={snapshot.settings.updatedAt} settings={snapshot.settings} onSave={saveMemorySettings} />
          </details>

          <details className="memory-fold">
            <summary>最近召回记录</summary>
            {(snapshot.recalls ?? []).slice(0, 8).map((recall) => {
              const memory = snapshot.memories.find((item) => item.id === recall.memoryId);
              const chatRecall = recall.taskId.startsWith("chat:");
              return (
                <div className="memory-recall-row" key={recall.id}>
                  <div><strong>{memory ? KIND_LABELS[memory.kind] + " · " + truncate(memory.content, 90) : "已删除记忆"}</strong><span>{recall.reason}</span></div>
                  <Link to={chatRecall ? "/" : "/tasks/" + recall.taskId}>{chatRecall ? "对话 · " : ""}{formatDate(recall.createdAt)}</Link>
                </div>
              );
            })}
            {(snapshot.recalls ?? []).length === 0 && <p className="section-empty">还没有召回记录。</p>}
          </details>

          <details className="memory-fold">
            <summary>遗忘回执</summary>
            {(snapshot.forgets ?? []).slice(0, 8).map((receipt) => (
              <div className="memory-forget-row" key={receipt.id}>
                <div>
                  <strong>{receipt.reason}</strong>
                  <span>{truncate(receipt.memoryId, 18)} · 脱敏 {receipt.redactedVersions} 个版本 / {receipt.redactedEvents} 个事件 · {formatDate(receipt.createdAt)}</span>
                </div>
                <div className="memory-forget-targets">
                  {receipt.targets.map((target) => (
                    <span className={"tag forget-" + target.status} key={target.target} title={target.detail}>
                      {FORGET_TARGET_LABELS[target.target]} · {target.status === "complete" ? "完成" : "待完成"}
                    </span>
                  ))}
                </div>
              </div>
            ))}
            {(snapshot.forgets ?? []).length === 0 && <p className="section-empty">还没有遗忘回执。</p>}
          </details>
        </section>
      )}
    </div>
  );
}

function KnowledgeOverview({
  status,
  setup,
  eligible,
  busy,
  onEnable,
  onStart,
  onTest,
  onSync,
  onMemoryWriteMode
}: {
  status: KnowledgeStatusResponse | undefined;
  setup: KnowledgeSetupState | undefined;
  eligible: { curated: number; all: number };
  busy: "enable" | "start" | "test" | "sync" | "write" | null;
  onEnable: () => void;
  onStart: () => void;
  onTest: () => void;
  onSync: () => void;
  onMemoryWriteMode: (mode: MemoryWriteMode) => void;
}) {
  const settings = status?.settings;
  const enabled = settings?.enabled ?? false;
  const connected = enabled && status?.health.ok === true;
  const index = status?.index;
  const pending = (status?.jobs.pending ?? 0) + (status?.jobs.running ?? 0);
  const writeMode = settings?.write.memories ?? "curated";

  return (
    <section className="knowledge-overview">
      <div className="knowledge-overview-head">
        <span className="knowledge-mark"><Database size={20} /></span>
        <div className="knowledge-overview-copy">
          <div className="knowledge-title-row">
            <h2>OpenViking 语义索引</h2>
            <span className={`status-chip ${connected ? "ok" : enabled ? "warn" : ""}`}>
              <span className={`status-dot ${connected ? "online" : "idle"}`} />
              {connected ? "已连接" : enabled ? "已启用 · 未连接" : "未启用"}
            </span>
          </div>
          <p>
            {connected
              ? "任务和对话会检索这里的记忆、已完成任务与来源；索引可以随时重建。"
              : "启用后，Hearth 会把符合条件的记忆写入本地 OpenViking，供任务和对话做语义检索。"}
          </p>
          <div className="knowledge-facts">
            <span>{settings?.baseUrl ?? "http://127.0.0.1:1933"}</span>
            {status?.health.version && <span>v{status.health.version}</span>}
            {connected && <span>{status.health.latencyMs}ms</span>}
            <span>{serviceLabel(setup, enabled, connected)}</span>
            {index?.lastIndexedAt && <span>最近写入 {relativeTime(index.lastIndexedAt)}</span>}
          </div>
        </div>
        <div className="knowledge-actions">
          {!enabled && setup?.installed && (
            <button type="button" className="primary-button" onClick={onEnable} disabled={busy !== null}>
              {busy === "enable" ? <Loader2 size={15} className="spin" /> : <Database size={15} />} 启用索引
            </button>
          )}
          {!enabled && setup && !setup.installed && (
            <Link className="primary-button" to="/settings?tab=knowledge">安装 OpenViking</Link>
          )}
          {!enabled && !setup && (
            <button type="button" className="primary-button" onClick={onEnable} disabled={busy !== null}>启用索引</button>
          )}
          {enabled && !connected && setup?.installed && (
            <button type="button" className="primary-button" onClick={onStart} disabled={busy !== null}>
              {busy === "start" ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />} 启动服务
            </button>
          )}
          {enabled && !connected && setup && !setup.installed && (
            <Link className="primary-button" to="/settings?tab=knowledge">安装 OpenViking</Link>
          )}
          {enabled && (
            <button type="button" className="ghost-button" onClick={onTest} disabled={busy !== null}>
              {busy === "test" ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />} 测试连接
            </button>
          )}
          <Link className="ghost-button" to="/settings?tab=knowledge"><Settings2 size={15} /> 连接设置</Link>
        </div>
      </div>

      <div className="knowledge-stats">
        <KnowledgeStat label="已索引记忆" value={index?.memories ?? 0} />
        <KnowledgeStat label="已索引任务" value={index?.tasks ?? 0} />
        <KnowledgeStat label="已索引来源" value={index?.sources ?? 0} />
        <KnowledgeStat label="待同步" value={pending} tone={pending > 0 ? "warn" : undefined} />
      </div>

      <div className="knowledge-write-row">
        <label>
          <span>记忆索引范围</span>
          <select
            value={writeMode}
            onChange={(event) => onMemoryWriteMode(event.target.value as MemoryWriteMode)}
            disabled={busy !== null || !enabled}
          >
            <option value="curated">仅精选记忆</option>
            <option value="all">全部干净记忆</option>
            <option value="off">不写入</option>
          </select>
        </label>
        <span className="knowledge-write-note">
          {writeMode === "curated"
            ? eligible.all === 0
              ? "当前没有可索引的真实工作记忆。"
              : eligible.curated === 0
                ? `精选范围目前 0 条；你还有 ${eligible.all} 条真实任务经历，改为“全部干净记忆”即可写入。`
                : `精选范围 ${eligible.curated} 条；另有 ${eligible.all - eligible.curated} 条任务经历不会写入。`
            : writeMode === "all"
              ? `将写入 ${eligible.all} 条真实工作记忆；评测与基准经历始终排除。`
              : "只保留已有索引，不再写入新记忆。"}
        </span>
        {connected && (
          <button type="button" className="ghost-button compact" onClick={onSync} disabled={busy !== null}>
            {busy === "sync" ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />} 立即同步{pending > 0 ? ` ${pending}` : ""}
          </button>
        )}
      </div>

      {setup?.install.status === "running" && (
        <p className="knowledge-progress"><Loader2 size={15} className="spin" /> 正在安装 OpenViking，日志可在设置中查看。</p>
      )}
      {enabled && !connected && status?.health.detail && (
        <p className="knowledge-error" title={status.health.detail}>连接失败：{status.health.detail}</p>
      )}
    </section>
  );
}

function KnowledgeStat({ label, value, tone }: { label: string; value: number; tone?: "warn" | undefined }) {
  return (
    <div className={`knowledge-stat${tone === "warn" ? " warn" : ""}`}>
      <span>{label}</span>
      <strong>{formatNumber(value)}</strong>
    </div>
  );
}

function KnowledgeSearchPanel({
  connected,
  query,
  setQuery,
  pending,
  results,
  onSearch
}: {
  connected: boolean;
  query: string;
  setQuery: (value: string) => void;
  pending: boolean;
  results: KnowledgeHit[] | null;
  onSearch: () => void;
}) {
  return (
    <section className="knowledge-search">
      <div className="knowledge-search-head">
        <div>
          <h2>搜索知识</h2>
          <p>用自然语言搜索记忆、已完成任务和来源正文。</p>
        </div>
        {!connected && <span className="page-meta">OpenViking 连接后可用</span>}
      </div>
      <form className="knowledge-search-form" onSubmit={(event) => { event.preventDefault(); onSearch(); }}>
        <label className="knowledge-search-input">
          <Search size={15} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="例如：上次 PR 审查的结论 / 我的发布流程 / 写作偏好"
            disabled={!connected}
          />
        </label>
        <button className="primary-button" type="submit" disabled={!connected || !query.trim() || pending}>
          {pending ? <Loader2 size={15} className="spin" /> : <Search size={15} />} 搜索
        </button>
      </form>
      {pending && <p className="section-empty">正在检索 OpenViking…</p>}
      {!pending && results && results.length === 0 && <p className="section-empty">没有命中。换一个更具体的说法，或先同步索引。</p>}
      {!pending && results && results.length > 0 && (
        <div className="knowledge-results">
          {results.map((hit) => <KnowledgeHitRow key={hit.uri} hit={hit} />)}
        </div>
      )}
    </section>
  );
}

function KnowledgeHitRow({ hit }: { hit: KnowledgeHit }) {
  return (
    <article className="knowledge-hit">
      <div className="knowledge-hit-head">
        <span className="tag">{CONTEXT_LABELS[hit.contextType]}</span>
        <strong title={hit.uri}>{hitTitle(hit)}</strong>
        <span className="knowledge-score">{scoreLabel(hit.score)}</span>
      </div>
      <p>{hit.abstract || "OpenViking 没有返回摘要，可到设置中按 URI 读取原文。"}</p>
      <code>{hit.uri}</code>
    </article>
  );
}

function MemoryCreateForm({ onCreate, onCancel }: { onCreate: (input: CreateMemoryRequest) => void; onCancel: () => void }) {
  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const kind = String(form.get("kind")) as MemoryKind;
    const content = String(form.get("content") || "").trim();
    if (!content) return;
    const subjectKey = String(form.get("subjectKey") || "").trim() || `${kind}.${Date.now().toString(36)}`;
    onCreate({
      kind,
      content,
      subjectKey,
      scope: String(form.get("scope") || "global").trim() || "global",
      tags: [],
      confidence: "medium",
      sensitivity: "normal",
      allowRecall: true,
      source: { type: "user", id: null, label: "用户手动创建", excerpt: null }
    });
  }
  return (
    <form className="memory-create-form" onSubmit={submit}>
      <div className="memory-create-grid">
        <label>类型<select name="kind" defaultValue="preference">{Object.entries(KIND_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label>适用范围<input name="scope" defaultValue="global" placeholder="global 或项目名" maxLength={120} /></label>
      </div>
      <label className="memory-content-field">想让它记住什么<textarea name="content" required maxLength={8000} rows={3} placeholder="用一句完整的话写清楚，例如：我偏好先给结论，再给依据。" /></label>
      <details className="memory-create-advanced">
        <summary>高级：主题键</summary>
        <label>主题键<input name="subjectKey" placeholder="preference.output-style（留空会自动生成）" maxLength={200} /></label>
        <p className="form-hint">同一主题的新内容会提示冲突，便于你选择保留哪一条。</p>
      </details>
      <div className="proactive-form-foot">
        <span className="form-hint">创建后先进入“待确认”，确认后才会被召回和写入索引。</span>
        <div className="memory-form-actions">
          <button type="button" className="ghost-button" onClick={onCancel}>取消</button>
          <button type="submit" className="primary-button"><Check size={15} /> 加入待确认</button>
        </div>
      </div>
    </form>
  );
}

function MemorySettingsPanel({ settings, onSave }: { settings: MemorySnapshot["settings"]; onSave: (input: Partial<MemorySnapshot["settings"]>, done: () => void) => void }) {
  const [saving, setSaving] = useState(false);
  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setSaving(true);
    onSave({
      autoCapture: String(form.get("autoCapture")) as MemorySnapshot["settings"]["autoCapture"],
      maxItems: Number(form.get("maxItems")),
      maxChars: Number(form.get("maxChars")),
      allowSensitive: form.get("allowSensitive") === "on"
    }, () => setSaving(false));
  }
  return (
    <form className="memory-settings-form" onSubmit={submit}>
      <div className="proactive-number-grid">
        <label>自动记录<select name="autoCapture" defaultValue={settings.autoCapture}><option value="experience">记录任务经历</option><option value="off">关闭</option></select></label>
        <label>最多召回条数<input name="maxItems" type="number" min="1" max="50" defaultValue={settings.maxItems} /></label>
        <label>最多注入字符<input name="maxChars" type="number" min="200" max="100000" defaultValue={settings.maxChars} /></label>
      </div>
      <div className="proactive-form-foot">
        <label className="memory-check"><input name="allowSensitive" type="checkbox" defaultChecked={settings.allowSensitive} /> 允许敏感记忆参与召回（机密始终排除）</label>
        <button className="button" type="submit" disabled={saving}><Save size={15} /> 保存</button>
      </div>
      <p className="form-hint">这里控制 Hearth 的召回预算；OpenViking 是否写入由上方“记忆索引范围”决定。</p>
    </form>
  );
}

function MemoryCard({
  memory,
  busy,
  knowledgeEnabled,
  writeMode,
  onAction
}: {
  memory: MemoryRecord & { knowledge?: { uri: string; syncedAt: string } };
  busy: boolean;
  knowledgeEnabled: boolean;
  writeMode: MemoryWriteMode;
  onAction: (action: string, payload?: unknown) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [content, setContent] = useState(memory.content);
  const [reason, setReason] = useState("");
  const body = memoryBody(memory);
  const long = body.length > 240;
  const index = indexState(memory, knowledgeEnabled, writeMode);
  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onAction("correct", { content, reason });
    setEditing(false);
  }
  return (
    <article className={"memory-card status-" + memory.status}>
      <div className="memory-card-head">
        <div className="memory-card-title">
          <span className="memory-kind">{KIND_LABELS[memory.kind]}</span>
          <strong title={memory.content}>{memoryTitle(memory)}</strong>
        </div>
        <span className={`memory-index ${index.tone}`} title={index.title}>{index.label}</span>
      </div>
      {editing ? (
        <form className="memory-edit-form" onSubmit={submit}>
          <textarea value={content} onChange={(event) => setContent(event.target.value)} rows={4} />
          <input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="纠正原因（必填）" required />
          <button className="primary-button" type="submit" disabled={busy || !reason.trim()}>保存新版本</button>
        </form>
      ) : (
        <>
          <p className={"memory-body" + (expanded ? " expanded" : "")}>{body}</p>
          {long && <button type="button" className="link-button memory-expand" onClick={() => setExpanded((current) => !current)}>{expanded ? "收起" : "展开全文"}</button>}
        </>
      )}
      <div className="memory-meta">
        <span>{relativeTime(memory.updatedAt)}</span>
        <span>召回 {memory.recallCount} 次</span>
        <span>{memory.source.label}</span>
        {memory.status === "candidate" && <span className="memory-pending">待确认</span>}
      </div>
      {!editing && (
        <div className="memory-card-actions">
          {memory.status === "candidate" && <button className="primary-button compact" onClick={() => onAction("confirm")} disabled={busy}><Check size={15} /> 确认启用</button>}
          {memory.status !== "forgotten" && <button className="ghost-button compact" onClick={() => setEditing(true)} disabled={busy}><Pencil size={15} /> 纠正</button>}
        </div>
      )}
      <details className="memory-technical">
        <summary>更多设置与技术信息</summary>
        <div className="memory-technical-actions">
          {memory.status !== "forgotten" && (memory.sensitivity === "normal"
            ? <button className="ghost-button compact" onClick={() => onAction("sensitive")} disabled={busy}><ShieldAlert size={15} /> 设为敏感</button>
            : <button className="ghost-button compact" onClick={() => onAction("unsensitive")} disabled={busy}><EyeOff size={15} /> 取消敏感</button>)}
          {memory.status !== "forgotten" && (
            <button className="ghost-button compact danger" onClick={() => { if (window.confirm("确认遗忘这条记忆？内容会替换为墓碑，并从召回中移除。")) onAction("forget"); }} disabled={busy}>
              <Trash2 size={15} /> 遗忘
            </button>
          )}
        </div>
        <dl>
          <div><dt>状态</dt><dd>{STATUS_LABELS[memory.status]}</dd></div>
          <div><dt>范围</dt><dd>{memory.scope}</dd></div>
          <div><dt>主题键</dt><dd>{memory.subjectKey}</dd></div>
          <div><dt>置信度</dt><dd>{CONFIDENCE_LABELS[memory.confidence]}</dd></div>
          <div><dt>敏感度</dt><dd>{SENSITIVITY_LABELS[memory.sensitivity]}</dd></div>
          <div><dt>OpenViking</dt><dd>{memory.knowledge?.uri ?? "未写入索引"}</dd></div>
        </dl>
      </details>
    </article>
  );
}

function ConflictCard({
  conflict,
  memories,
  busy,
  onResolve
}: {
  conflict: MemoryConflict;
  memories: MemoryRecord[];
  busy: boolean;
  onResolve: (input: { resolution: "keep_left" | "keep_right" | "merged"; note?: string; content?: string }) => void;
}) {
  const [merged, setMerged] = useState("");
  const left = memories.find((item) => item.id === conflict.memoryIds[0]);
  const right = memories.find((item) => item.id === conflict.memoryIds[1]);
  return (
    <div className="memory-conflict-card">
      <div className="memory-conflict-head"><strong>{conflict.subjectKey}</strong><span>{conflict.note}</span></div>
      <div className="memory-conflict-side"><span>A</span><p>{left?.content ?? "缺失"}</p><button className="ghost-button" disabled={busy} onClick={() => onResolve({ resolution: "keep_left" })}>保留 A</button></div>
      <div className="memory-conflict-side"><span>B</span><p>{right?.content ?? "缺失"}</p><button className="ghost-button" disabled={busy} onClick={() => onResolve({ resolution: "keep_right" })}>保留 B</button></div>
      <div className="memory-merge-row">
        <input value={merged} onChange={(event) => setMerged(event.target.value)} placeholder="合并后的内容" />
        <button className="primary-button" disabled={busy || !merged.trim()} onClick={() => onResolve({ resolution: "merged", content: merged, note: "用户合并冲突" })}>合并</button>
      </div>
    </div>
  );
}

function memoryTitle(memory: MemoryRecord): string {
  const first = memory.content.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
  const task = first.match(/^任务「([^」]+)」/);
  if (task?.[1]) return task[1];
  if (memory.kind === "preference") return "长期偏好";
  if (memory.kind === "fact") return "事实";
  if (memory.kind === "project") return "项目背景";
  if (memory.kind === "commitment") return "承诺";
  if (memory.kind === "method") return "工作方法";
  return truncate(first.replace(/^[#>*\s]+/, ""), 56) || memory.subjectKey;
}

function isEvaluationMemory(memory: MemoryRecord): boolean {
  return /评测运行约束|[\\/]eval-artifacts[\\/]|EXP-\d{8}/i.test(memory.content);
}

function isIndexable(memory: MemoryRecord): boolean {
  return memory.status === "active"
    && memory.allowRecall
    && memory.sensitivity !== "secret"
    && memory.taint === "clean"
    && memory.originClass !== "untrusted"
    && !isEvaluationMemory(memory)
    && !/评测运行约束|[\\/]eval-artifacts[\\/]|EXP-\d{8}/i.test(memory.subjectKey);
}

function memoryBody(memory: MemoryRecord): string {
  const stripped = memory.content.replace(/^任务「[^」]+」(完成|未完成|失败|可恢复)。?/, "").trim();
  return stripped || memory.content;
}

function indexState(memory: MemoryRecord & { knowledge?: { uri: string } }, enabled: boolean, writeMode: MemoryWriteMode): { label: string; tone: string; title: string } {
  if (memory.knowledge) return { label: "已写入 OpenViking", tone: "indexed", title: memory.knowledge.uri };
  if (memory.status !== "active") return { label: "确认后索引", tone: "pending", title: "确认启用后才会参与召回和写入索引。" };
  if (!enabled) return { label: "仅保存在 Hearth", tone: "local", title: "OpenViking 未启用。" };
  if (!memory.allowRecall) return { label: "不参与索引", tone: "local", title: "这条记忆已关闭召回。" };
  if (writeMode === "off") return { label: "不写入索引", tone: "local", title: "当前记忆索引范围设置为不写入。" };
  if (writeMode === "curated" && !["instructions", "curated"].includes(memory.tier)) {
    return { label: "未达索引范围", tone: "pending", title: "当前只索引精选记忆；可在上方改为全部干净记忆。" };
  }
  return { label: "待写入索引", tone: "pending", title: "下次同步时会写入 OpenViking。" };
}

function hitTitle(hit: KnowledgeHit): string {
  const line = hit.abstract?.split(/\r?\n/).map((item) => item.trim()).find(Boolean);
  if (line) return truncate(line.replace(/^#+\s*/, ""), 72);
  const file = hit.uri.split("/").pop() ?? hit.uri;
  return truncate(safeDecode(file).replace(/\.md$/i, ""), 72);
}

function scoreLabel(score: number | null): string {
  if (score === null) return "未评分";
  return score <= 1 ? `${Math.round(score * 100)}%` : score.toFixed(2);
}

function serviceLabel(setup: KnowledgeSetupState | undefined, enabled: boolean, connected: boolean): string {
  if (connected) return "服务运行中";
  if (!setup) return "正在检查服务";
  if (setup.running) return "服务运行中";
  if (setup.installed) return enabled ? "服务未就绪" : "服务已安装";
  return "服务未安装";
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function actionNotice(action: string): string {
  if (action === "confirm") return "记忆已启用。";
  if (action === "forget") return "记忆已遗忘；正文已从当前记录、历史版本、事件和导出中脱敏。";
  if (action === "correct") return "已创建记忆新版本。";
  if (action === "sensitive") return "已标记为敏感并停止自动召回。";
  if (action === "unsensitive") return "已恢复普通敏感度。";
  return "记忆冲突已解决。";
}

function truncate(value: string, length: number): string {
  return value.length > length ? value.slice(0, length) + "…" : value;
}
