import { useMutation, useQuery } from "@tanstack/react-query";
import { Brain, CheckCircle2, Loader2, Search, Settings2 } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api.ts";
import { formatNumber, relativeTime } from "../lib/format.ts";
import { isEvaluationMemory } from "../lib/memory.ts";
import type {
  KnowledgeHit,
  KnowledgeSetupState,
  KnowledgeStatusResponse,
  MemoryKind,
  MemoryRecord
} from "../lib/types.ts";

const KIND_LABELS: Record<MemoryKind, string> = {
  fact: "事实",
  preference: "偏好",
  project: "项目",
  commitment: "承诺",
  experience: "经历",
  method: "方法"
};

const CONTEXT_LABELS: Record<KnowledgeHit["contextType"], string> = {
  memory: "记忆",
  resource: "资料",
  skill: "技能",
  unknown: "内容"
};

export function MemoryPage() {
  const [searchText, setSearchText] = useState("");
  const [searchResults, setSearchResults] = useState<KnowledgeHit[] | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);

  const snapshotQuery = useQuery({ queryKey: ["memory"], queryFn: api.memory, refetchInterval: 20_000 });
  const knowledgeQuery = useQuery({ queryKey: ["knowledge"], queryFn: api.knowledgeStatus, refetchInterval: 20_000 });
  const setupQuery = useQuery({ queryKey: ["knowledgeSetup"], queryFn: api.knowledgeSetup, refetchInterval: 10_000 });

  const searchMutation = useMutation({
    mutationFn: (query: string) => api.knowledgeSearch(query),
    onSuccess: (data) => {
      setSearchError(null);
      setSearchResults(data.hits);
    },
    onError: (error: Error) => {
      setSearchError(error.message);
      setSearchResults([]);
    }
  });

  const snapshot = snapshotQuery.data;
  const status = knowledgeQuery.data;
  const setup = setupQuery.data;
  const enabled = status?.settings.enabled ?? false;
  const connected = enabled && status?.health.ok === true;
  const visibleMemories = (snapshot?.memories ?? []).filter((memory) => !isEvaluationMemory(memory));
  const remembered = visibleMemories
    .filter((memory) => memory.status === "active")
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const waiting = visibleMemories.filter((memory) => memory.status === "candidate").length;

  function search() {
    const query = searchText.trim();
    if (!query || !connected) return;
    setSearchResults(null);
    setSearchError(null);
    searchMutation.mutate(query);
  }

  return (
    <div className="page workbench-page memory-page">
      <div className="page-head memory-page-head">
        <div>
          <h1>记忆</h1>
          <p className="page-meta">Hearth 会记住你的偏好、项目背景和做过的事，在聊天和任务中自动参考。</p>
        </div>
      </div>

      {snapshotQuery.isLoading && <p className="section-empty">正在读取记忆…</p>}
      {snapshotQuery.isError && <p className="form-error">{snapshotQuery.error.message}</p>}

      <MemoryStatus status={status} setup={setup} total={remembered.length} waiting={waiting} />

      <MemorySearch
        connected={connected}
        query={searchText}
        setQuery={setSearchText}
        pending={searchMutation.isPending}
        results={searchResults}
        error={searchError}
        onSearch={search}
      />

      {snapshot && (
        <section className="memory-section">
          <div className="memory-section-head">
            <div>
              <h2><Brain size={16} /> Hearth 记住的内容</h2>
              <p>这些内容不用你整理，聊天和任务需要时会自动参考。</p>
            </div>
            {remembered.length > 0 && <span className="memory-count">共 {formatNumber(remembered.length)} 条</span>}
          </div>

          {remembered.length === 0 ? (
            <div className="memory-empty">
              <strong>还没有记住的内容</strong>
              <p>完成一些任务并和 Hearth 聊过之后，这里会自动出现。</p>
            </div>
          ) : (
            <div className="memory-list">
              {remembered.map((memory) => <MemoryCard key={memory.id} memory={memory} />)}
            </div>
          )}

          {waiting > 0 && (
            <p className="memory-footnote">还有 {formatNumber(waiting)} 条新内容还没有确认，暂时不会自动参考。</p>
          )}
        </section>
      )}
    </div>
  );
}

function MemoryStatus({
  status,
  setup,
  total,
  waiting
}: {
  status: KnowledgeStatusResponse | undefined;
  setup: KnowledgeSetupState | undefined;
  total: number;
  waiting: number;
}) {
  const enabled = status?.settings.enabled ?? false;
  const healthy = enabled && status?.health.ok === true;
  const installed = setup?.installed ?? true;
  const referenceOff = status?.settings.write.memories === "off";
  const active = healthy && !referenceOff;

  const title = !status
    ? "正在读取记忆…"
    : !enabled
      ? installed ? "记忆助手还没有开启" : "记忆助手尚未安装"
      : !healthy
        ? "记忆暂时不可用"
        : referenceOff
          ? "记忆已暂停自动参考"
          : "Hearth 正在记住你的工作";
  const copy = !status
    ? "稍等一下。"
    : !enabled
      ? "你仍然可以查看已经记住的内容；开启后，聊天和任务会自动参考它们。"
      : !healthy
        ? "聊天和任务暂时不受影响。可以到设置里检查一下。"
        : referenceOff
          ? "内容会继续保存，但聊天和任务暂时不会自动参考。可以在设置里重新开启。"
          : "下面这些内容会在聊天和任务中自动参考，你不需要手动整理。";

  return (
    <section className="knowledge-overview memory-status">
      <div className="knowledge-overview-head">
        <span className={`knowledge-mark ${active ? "ok" : "idle"}`}><Brain size={20} /></span>
        <div className="knowledge-overview-copy">
          <div className="knowledge-title-row">
            <h2>{title}</h2>
          </div>
          <p>{copy}</p>
          {status && (
            <div className="memory-summary">
              <span><strong>{formatNumber(total)}</strong> 条已保存</span>
              {waiting > 0 && <span><strong>{formatNumber(waiting)}</strong> 条还没有确认</span>}
            </div>
          )}
        </div>
        <div className="knowledge-actions">
          {!status
            ? null
            : active
              ? <span className="memory-status-hint"><CheckCircle2 size={14} /> 平时不需要你操作</span>
              : <Link className="ghost-button" to="/settings?tab=knowledge"><Settings2 size={15} /> 去设置</Link>}
        </div>
      </div>
      {setup?.install.status === "running" && (
        <p className="knowledge-progress"><Loader2 size={15} className="spin" /> 正在准备记忆助手，完成前不影响查看已有内容。</p>
      )}
    </section>
  );
}

function MemorySearch({
  connected,
  query,
  setQuery,
  pending,
  results,
  error,
  onSearch
}: {
  connected: boolean;
  query: string;
  setQuery: (value: string) => void;
  pending: boolean;
  results: KnowledgeHit[] | null;
  error: string | null;
  onSearch: () => void;
}) {
  return (
    <section className="knowledge-search">
      <div className="knowledge-search-head">
        <div>
          <h2>查找记忆</h2>
          <p>用一句话找以前做过的事，或者你让 Hearth 记住的内容。</p>
        </div>
        {!connected && <span className="page-meta">开启记忆助手后可用</span>}
      </div>
      <form className="knowledge-search-form" onSubmit={(event) => { event.preventDefault(); onSearch(); }}>
        <label className="knowledge-search-input">
          <Search size={15} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="例如：上次的任务、我的写作习惯、项目背景"
            disabled={!connected}
          />
        </label>
        <button className="primary-button" type="submit" disabled={!connected || !query.trim() || pending}>
          {pending ? <Loader2 size={15} className="spin" /> : <Search size={15} />} 查找
        </button>
      </form>
      {pending && <p className="section-empty">正在查找…</p>}
      {!pending && error && <p className="form-error">{error}</p>}
      {!pending && !error && results && results.length === 0 && <p className="section-empty">没有找到。换一种说法试试。</p>}
      {!pending && !error && results && results.length > 0 && (
        <div className="knowledge-results">
          {results.map((hit) => <SearchResult key={hit.uri} hit={hit} />)}
        </div>
      )}
    </section>
  );
}

function SearchResult({ hit }: { hit: KnowledgeHit }) {
  return (
    <article className="knowledge-hit">
      <div className="knowledge-hit-head">
        <span className="memory-kind">{CONTEXT_LABELS[hit.contextType]}</span>
        <strong>{hitTitle(hit)}</strong>
      </div>
      <p>{hit.abstract || "这条内容暂时没有可显示的摘要。"}</p>
    </article>
  );
}

function MemoryCard({ memory }: { memory: MemoryRecord }) {
  const [expanded, setExpanded] = useState(false);
  const body = memoryBody(memory);
  const long = body.length > 180;

  return (
    <article className="memory-card">
      <div className="memory-card-head">
        <div className="memory-card-title">
          <span className="memory-kind">{KIND_LABELS[memory.kind]}</span>
          <strong title={memoryTitle(memory)}>{memoryTitle(memory)}</strong>
        </div>
      </div>
      <p className={"memory-body" + (expanded ? " expanded" : "")}>{body}</p>
      {long && (
        <button type="button" className="link-button memory-expand" onClick={() => setExpanded((current) => !current)}>
          {expanded ? "收起" : "展开全文"}
        </button>
      )}
      <div className="memory-meta">
        <span>{relativeTime(memory.updatedAt)}</span>
        {memory.recallCount > 0 && <span>被参考 {formatNumber(memory.recallCount)} 次</span>}
      </div>
    </article>
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
  return truncate(first.replace(/^[#>*\s]+/, ""), 56) || "一条记忆";
}

function memoryBody(memory: MemoryRecord): string {
  const stripped = memory.content.replace(/^任务「[^」]+」(完成|未完成|失败|可恢复)。?/, "").trim();
  return stripped || memory.content;
}

function hitTitle(hit: KnowledgeHit): string {
  const line = hit.abstract?.split(/\r?\n/).map((item) => item.trim()).find(Boolean);
  return line ? truncate(line.replace(/^#+\s*/, ""), 72) : "一条相关内容";
}

function truncate(value: string, length: number): string {
  return value.length > length ? value.slice(0, length) + "…" : value;
}
