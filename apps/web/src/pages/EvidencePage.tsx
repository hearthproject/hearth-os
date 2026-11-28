import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import {
  Activity,
  ArrowLeftRight,
  Coins,
  GitBranch,
  Loader2,
  Play,
  RefreshCw,
  Scale,
  ShieldCheck
} from "lucide-react";
import { api } from "../lib/api.ts";
import { formatDate } from "../lib/format.ts";

type JsonRecord = Record<string, unknown>;

const TABS = [
  { id: "provenance", label: "来源链", icon: GitBranch },
  { id: "manifest", label: "Manifest 差异", icon: ArrowLeftRight },
  { id: "replay", label: "Replay / 分叉", icon: Play },
  { id: "policy", label: "Policy 策略", icon: ShieldCheck },
  { id: "cost", label: "成本与降级", icon: Coins },
  { id: "variants", label: "Harness 变体", icon: Scale }
] as const;

type TabId = (typeof TABS)[number]["id"];

function asRecord(value: unknown): JsonRecord {
  return typeof value === "object" && value !== null ? (value as JsonRecord) : {};
}
function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function text(value: unknown, fallback = "—"): string {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}
function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function shortHash(value: unknown): string {
  const raw = text(value, "");
  return raw.length > 18 ? `${raw.slice(0, 18)}…` : raw || "—";
}
function json(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function EvidencePage() {
  const [params, setParams] = useSearchParams();
  const tasksQuery = useQuery({ queryKey: ["tasks"], queryFn: api.tasks, refetchInterval: 20_000 });
  const [taskId, setTaskId] = useState(() => params.get("task") ?? "");
  const [runId, setRunId] = useState(() => params.get("run") ?? "");
  const [tab, setTab] = useState<TabId>("provenance");
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [forkSeq, setForkSeq] = useState("");
  const [preflightText, setPreflightText] = useState(
    '[\n  { "tool": "read_file", "args": { "path": "README.md" } },\n  { "tool": "shell", "args": { "command": "git status --short" } }\n]'
  );
  const [compareRun, setCompareRun] = useState("");

  const tasks = tasksQuery.data?.tasks ?? [];
  const selectedTask = tasks.find((item) => item.id === taskId) ?? null;
  const taskQuery = useQuery({
    queryKey: ["task", taskId],
    queryFn: () => api.task(taskId),
    enabled: taskId.length > 0
  });
  const runs = taskQuery.data?.runs ?? [];
  const effectiveRunId = runId || runs[runs.length - 1]?.id || "";

  const evidenceQuery = useQuery({
    queryKey: ["evidence", taskId],
    queryFn: () => api.evidenceTask(taskId),
    enabled: taskId.length > 0
  });
  const provenanceQuery = useQuery({
    queryKey: ["evidence-provenance", taskId],
    queryFn: () => api.evidenceProvenance(taskId),
    enabled: taskId.length > 0 && tab === "provenance"
  });
  const costQuery = useQuery({
    queryKey: ["evidence-cost", taskId],
    queryFn: () => api.evidenceCost(taskId),
    enabled: taskId.length > 0 && tab === "cost"
  });
  const policyQuery = useQuery({
    queryKey: ["evidence-policy", taskId],
    queryFn: () => api.evidencePolicyActual(taskId),
    enabled: taskId.length > 0 && tab === "policy"
  });
  const replayReportsQuery = useQuery({
    queryKey: ["evidence-replay", effectiveRunId],
    queryFn: () => api.evidenceReplayReports(effectiveRunId || undefined),
    enabled: tab === "replay"
  });
  const manifestQuery = useQuery({
    queryKey: ["evidence-manifest", effectiveRunId],
    queryFn: () => api.evidenceManifest(effectiveRunId),
    enabled: effectiveRunId.length > 0 && (tab === "manifest" || tab === "cost")
  });
  const compareManifestQuery = useQuery({
    queryKey: ["evidence-manifest", compareRun],
    queryFn: () => api.evidenceManifest(compareRun),
    enabled: tab === "manifest" && compareRun.length > 0
  });
  const variantsQuery = useQuery({
    queryKey: ["evidence-variants"],
    queryFn: () => api.evidenceVariants(),
    enabled: tab === "variants"
  });
  const variantMetricsQuery = useQuery({
    queryKey: ["evidence-variant-metrics"],
    queryFn: () => api.evidenceVariantMetrics(),
    enabled: tab === "variants"
  });

  const counts = asRecord(asRecord(evidenceQuery.data).counts);
  const chains = asArray(asRecord(provenanceQuery.data).chains);
  const graph = asRecord(asRecord(provenanceQuery.data).graph);
  const graphNodes = asArray(graph.nodes);
  const graphEdges = asArray(graph.edges);
  const policy = asRecord(policyQuery.data);
  const decisions = asArray(policy.decisions);
  const preflights = asArray(policy.preflights);
  const cost = asRecord(costQuery.data);
  const degradations = asArray(cost.degradations);
  const budgets = asArray(cost.budgets);
  const entries = asArray(cost.entries);
  const reports = asArray(asRecord(replayReportsQuery.data).reports);
  const manifest = asRecord(asRecord(manifestQuery.data).manifest);
  const compareManifest = asRecord(asRecord(compareManifestQuery.data).manifest);

  const manifestDiff = useMemo(() => {
    if (!compareRun) return [];
    const left = asRecord(manifest.variant);
    const right = asRecord(compareManifest.variant);
    const rows: Array<{ key: string; left: string; right: string; changed: boolean }> = [];
    const push = (key: string, a: unknown, b: unknown) => {
      const leftText = text(a);
      const rightText = text(b);
      rows.push({ key, left: leftText, right: rightText, changed: leftText !== rightText });
    };
    push("harnessVariantId", left.harnessVariantId, right.harnessVariantId);
    push("variant digest", left.digest, right.digest);
    push("runtime mode", asRecord(manifest.runtime).mode, asRecord(compareManifest.runtime).mode);
    push("model", asRecord(manifest.runtime).model, asRecord(compareManifest.runtime).model);
    push("executor", asRecord(manifest.executor).id, asRecord(compareManifest.executor).id);
    push("fingerprint", manifest.compatibilityFingerprint, compareManifest.compatibilityFingerprint);
    return rows;
  }, [manifest, compareManifest, compareRun]);

  function selectTask(id: string) {
    setTaskId(id);
    setRunId("");
    setCompareRun("");
    setNotice(null);
    const next = new URLSearchParams(params);
    if (id) next.set("task", id);
    else next.delete("task");
    next.delete("run");
    setParams(next, { replace: true });
  }

  function selectRun(id: string) {
    setRunId(id);
    const next = new URLSearchParams(params);
    if (id) next.set("run", id);
    else next.delete("run");
    setParams(next, { replace: true });
  }

  async function runReplay() {
    if (!effectiveRunId) return;
    setBusy("replay");
    setNotice(null);
    try {
      const result = await api.evidenceReplay({ cassetteId: effectiveRunId, mode: "strict_replay", taskId });
      const divergence = asRecord(asRecord(result.report).divergence);
      setNotice({ tone: "ok", text: `Replay 完成：${text(divergence.kind, "unknown")}，报告 ${text(asRecord(result.report).id, "—")}` });
      await replayReportsQuery.refetch();
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
  }

  async function runFork() {
    if (!effectiveRunId) return;
    setBusy("fork");
    setNotice(null);
    try {
      const seq = Number.parseInt(forkSeq, 10);
      const result = await api.evidenceFork(effectiveRunId, Number.isFinite(seq) ? { checkpointSeq: seq } : {});
      const root = asRecord(result);
      const child = root.childRunId ?? root.runId ?? asRecord(root.fork).childRunId;
      setNotice({ tone: "ok", text: `已从检查点分叉：${text(child, "新运行已创建")}` });
      await replayReportsQuery.refetch();
      await taskQuery.refetch();
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
  }

  async function runPreflight() {
    if (!taskId) return;
    setBusy("preflight");
    setNotice(null);
    try {
      const parsed = JSON.parse(preflightText) as unknown;
      if (!Array.isArray(parsed)) throw new Error("动作列表必须是 JSON 数组");
      const result = await api.evidencePreflight({ taskId, actions: parsed as JsonRecord[] });
      setNotice({
        tone: "ok",
        text: `Preflight 完成：${text(result.decision ?? asRecord(result).status, "已生成")}，策略指纹 ${shortHash(result.policyHash)}`
      });
      await policyQuery.refetch();
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="evidence-page">
      <header className="evidence-head">
        <div>
          <p className="eyebrow">Hearth Evidence</p>
          <h1>证据与策略控制台</h1>
          <p className="muted">来源链、Manifest 差异、Replay 分叉、Policy 决策与成本降级，全部来自真实运行记录。</p>
        </div>
        <button className="ghost-button" onClick={() => {
          void evidenceQuery.refetch();
          void provenanceQuery.refetch();
          void costQuery.refetch();
          void policyQuery.refetch();
          void replayReportsQuery.refetch();
          void taskQuery.refetch();
        }}>
          <RefreshCw size={15} /> 刷新
        </button>
      </header>

      <section className="evidence-picker">
        <label>
          <span>任务</span>
          <select value={taskId} onChange={(event) => selectTask(event.target.value)}>
            <option value="">选择任务…</option>
            {tasks.slice(0, 60).map((task) => (
              <option key={task.id} value={task.id}>{task.title || task.goal.slice(0, 40)}</option>
            ))}
          </select>
        </label>
        <label>
          <span>运行</span>
          <select value={effectiveRunId} onChange={(event) => selectRun(event.target.value)} disabled={runs.length === 0}>
            <option value="">{runs.length === 0 ? "暂无运行" : "选择运行…"}</option>
            {runs.map((run) => (
              <option key={run.id} value={run.id}>#{run.attempt} · {run.status} · {run.id.slice(0, 10)}</option>
            ))}
          </select>
        </label>
        {selectedTask && (
          <div className="evidence-task-meta">
            <span className={`status-chip status-${selectedTask.status}`}>{selectedTask.status}</span>
            <span className="muted">{selectedTask.executorId} · {formatDate(selectedTask.createdAt)}</span>
          </div>
        )}
      </section>

      {notice && <p className={`evidence-notice ${notice.tone}`}>{notice.text}</p>}

      {taskId.length === 0 ? (
        <div className="evidence-empty">
          <Activity size={28} />
          <h2>选择一个任务开始</h2>
          <p>控制台会读取该任务的 runtime manifest、artifact provenance、replay 报告、policy 决策和 USD 成本。</p>
        </div>
      ) : (
        <>
          <section className="evidence-summary">
            <Metric label="运行数" value={runs.length} hint={`${runs.filter((run) => run.status === "completed").length} 完成`} />
            <Metric label="产物" value={num(counts.artifacts) ?? chains.length} hint={`${num(counts.complete) ?? 0} 条完整来源链`} />
            <Metric label="Policy 决策" value={decisions.length} hint={`${preflights.length} 次 Preflight`} />
            <Metric label="USD 成本" value={entries.length} hint="按 run 记录的真实价格" />
          </section>

          <nav className="evidence-tabs" aria-label="证据视图">
            {TABS.map((item) => {
              const Icon = item.icon;
              return (
                <button key={item.id} className={`evidence-tab${tab === item.id ? " active" : ""}`} onClick={() => setTab(item.id)}>
                  <Icon size={15} /> {item.label}
                </button>
              );
            })}
          </nav>

          {tab === "provenance" && (
            <section className="evidence-body">
              <div className="evidence-card">
                <SectionTitle title="产物来源链" hint={`${chains.length} 个产物 · ${graphNodes.length} 个图节点 · ${graphEdges.length} 条边`} />
                {provenanceQuery.isPending ? <Loading /> : chains.length === 0 ? (
                  <p className="muted">该任务还没有产物 provenance。运行完成后会自动写入。</p>
                ) : (
                  <div className="evidence-chain-list">
                    {chains.map((chain) => {
                      const record = asRecord(chain);
                      const completeness = asRecord(record.completeness);
                      const sources = asArray(record.sources);
                      return (
                        <article key={text(record.artifactId)} className="evidence-chain">
                          <div className="evidence-chain-head">
                            <strong>{text(record.relativePath ?? record.artifactId)}</strong>
                            <span className={completeness.status === "complete" ? "tag ok" : "tag warn"}>{text(completeness.status, "unknown")}</span>
                          </div>
                          <div className="evidence-chain-meta">
                            <span>sha256 {shortHash(record.sha256)}</span>
                            <span>{sources.length} 个来源</span>
                          </div>
                          {sources.length > 0 && (
                            <ol className="evidence-sources">
                              {sources.map((source, index) => {
                                const item = asRecord(source);
                                return (
                                  <li key={`${text(item.kind)}-${index}`}>
                                    <span className="tag">{text(item.kind, "source")}</span>
                                    {text(item.ref ?? item.path ?? item.id ?? item.note)}
                                  </li>
                                );
                                })}
                            </ol>
                          )}
                        </article>
                      );
                    })}
                  </div>
                )}
              </div>
              <div className="evidence-card">
                <SectionTitle title="Artifact Graph" hint="节点与依赖边" />
                <pre className="evidence-json">{json({ nodes: graphNodes, edges: graphEdges })}</pre>
              </div>
            </section>
          )}

          {tab === "manifest" && (
            <section className="evidence-body">
              <div className="evidence-card">
                <SectionTitle title="Manifest 差异" hint="对比同一任务的两条运行" />
                <div className="evidence-inline-form">
                  <label>
                    <span>当前运行</span>
                    <select value={effectiveRunId} onChange={(event) => selectRun(event.target.value)}>
                      {runs.map((run) => <option key={run.id} value={run.id}>#{run.attempt} · {run.id.slice(0, 10)}</option>)}
                    </select>
                  </label>
                  <label>
                    <span>对比运行</span>
                    <select value={compareRun} onChange={(event) => setCompareRun(event.target.value)}>
                      <option value="">选择基线运行…</option>
                      {runs.filter((run) => run.id !== effectiveRunId).map((run) => (
                        <option key={run.id} value={run.id}>#{run.attempt} · {run.status} · {run.id.slice(0, 10)}</option>
                      ))}
                    </select>
                  </label>
                </div>
                {compareRun.length === 0 ? <p className="muted">选择一条运行后显示差异。</p> : (
                  <table className="evidence-table">
                    <thead><tr><th>字段</th><th>当前</th><th>对比</th></tr></thead>
                    <tbody>
                      {manifestDiff.map((row) => (
                        <tr key={row.key} className={row.changed ? "changed" : ""}>
                          <td>{row.key}</td><td>{row.left}</td><td>{row.right}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                <SectionTitle title="当前 Manifest" hint={effectiveRunId ? `run ${effectiveRunId.slice(0, 12)}` : "未选择运行"} />
                {manifestQuery.isPending ? <Loading /> : <pre className="evidence-json">{json(manifestQuery.data ?? {})}</pre>}
              </div>
            </section>
          )}

          {tab === "replay" && (
            <section className="evidence-body">
              <div className="evidence-card">
                <SectionTitle title="重放与检查点分叉" hint="Strict Replay 从 cassette 重放整条运行；Fork 从检查点创建新分支。" />
                <div className="evidence-actions">
                  <button className="primary-button" disabled={!effectiveRunId || busy !== null} onClick={() => void runReplay()}>
                    {busy === "replay" ? <Loader2 size={15} className="spin" /> : <Play size={15} />} Strict Replay
                  </button>
                  <div className="evidence-inline-form">
                    <label>
                      <span>检查点序号（可选）</span>
                      <input value={forkSeq} onChange={(event) => setForkSeq(event.target.value)} placeholder="例如 12" inputMode="numeric" />
                    </label>
                    <button className="ghost-button" disabled={!effectiveRunId || busy !== null} onClick={() => void runFork()}>
                      {busy === "fork" ? <Loader2 size={15} className="spin" /> : <GitBranch size={15} />} 首次分叉
                    </button>
                  </div>
                </div>
              </div>
              <div className="evidence-card">
                <SectionTitle title="Replay 报告" hint={`${reports.length} 份`} />
                {replayReportsQuery.isPending ? <Loading /> : reports.length === 0 ? (
                  <p className="muted">还没有该运行的 replay 报告。</p>
                ) : (
                  <div className="evidence-report-list">
                    {reports.map((report) => {
                      const record = asRecord(report);
                      const divergence = asRecord(record.divergence);
                      return (
                        <details key={text(record.id)} className="evidence-report" open>
                          <summary>
                            <span className="tag">{text(record.mode ?? record.kind, "replay")}</span>
                            <strong>{text(record.id)}</strong>
                            <span className={divergence.kind === "none" ? "tag ok" : "tag warn"}>
                              {text(divergence.kind, "no_divergence")}
                            </span>
                          </summary>
                          <pre className="evidence-json">{json(record)}</pre>
                        </details>
                      );
                    })}
                  </div>
                )}
              </div>
            </section>
          )}

          {tab === "policy" && (
            <section className="evidence-body">
              <div className="evidence-card">
                <SectionTitle title="Policy Preflight" hint="审批发生前先做一次策略预演，确认哪些动作会被放行、询问或拒绝。" />
                <label className="evidence-block-label">
                  <span>动作列表（JSON）</span>
                  <textarea value={preflightText} onChange={(event) => setPreflightText(event.target.value)} rows={8} spellCheck={false} />
                </label>
                <button className="primary-button" disabled={busy !== null || taskId.length === 0} onClick={() => void runPreflight()}>
                  {busy === "preflight" ? <Loader2 size={15} className="spin" /> : <ShieldCheck size={15} />} 运行 Preflight
                </button>
                {preflights.length > 0 && (
                  <div className="evidence-report-list">
                    {preflights.slice(0, 5).map((item) => {
                      const record = asRecord(item);
                      return (
                        <details key={text(record.id)} className="evidence-report">
                          <summary>
                            <span className="tag">preflight</span>
                            <strong>{text(record.id)}</strong>
                            <span className="muted">{text(record.policyHash)}</span>
                          </summary>
                          <pre className="evidence-json">{json(record.payload ?? record)}</pre>
                        </details>
                      );
                    })}
                  </div>
                )}
              </div>
              <div className="evidence-card">
                <SectionTitle title="真实审批决策" hint={`${decisions.length} 条 · 全部在审批前记录`} />
                {policyQuery.isPending ? <Loading /> : decisions.length === 0 ? (
                  <p className="muted">该任务还没有 policy 决策记录。</p>
                ) : (
                  <table className="evidence-table">
                    <thead><tr><th>动作</th><th>策略结果</th><th>执行结果</th><th>时间</th></tr></thead>
                    <tbody>
                      {decisions.map((item) => {
                        const record = asRecord(item);
                        const payload = asRecord(record.payload);
                        const evaluation = asRecord(payload.evaluation);
                        const enforcement = asRecord(payload.enforcement);
                        return (
                          <tr key={text(record.id)}>
                            <td>{text(asRecord(payload.action).tool, text(record.id))}</td>
                            <td><span className={`tag ${evaluation.effect === "deny" ? "warn" : "ok"}`}>{text(evaluation.effect, "allow")}</span></td>
                            <td>{text(enforcement.reason ?? enforcement.enforcedBy)}</td>
                            <td>{text(record.createdAt)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
                <SectionTitle title="策略对比" hint="当前策略与任务基线策略" />
                <pre className="evidence-json">{json(policy.policy ?? {})}</pre>
              </div>
            </section>
          )}

          {tab === "cost" && (
            <section className="evidence-body">
              <div className="evidence-summary compact">
                <Metric label="成本记录" value={entries.length} hint="真实 token × 单价" />
                <Metric label="预算" value={budgets.length} hint="任务级 USD / token 上限" />
                <Metric label="降级事件" value={degradations.length} hint="跨 run 单调阶梯" />
              </div>
              <div className="evidence-card">
                <SectionTitle title="USD 成本明细" hint="缺价会被阻断，不会静默按 0 计费" />
                {costQuery.isPending ? <Loading /> : entries.length === 0 ? <p className="muted">暂无成本记录。</p> : (
                  <table className="evidence-table">
                    <thead><tr><th>运行</th><th>模型</th><th>USD</th><th>输入 / 输出 tokens</th></tr></thead>
                    <tbody>
                      {entries.map((entry) => {
                        const record = asRecord(entry);
                        return (
                          <tr key={text(record.id)}>
                            <td>{shortHash(record.runId)}</td>
                            <td>{text(record.model)}</td>
                            <td>{text(record.usd ?? record.costUsd)}</td>
                            <td>{text(record.inputTokens)} / {text(record.outputTokens)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
              <div className="evidence-card">
                <SectionTitle title="降级阶梯" hint="none → context_shrink → tool_call_reduce → fallback_model → stop" />
                {degradations.length === 0 ? <p className="muted">暂无降级记录。</p> : (
                  <div className="evidence-report-list">
                    {degradations.slice(-12).reverse().map((item) => {
                      const record = asRecord(item);
                      const payload = asRecord(record.payload);
                      const directive = asRecord(payload.directive ?? payload);
                      return (
                        <details key={text(record.id)} className="evidence-report">
                          <summary>
                            <span className={directive.step === "stop" ? "tag warn" : "tag"}>{text(directive.step ?? directive.level, "degradation")}</span>
                            <strong>{text(payload.reason ?? record.kind, "escalation")}</strong>
                            <span className="muted">{text(record.createdAt)}</span>
                          </summary>
                          <pre className="evidence-json">{json(payload)}</pre>
                        </details>
                      );
                    })}
                  </div>
                )}
                <SectionTitle title="Runtime Manifest 的成本字段" hint="实际生效的预算与降级快照" />
                <pre className="evidence-json">{json(asRecord(manifest.budget ?? manifest.cost ?? {}))}</pre>
              </div>
            </section>
          )}

          {tab === "variants" && (
            <section className="evidence-body">
              <div className="evidence-card">
                <SectionTitle title="Harness Variant Policy Lab" hint="任务级变体会覆盖 Runtime 参数：工具策略、并行度、重试、压缩阈值。" />
                {variantsQuery.isPending ? <Loading /> : (
                  <div className="variant-grid">
                    {asArray(asRecord(variantsQuery.data).variants).map((item) => {
                      const variant = asRecord(item);
                      return (
                        <article key={text(variant.id)} className="variant-card">
                          <div className="variant-card-head">
                            <strong>{text(variant.label ?? variant.id)}</strong>
                            <span className="tag">{text(variant.id)}</span>
                          </div>
                          <p className="muted">{text(variant.description)}</p>
                          <pre className="evidence-json small">{json(variant.overrides ?? {})}</pre>
                        </article>
                      );
                    })}
                  </div>
                )}
              </div>
              <div className="evidence-card">
                <SectionTitle title="变体指标" hint="按 variant 聚合的成功率、成本与耗时" />
                <pre className="evidence-json">{json(variantMetricsQuery.data ?? {})}</pre>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function Metric({ label, value, hint }: { label: string; value: string | number; hint: string }) {
  return (
    <div className="evidence-metric">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{hint}</small>
    </div>
  );
}

function SectionTitle({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="evidence-section-title">
      <h3>{title}</h3>
      {hint && <span className="muted">{hint}</span>}
    </div>
  );
}

function Loading() {
  return <p className="evidence-loading"><Loader2 size={16} className="spin" /> 正在读取证据…</p>;
}
