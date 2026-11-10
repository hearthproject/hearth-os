import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Brain, Clock3, Link2, RefreshCw, Search, ShieldAlert, Trash2 } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api.ts";
import { formatDate, relativeTime } from "../lib/format.ts";
import type {
  AssertionConfidence,
  CommitmentRecord,
  DecisionRecord,
  EntityKind,
  OntologyEntityView
} from "../lib/types.ts";

const ENTITY_KINDS: EntityKind[] = ["person", "org", "project", "goal", "task", "document", "artifact", "account", "device", "topic"];
const KIND_LABELS: Record<EntityKind, string> = {
  person: "人物",
  org: "组织",
  project: "项目",
  goal: "目标",
  task: "任务",
  document: "文档",
  artifact: "产物",
  account: "账户",
  device: "设备",
  topic: "主题"
};
const CONFIDENCE_LABELS: Record<AssertionConfidence, string> = {
  confirmed: "已确认",
  observed: "已观察",
  inferred: "推断",
  stale: "已过期"
};
const COMMITMENT_STATUSES = ["open", "fulfilled", "broken", "cancelled", "expired"] as const;
const COMMITMENT_LABELS: Record<(typeof COMMITMENT_STATUSES)[number], string> = {
  open: "未完成",
  fulfilled: "已履行",
  broken: "未兑现",
  cancelled: "已取消",
  expired: "已过期"
};
const DECISION_STATUSES = ["active", "superseded", "revoked"] as const;
const DECISION_LABELS: Record<(typeof DECISION_STATUSES)[number], string> = {
  active: "生效中",
  superseded: "已被替代",
  revoked: "已撤销"
};

type Notice = { tone: "ok" | "error"; text: string };

export function PersonalPage() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState<EntityKind | "all">("all");
  const [commitmentStatus, setCommitmentStatus] = useState<(typeof COMMITMENT_STATUSES)[number] | "all">("open");
  const [decisionStatus, setDecisionStatus] = useState<(typeof DECISION_STATUSES)[number] | "all">("active");
  const [notice, setNotice] = useState<Notice | null>(null);

  const entitiesQuery = useQuery({
    queryKey: ["ontology", "entities", search, kind],
    queryFn: () => api.ontologyEntities(search.trim() || undefined, kind === "all" ? undefined : kind),
    refetchInterval: 30_000
  });
  const commitmentsQuery = useQuery({
    queryKey: ["ontology", "commitments", commitmentStatus],
    queryFn: () => api.ontologyCommitments(commitmentStatus === "all" ? undefined : commitmentStatus),
    refetchInterval: 30_000
  });
  const decisionsQuery = useQuery({
    queryKey: ["ontology", "decisions", decisionStatus],
    queryFn: () => api.ontologyDecisions(decisionStatus === "all" ? undefined : decisionStatus),
    refetchInterval: 30_000
  });

  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["ontology"] });
  const correction = useMutation({
    mutationFn: (input: { id: string; key: string; value: unknown }) =>
      api.correctEntity(input.id, { key: input.key, value: input.value }),
    onSuccess: () => {
      setNotice({ tone: "ok", text: "纠正已记录为确认状态，并留下用户决定。" });
      refresh();
    },
    onError: (error: Error) => setNotice({ tone: "error", text: error.message })
  });
  const forget = useMutation({
    mutationFn: (evidenceRef: string) => api.forgetOntologyEvidence(evidenceRef),
    onSuccess: (_result, evidenceRef) => {
      setNotice({ tone: "ok", text: `已按证据 ${evidenceRef} 遗忘，并传播到相关状态与记忆。` });
      refresh();
    },
    onError: (error: Error) => setNotice({ tone: "error", text: error.message })
  });

  const entities = entitiesQuery.data?.entities ?? [];
  const commitments = commitmentsQuery.data?.commitments ?? [];
  const decisions = decisionsQuery.data?.decisions ?? [];
  const loading = entitiesQuery.isLoading || commitmentsQuery.isLoading || decisionsQuery.isLoading;
  const error = entitiesQuery.error ?? commitmentsQuery.error ?? decisionsQuery.error;

  function startCorrection(entity: OntologyEntityView) {
    const key = window.prompt("要纠正哪个状态键？", entity.states[0]?.key ?? "status");
    if (key === null || !key.trim()) return;
    const raw = window.prompt(`输入「${key.trim()}」的新值。可用 JSON，也可以直接写纯文本。`, "");
    if (raw === null) return;
    correction.mutate({ id: entity.id, key: key.trim(), value: parseValue(raw) });
  }

  function startForget(evidenceRef: string) {
    if (!window.confirm(`按证据「${evidenceRef}」遗忘？相关状态、关系、记忆和提及会一起传播处理。`)) return;
    forget.mutate(evidenceRef);
  }

  return (
    <div className="page personal-page">
      <div className="page-head">
        <div>
          <h1>个人状态</h1>
          <p className="page-meta">这里展示代理认为它知道的人、项目、承诺和决定。推断不是事实；你可以纠正或按来源遗忘。</p>
        </div>
        <button className="ghost-button" onClick={refresh} disabled={entitiesQuery.isFetching}>
          <RefreshCw size={15} className={entitiesQuery.isFetching ? "spin" : ""} /> 刷新
        </button>
      </div>

      <div className="stat-line">
        <span><Brain size={13} /> 实体 {entities.length}</span>
        <span><Clock3 size={13} /> 未完成承诺 {commitments.length}</span>
        <span><ShieldAlert size={13} /> 生效决定 {decisions.length}</span>
      </div>

      {notice && <p className={`settings-notice ${notice.tone}`}>{notice.text}</p>}
      {error && <p className="form-error">{error.message}</p>}

      <section className="panel">
        <div className="panel-head">
          <h2><Brain size={16} /> 个人本体</h2>
          <span className="panel-meta">确认 / 观察 / 推断 / 过期四档置信度</span>
        </div>
        <div className="personal-toolbar">
          <label className="personal-search">
            <Search size={14} />
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索实体名称或 ID" />
          </label>
          <select value={kind} onChange={(event) => setKind(event.target.value as EntityKind | "all")}>
            <option value="all">全部类型</option>
            {ENTITY_KINDS.map((item) => <option key={item} value={item}>{KIND_LABELS[item]}</option>)}
          </select>
        </div>
        {loading && entities.length === 0 ? (
          <p className="section-empty">正在读取个人本体…</p>
        ) : entities.length === 0 ? (
          <p className="section-empty">还没有可展示的实体。聊天、来源同步或任务完成后，代理会逐步建立个人本体。</p>
        ) : (
          <div className="personal-entity-grid">
            {entities.map((entity) => (
              <article className="entity-card" key={entity.id}>
                <div className="entity-card-head">
                  <div>
                    <div className="suggestion-kicker">
                      <span className="tag">{KIND_LABELS[entity.kind]}</span>
                      <span className="tag">{CONFIDENCE_LABELS[entity.confidence]}</span>
                      {entity.sensitivity !== "normal" && <span className="tag risk-tag">{entity.sensitivity === "secret" ? "机密" : "敏感"}</span>}
                    </div>
                    <h3>{entity.canonicalName}</h3>
                    <span className="page-meta mono">{entity.id}</span>
                  </div>
                  <div className="detail-actions">
                    <button className="ghost-button" onClick={() => startCorrection(entity)} disabled={correction.isPending}>纠正</button>
                    {entity.states.flatMap((state) => state.evidenceRefs).slice(0, 1).map((ref) => (
                      <button className="ghost-button danger" key={ref} onClick={() => startForget(ref)} disabled={forget.isPending}>
                        <Trash2 size={13} /> 遗忘来源
                      </button>
                    ))}
                  </div>
                </div>
                {entity.aliases.length > 0 && (
                  <div className="entity-aliases">
                    <Link2 size={12} />
                    {entity.aliases.slice(0, 8).map((alias) => <span className="tag" key={alias.id}>{alias.alias}</span>)}
                  </div>
                )}
                {entity.states.length === 0 ? (
                  <p className="section-empty">还没有记录状态。</p>
                ) : (
                  <div className="entity-states">
                    {entity.states.map((state) => (
                      <div className="entity-state" key={state.id}>
                        <div className="entity-state-head">
                          <span className="tag">{state.key}</span>
                          <span className="tag">{CONFIDENCE_LABELS[state.confidence]}</span>
                          <span className="panel-meta">更新于 {formatDate(state.validFrom)}</span>
                        </div>
                        <strong>{formatUnknown(state.value)}</strong>
                        <div className="entity-evidence">
                          {state.sourceRef && <span className="page-meta">来源：{state.sourceRef}</span>}
                          {state.evidenceRefs.slice(0, 3).map((ref) => (
                            <button className="link-button danger" key={state.id + ref} onClick={() => startForget(ref)} disabled={forget.isPending}>
                              遗忘 {shorten(ref, 42)}
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="panel table-panel">
        <div className="panel-head">
          <h2>承诺</h2>
          <select value={commitmentStatus} onChange={(event) => setCommitmentStatus(event.target.value as typeof commitmentStatus)}>
            <option value="open">未完成</option>
            {COMMITMENT_STATUSES.filter((item) => item !== "open").map((item) => <option key={item} value={item}>{COMMITMENT_LABELS[item]}</option>)}
            <option value="all">全部</option>
          </select>
        </div>
        {commitments.length === 0 ? (
          <p className="section-empty">当前筛选下没有承诺。</p>
        ) : (
          <table className="data-table">
            <thead><tr><th>承诺</th><th>状态</th><th>截止</th><th>关联</th><th>证据</th></tr></thead>
            <tbody>
              {commitments.map((item) => <CommitmentRow key={item.id} item={item} onForget={startForget} />)}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel table-panel">
        <div className="panel-head">
          <h2>决定</h2>
          <select value={decisionStatus} onChange={(event) => setDecisionStatus(event.target.value as typeof decisionStatus)}>
            {DECISION_STATUSES.map((item) => <option key={item} value={item}>{DECISION_LABELS[item]}</option>)}
            <option value="all">全部</option>
          </select>
        </div>
        {decisions.length === 0 ? (
          <p className="section-empty">当前筛选下没有决定。</p>
        ) : (
          <table className="data-table">
            <thead><tr><th>决定</th><th>状态</th><th>时间</th><th>理由</th><th>证据</th></tr></thead>
            <tbody>
              {decisions.map((item) => <DecisionRow key={item.id} item={item} onForget={startForget} />)}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function CommitmentRow({ item, onForget }: { item: CommitmentRecord; onForget: (ref: string) => void }) {
  return (
    <tr>
      <td>
        <strong>{item.description}</strong>
        {item.taskId && <Link className="link-button" to={"/tasks/" + item.taskId}>查看任务</Link>}
      </td>
      <td><span className="tag">{COMMITMENT_LABELS[item.status]}</span></td>
      <td title={item.dueAt ?? undefined}>{item.dueAt ? formatDate(item.dueAt) : "未指定"}</td>
      <td className="mono">{shorten(item.entityId ?? item.taskId ?? item.goalId ?? "—", 24)}</td>
      <td>
        {item.evidenceRefs.slice(0, 2).map((ref) => (
          <button className="link-button danger" key={ref} onClick={() => onForget(ref)}>{shorten(ref, 28)}</button>
        ))}
        {item.evidenceRefs.length > 2 && <span className="page-meta"> +{item.evidenceRefs.length - 2}</span>}
      </td>
    </tr>
  );
}

function DecisionRow({ item, onForget }: { item: DecisionRecord; onForget: (ref: string) => void }) {
  return (
    <tr>
      <td>
        <strong>{item.title}</strong>
        <p className="page-meta">{item.decision}</p>
      </td>
      <td><span className="tag">{DECISION_LABELS[item.status]}</span></td>
      <td title={item.decidedAt}>{relativeTime(item.decidedAt)}</td>
      <td>{item.rationale ? shorten(item.rationale, 120) : "未记录"}</td>
      <td>
        {item.evidenceRefs.slice(0, 2).map((ref) => (
          <button className="link-button danger" key={ref} onClick={() => onForget(ref)}>{shorten(ref, 28)}</button>
        ))}
        {item.evidenceRefs.length > 2 && <span className="page-meta"> +{item.evidenceRefs.length - 2}</span>}
      </td>
    </tr>
  );
}

function parseValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  try {
    return JSON.parse(trimmed);
  } catch {
    return raw;
  }
}

function formatUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "—";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function shorten(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}