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
  "recall-audit": "参考记录",
  devices: "设备副本",
  derivations: "派生记忆",
  consolidation: "巩固报告"
} as const;

type MemoryFilter = "active" | "candidate" | "all";
type Notice = { tone: "ok" | "error" | "info"; text: string };

export function MemoryPage() {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<MemoryFilter>("active");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [creating, setCreating] = useState(false);
  const [searchText, setSearchText] = useState("");
  const [searchResults, setSearchResults] = useState<KnowledgeHit[] | null>(null);
  const [showEvaluation, setShowEvaluation] = useState(false);

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
  const writeMode = status?.settings.write.memories ?? "curated";
  const allMemories = snapshot?.memories ?? [];
  const evaluationCount = allMemories.filter(isEvaluationMemory).length;
  const visibleMemories = showEvaluation ? allMemories : allMemories.filter((memory) => !isEvaluationMemory(memory));
  const counts = {
    active: visibleMemories.filter((memory) => memory.status === "active").length,
    candidate: visibleMemories.filter((memory) => memory.status === "candidate").length,
    all: visibleMemories.length
  };
  const memories = visibleMemories.filter((memory) => filter === "all" || memory.status === filter);
  const pendingConflicts = snapshot?.conflicts.filter((item) => item.status === "pending") ?? [];
  function createMemory(input: CreateMemoryRequest) {
    api
      .createMemory(input)
      .then(() => {
        setNotice({ tone: "ok", text: "已添加，确认后会出现在记忆里。" });
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
          <p className="page-meta">Hearth 记住你的偏好、项目背景和做过的事，需要时自动参考。</p>
        </div>
        <div className="page-actions">
          <button className="ghost-button" onClick={api.exportMemories}><Download size={15} /> 导出</button>
          <Link className="ghost-button" to="/settings?tab=knowledge"><Settings2 size={15} /> 设置</Link>
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
        summary={{ active: counts.active, candidate: counts.candidate, evaluation: evaluationCount }}
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
              <h2><BookOpen size={16} /> Hearth 记住的内容</h2>
              <p>这些内容会在聊天和任务中自动参考；你可以随时纠正或遗忘。</p>
            </div>
            <div className="memory-section-actions">
              <button type="button" className="ghost-button compact" onClick={() => setCreating((current) => !current)}>
                <Plus size={15} /> 添加记忆
              </button>
            </div>
          </div>

          {creating && <MemoryCreateForm onCreate={createMemory} onCancel={() => setCreating(false)} />}

          <div className="inbox-toolbar memory-toolbar">
            <div className="segmented">
              <button className={filter === "active" ? "active" : ""} onClick={() => setFilter("active")}>已记住 {formatNumber(counts.active)}</button>
              <button className={filter === "candidate" ? "active" : ""} onClick={() => setFilter("candidate")}>待确认 {formatNumber(counts.candidate)}</button>
              <button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>全部 {formatNumber(counts.all)}</button>
            </div>
            {evaluationCount > 0 && (
              <label className="memory-check">
                <input type="checkbox" checked={showEvaluation} onChange={(event) => setShowEvaluation(event.target.checked)} />
                显示测试记录 {formatNumber(evaluationCount)}
              </label>
            )}
          </div>

          {actionMutation.error && <p className="form-error">{actionMutation.error.message}</p>}

          {memories.length === 0 ? (
            <p className="section-empty">{filter === "candidate" ? "没有待确认的内容。" : filter === "active" ? "还没有记住的内容。完成一次任务后，Hearth 会自动记录有用的经历。" : "这里还没有内容。"}{!showEvaluation && evaluationCount > 0 ? " 测试记录默认隐藏，可勾选右上角查看。" : ""}</p>
          ) : (
            <div className="memory-list">
              {memories.map((memory) => (
                <MemoryCard
                  key={memory.id}
                  memory={memory}
                  busy={actionMutation.isPending}
                  searchable={connected && isIndexable(memory) && (writeMode === "all" || ["instructions", "curated"].includes(memory.tier))}
                  onAction={(action, payload) => actionMutation.mutate({ action, id: memory.id, payload })}
                />
              ))}
            </div>
          )}

          <details className="memory-fold">
            <summary>自动记录设置</summary>
            <MemorySettingsPanel key={snapshot.settings.updatedAt} settings={snapshot.settings} onSave={saveMemorySettings} />
          </details>

          <details className="memory-fold">
            <summary>最近被参考的记录</summary>
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
            {(snapshot.recalls ?? []).length === 0 && <p className="section-empty">还没有被参考过的记录。</p>}
          </details>

          <details className="memory-fold">
            <summary>已遗忘的内容</summary>
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
  summary
}: {
  status: KnowledgeStatusResponse | undefined;
  setup: KnowledgeSetupState | undefined;
  summary: { active: number; candidate: number; evaluation: number };
}) {
  const enabled = status?.settings.enabled ?? false;
  const connected = enabled && status?.health.ok === true;
  const installed = setup?.installed ?? true;
  const title = connected
    ? "记忆助手已开启"
    : enabled
      ? "记忆助手暂时不可用"
      : installed
        ? "记忆助手未开启"
        : "记忆助手尚未安装";
  const copy = connected
    ? "聊天和任务会自动参考下面这些内容。你不需要手动整理。"
    : enabled
      ? "本机记忆服务没有响应，聊天和任务暂时不会参考记忆。到设置里检查一下即可。"
      : installed
        ? "你现在仍然可以查看已有内容；开启后，聊天和任务才会自动参考。"
        : "安装并开启后，聊天和任务才会自动参考你的记忆。";

  return (
    <section className="knowledge-overview memory-status">
      <div className="knowledge-overview-head">
        <span className={`knowledge-mark ${connected ? "ok" : "idle"}`}><Database size={20} /></span>
        <div className="knowledge-overview-copy">
          <div className="knowledge-title-row">
            <h2>{title}</h2>
          </div>
          <p>{copy}</p>
          <div className="memory-summary">
            <span><strong>{formatNumber(summary.active)}</strong> 条已记住</span>
            <span><strong>{formatNumber(summary.candidate)}</strong> 条待确认</span>
            {summary.evaluation > 0 && <span><strong>{formatNumber(summary.evaluation)}</strong> 条测试记录已隐藏</span>}
          </div>
        </div>
        <div className="knowledge-actions">
          {connected
            ? <span className="memory-status-hint"><CheckCircle2 size={14} /> 无需手动操作</span>
            : <Link className="ghost-button" to="/settings?tab=knowledge"><Settings2 size={15} /> 去设置</Link>}
        </div>
      </div>
      {setup?.install.status === "running" && (
        <p className="knowledge-progress"><Loader2 size={15} className="spin" /> 正在准备记忆服务，完成前不影响查看已有内容。</p>
      )}
    </section>
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
          <h2>搜索记忆</h2>
          <p>用一句话找以前的经历、任务或资料。</p>
        </div>
        {!connected && <span className="page-meta">开启记忆助手后可用</span>}
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
          {pending ? <Loader2 size={15} className="spin" /> : <Search size={15} />} 查找
        </button>
      </form>
      {pending && <p className="section-empty">正在查找…</p>}
      {!pending && results && results.length === 0 && <p className="section-empty">没有找到。换一种说法试试。</p>}
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
      </div>
      <p>{hit.abstract || "这条内容暂时没有摘要。"}</p>
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
        <label>这是哪类内容<select name="kind" defaultValue="preference">{Object.entries(KIND_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label>用于哪个项目<input name="scope" placeholder="留空表示所有对话和任务" maxLength={120} /></label>
      </div>
      <label className="memory-content-field">要记住什么<textarea name="content" required maxLength={8000} rows={3} placeholder="用一句完整的话写清楚，例如：我偏好先给结论，再给依据。" /></label>
      <details className="memory-create-advanced">
        <summary>高级选项</summary>
        <label>关联主题<input name="subjectKey" placeholder="例如：写作偏好（留空会自动生成）" maxLength={200} /></label>
        <p className="form-hint">同一主题下出现不同说法时，Hearth 会提醒你选择保留哪一条。</p>
      </details>
      <div className="proactive-form-foot">
        <span className="form-hint">添加后先进入“待确认”，确认后才会出现在记忆里。</span>
        <div className="memory-form-actions">
          <button type="button" className="ghost-button" onClick={onCancel}>取消</button>
          <button type="submit" className="primary-button"><Check size={15} /> 添加，等待确认</button>
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
        <label>自动记录<select name="autoCapture" defaultValue={settings.autoCapture}><option value="experience">记录做过的事</option><option value="off">关闭</option></select></label>
        <label>每次最多参考几条<input name="maxItems" type="number" min="1" max="50" defaultValue={settings.maxItems} /></label>
        <label>每次最多参考多少字<input name="maxChars" type="number" min="200" max="100000" defaultValue={settings.maxChars} /></label>
      </div>
      <div className="proactive-form-foot">
        <label className="memory-check"><input name="allowSensitive" type="checkbox" defaultChecked={settings.allowSensitive} /> 允许敏感内容被自动参考（机密始终排除）</label>
        <button className="button" type="submit" disabled={saving}><Save size={15} /> 保存</button>
      </div>
      <p className="form-hint">这些设置只影响聊天和任务自动参考的范围，不会删除已经记住的内容。</p>
    </form>
  );
}

function MemoryCard({
  memory,
  busy,
  searchable,
  onAction
}: {
  memory: MemoryRecord;
  busy: boolean;
  searchable: boolean;
  onAction: (action: string, payload?: unknown) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [content, setContent] = useState(memory.content);
  const [reason, setReason] = useState("");
  const body = memoryBody(memory);
  const long = body.length > 240;
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
        {memory.recallCount > 0 && <span>被参考 {memory.recallCount} 次</span>}
        <span>{memory.source.label}</span>
        {memory.status === "candidate" && <span className="memory-pending">待确认</span>}
      </div>
      {!editing && (
        <div className="memory-card-actions">
          {memory.status === "candidate" && <button className="primary-button compact" onClick={() => onAction("confirm")} disabled={busy}><Check size={15} /> 确认记住</button>}
          {memory.status !== "forgotten" && <button className="ghost-button compact" onClick={() => setEditing(true)} disabled={busy}><Pencil size={15} /> 纠正</button>}
        </div>
      )}
      <details className="memory-technical">
        <summary>详情与更多操作</summary>
        <div className="memory-technical-actions">
          {memory.status !== "forgotten" && (memory.sensitivity === "normal"
            ? <button className="ghost-button compact" onClick={() => onAction("sensitive")} disabled={busy}><ShieldAlert size={15} /> 不再自动参考</button>
            : <button className="ghost-button compact" onClick={() => onAction("unsensitive")} disabled={busy}><EyeOff size={15} /> 恢复自动参考</button>)}
          {memory.status !== "forgotten" && (
            <button className="ghost-button compact danger" onClick={() => { if (window.confirm("确认遗忘这条内容？遗忘后不会出现在聊天、任务和搜索结果中。")) onAction("forget"); }} disabled={busy}>
              <Trash2 size={15} /> 遗忘
            </button>
          )}
        </div>
        <dl>
          <div><dt>状态</dt><dd>{STATUS_LABELS[memory.status]}</dd></div>
          <div><dt>适用范围</dt><dd>{memory.scope === "global" ? "所有对话和任务" : memory.scope}</dd></div>
          <div><dt>自动参考</dt><dd>{searchable ? "会" : "暂不会"}</dd></div>
          <div><dt>敏感度</dt><dd>{SENSITIVITY_LABELS[memory.sensitivity]}</dd></div>
          <div><dt>保存在</dt><dd>这台电脑</dd></div>
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

function hitTitle(hit: KnowledgeHit): string {
  const line = hit.abstract?.split(/\r?\n/).map((item) => item.trim()).find(Boolean);
  if (line) return truncate(line.replace(/^#+\s*/, ""), 72);
  const file = hit.uri.split("/").pop() ?? hit.uri;
  return truncate(safeDecode(file).replace(/\.md$/i, ""), 72);
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function actionNotice(action: string): string {
  if (action === "confirm") return "已确认记住。";
  if (action === "forget") return "已遗忘。这条内容不会再出现在聊天、任务和搜索结果中。";
  if (action === "correct") return "已保存修改。";
  if (action === "sensitive") return "已关闭自动参考；你仍然可以在这里查看。";
  if (action === "unsensitive") return "已恢复自动参考。";
  return "已处理这条内容冲突。";
}

function truncate(value: string, length: number): string {
  return value.length > length ? value.slice(0, length) + "…" : value;
}
