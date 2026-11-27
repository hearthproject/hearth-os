import { useMemo, useState } from "react";
import type { EventEnvelope, RunUsage } from "@hearth/core";
import { Check, ChevronDown, ChevronRight, Loader2, Users, TriangleAlert } from "lucide-react";
import { formatDuration } from "../lib/format.ts";

type TeamSource = "hearth" | "codex" | "deepseek-harness";

interface AgentRow {
  id: string;
  type: string;
  title: string;
  status: "running" | "completed" | "failed" | "cancelled" | "blocked";
  source: TeamSource;
  parentId?: string;
  depth?: number;
  startedAt: string;
  durationMs?: number;
  usage?: RunUsage;
  summary?: string;
  reportPath?: string;
  transcriptPath?: string;
  error?: string;
  unresolved?: string[];
}

interface ModeSummary {
  requested: "single" | "team";
  effective: "single" | "team" | "executor-managed";
  owner: TeamSource | "none";
  visibility: string;
  observedMembers?: number;
  stallAutoCancelAfterMs?: number;
}

const SOURCE_LABELS: Record<TeamSource, string> = {
  hearth: "Hearth 成员",
  codex: "Codex 内部成员",
  "deepseek-harness": "DSH 成员"
};

const SOURCE_ORDER: TeamSource[] = ["hearth", "codex", "deepseek-harness"];

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asSource(value: unknown): TeamSource {
  return value === "codex" || value === "deepseek-harness" ? value : "hearth";
}

function formatTokens(usage: RunUsage | undefined): string | null {
  if (!usage) return null;
  const total = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
  if (total <= 0) return null;
  return total >= 1000 ? `${(total / 1000).toFixed(1)}k tok` : `${total} tok`;
}

function collectMode(events: EventEnvelope[]): ModeSummary | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || event.type !== "agent.mode") continue;
    const payload = asRecord(event.payload);
    const requested = payload.requested === "team" ? "team" : "single";
    const effective = payload.effective === "team" ? "team" : payload.effective === "single" ? "single" : "executor-managed";
    const owner = payload.owner === "codex" || payload.owner === "deepseek-harness" || payload.owner === "hearth"
      ? payload.owner
      : "none";
    const observed = asRecord(payload.observed);
    const stall = asRecord(payload.subagentStall);
    return {
      requested,
      effective,
      owner,
      visibility: typeof payload.visibility === "string" ? payload.visibility : "none",
      ...(typeof observed.members === "number" ? { observedMembers: observed.members } : {}),
      ...(typeof stall.autoCancelAfterMs === "number" ? { stallAutoCancelAfterMs: stall.autoCancelAfterMs } : {})
    };
  }
  return null;
}

function collectAgents(events: EventEnvelope[]): AgentRow[] {
  const rows = new Map<string, AgentRow>();
  for (const event of events) {
    if (!event.type.startsWith("subagent.")) continue;
    const payload = asRecord(event.payload);
    const id = typeof payload.childId === "string" ? payload.childId : "";
    if (!id) continue;
    const source = asSource(payload.source);
    if (event.type === "subagent.delegated") {
      rows.set(id, {
        id,
        type: typeof payload.type === "string" ? payload.type : source === "hearth" ? "agent" : "member",
        title: typeof payload.title === "string" ? payload.title : id,
        status: "running",
        source,
        ...(typeof payload.parentId === "string" ? { parentId: payload.parentId } : {}),
        ...(typeof payload.depth === "number" ? { depth: payload.depth } : {}),
        startedAt: event.createdAt,
        ...(typeof payload.transcriptPath === "string" ? { transcriptPath: payload.transcriptPath } : {})
      });
      continue;
    }
    if (event.type !== "subagent.completed" && event.type !== "subagent.blocked" && event.type !== "subagent.failed") continue;
    const previous = rows.get(id);
    const parsedUsage = typeof payload.usage === "object" && payload.usage !== null
      ? payload.usage as RunUsage
      : undefined;
    const structured = asRecord(payload.structured);
    const unresolved = Array.isArray(structured.unresolved)
      ? structured.unresolved.filter((item): item is string => typeof item === "string")
      : [];
    rows.set(id, {
      id,
      type: typeof payload.type === "string" ? payload.type : previous?.type ?? (source === "hearth" ? "agent" : "member"),
      title: typeof payload.title === "string" ? payload.title : previous?.title ?? id,
      status: payload.status === "completed"
        ? "completed"
        : payload.status === "blocked"
          ? "blocked"
          : payload.status === "cancelled"
            ? "cancelled"
            : "failed",
      source,
      ...(typeof payload.parentId === "string" ? { parentId: payload.parentId } : previous?.parentId ? { parentId: previous.parentId } : {}),
      ...(typeof payload.depth === "number" ? { depth: payload.depth } : previous?.depth !== undefined ? { depth: previous.depth } : {}),
      startedAt: previous?.startedAt ?? event.createdAt,
      ...(typeof payload.durationMs === "number" ? { durationMs: payload.durationMs } : {}),
      ...(parsedUsage ? { usage: parsedUsage } : {}),
      ...(typeof payload.summary === "string" ? { summary: payload.summary } : {}),
      ...(typeof payload.reportPath === "string" ? { reportPath: payload.reportPath } : {}),
      ...(typeof payload.transcriptPath === "string" ? { transcriptPath: payload.transcriptPath } : {}),
      ...(typeof payload.error === "string" ? { error: payload.error } : {}),
      ...(unresolved.length > 0 ? { unresolved } : {})
    });
  }
  return [...rows.values()];
}

function emptyStateText(mode: ModeSummary | null): string {
  if (!mode) return "团队已启用，本次尚未收到成员事件。";
  if (mode.owner === "codex") {
    return "Codex 未回传成员事件，成员不可见；这不表示 Codex 没有使用内部协作，只用总量统计。";
  }
  if (mode.owner === "deepseek-harness") {
    return "DSH 团队已启用，本次尚未收到成员事件（可能没有创建成员）。";
  }
  if (mode.owner === "hearth") {
    return "Hearth 团队已启用，本次未创建成员；简单任务直接完成是预期行为。";
  }
  return "团队已启用，本次未创建成员。";
}

export function AgentRoster({ events }: { events: EventEnvelope[] }) {
  const agents = useMemo(() => collectAgents(events), [events]);
  const mode = useMemo(() => collectMode(events), [events]);
  const [open, setOpen] = useState(true);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const teamActive = mode?.effective === "team" || mode?.requested === "team";
  if (agents.length === 0 && !teamActive) return null;

  const running = agents.filter((agent) => agent.status === "running").length;
  const done = agents.filter((agent) => agent.status === "completed").length;
  const sources = SOURCE_ORDER.filter((source) => agents.some((agent) => agent.source === source));
  const showGroupLabels = sources.length > 1 || (sources[0] !== undefined && sources[0] !== "hearth");

  return (
    <section className="inline-run-roster" aria-label="团队">
      <button type="button" className="inline-run-roster-head" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <Users size={13} />
        <strong>团队</strong>
        <span className="inline-run-roster-count">
          {agents.length === 0
            ? mode?.owner === "codex" ? "成员不可见" : "尚未收到成员事件"
            : `${running > 0 ? `${running} 运行中 · ` : ""}${done}/${agents.length} 完成`}
          {mode?.owner === "hearth" && mode.stallAutoCancelAfterMs
            ? ` · ${Math.round(mode.stallAutoCancelAfterMs / 60_000)} 分钟无进展自动取消`
            : ""}
        </span>
      </button>
      {open && (
        <div className="inline-run-roster-list">
          {agents.length === 0 && <p className="inline-run-roster-empty">{emptyStateText(mode)}</p>}
          {sources.map((source) => (
            <div key={source} className="inline-run-roster-group">
              {showGroupLabels && <div className="inline-run-roster-group-label">{SOURCE_LABELS[source]}</div>}
              {agents.filter((agent) => agent.source === source).map((agent) => {
                const isOpen = expanded[agent.id] === true;
                const tokens = formatTokens(agent.usage);
                const indent = agent.depth && agent.depth > 1 ? { marginLeft: `${Math.min(24, (agent.depth - 1) * 12)}px` } : undefined;
                return (
                  <div key={agent.id} className={`inline-run-agent ${agent.status}`} style={indent}>
                    <button
                      type="button"
                      className="inline-run-agent-head"
                      onClick={() => setExpanded((current) => ({ ...current, [agent.id]: !isOpen }))}
                      aria-expanded={isOpen}
                    >
                      <span className={`inline-run-agent-status ${agent.status}`}>
                        {agent.status === "running"
                          ? <Loader2 size={12} className="spin" />
                          : agent.status === "completed"
                            ? <Check size={12} />
                            : agent.status === "cancelled"
                              ? <span className="inline-run-agent-cancel">×</span>
                              : <TriangleAlert size={12} />}
                      </span>
                      <span className="inline-run-agent-type">{agent.type}</span>
                      <span className="inline-run-agent-title">{agent.title}</span>
                      {agent.durationMs !== undefined && <span className="inline-run-agent-meta">{formatDuration(agent.durationMs)}</span>}
                      {tokens && <span className="inline-run-agent-meta">{tokens}</span>}
                      {isOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                    </button>
                    {isOpen && (
                      <div className="inline-run-agent-detail">
                        {agent.summary && <pre>{agent.summary}</pre>}
                        {agent.unresolved && agent.unresolved.length > 0 && (
                          <ul className="inline-run-agent-unresolved">
                            {agent.unresolved.map((item, index) => <li key={index}>{item}</li>)}
                          </ul>
                        )}
                        {agent.error && <p className="inline-run-agent-error">{agent.error}</p>}
                        {agent.reportPath && <p className="inline-run-agent-path">回执：{agent.reportPath}</p>}
                        {agent.transcriptPath && <p className="inline-run-agent-path">过程：{agent.transcriptPath}</p>}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
