import { useMemo, useState } from "react";
import type { EventEnvelope, RunUsage } from "@hearth/core";
import { Check, ChevronDown, ChevronRight, Loader2, Users, TriangleAlert } from "lucide-react";
import { formatDuration } from "../lib/format.ts";

interface AgentRow {
  id: string;
  type: string;
  title: string;
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt: string;
  durationMs?: number;
  usage?: RunUsage;
  summary?: string;
  reportPath?: string;
  transcriptPath?: string;
  error?: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function formatTokens(usage: RunUsage | undefined): string | null {
  if (!usage) return null;
  const total = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
  if (total <= 0) return null;
  return total >= 1000 ? `${(total / 1000).toFixed(1)}k tok` : `${total} tok`;
}

function collectAgents(events: EventEnvelope[]): AgentRow[] {
  const rows = new Map<string, AgentRow>();
  for (const event of events) {
    if (!event.type.startsWith("subagent.")) continue;
    const payload = asRecord(event.payload);
    const id = typeof payload.childId === "string" ? payload.childId : "";
    if (!id) continue;
    if (event.type === "subagent.delegated") {
      rows.set(id, {
        id,
        type: typeof payload.type === "string" ? payload.type : "agent",
        title: typeof payload.title === "string" ? payload.title : id,
        status: "running",
        startedAt: event.createdAt,
        ...(typeof payload.transcriptPath === "string" ? { transcriptPath: payload.transcriptPath } : {})
      });
      continue;
    }
    if (event.type !== "subagent.completed" && event.type !== "subagent.failed") continue;
    const previous = rows.get(id);
    const parsedUsage = typeof payload.usage === "object" && payload.usage !== null
      ? payload.usage as RunUsage
      : undefined;
    rows.set(id, {
      id,
      type: typeof payload.type === "string" ? payload.type : previous?.type ?? "agent",
      title: typeof payload.title === "string" ? payload.title : previous?.title ?? id,
      status: payload.status === "completed" ? "completed" : payload.status === "cancelled" ? "cancelled" : "failed",
      startedAt: previous?.startedAt ?? event.createdAt,
      ...(typeof payload.durationMs === "number" ? { durationMs: payload.durationMs } : {}),
      ...(parsedUsage ? { usage: parsedUsage } : {}),
      ...(typeof payload.summary === "string" ? { summary: payload.summary } : {}),
      ...(typeof payload.reportPath === "string" ? { reportPath: payload.reportPath } : {}),
      ...(typeof payload.transcriptPath === "string" ? { transcriptPath: payload.transcriptPath } : {}),
      ...(typeof payload.error === "string" ? { error: payload.error } : {})
    });
  }
  return [...rows.values()];
}

export function AgentRoster({ events }: { events: EventEnvelope[] }) {
  const agents = useMemo(() => collectAgents(events), [events]);
  const [open, setOpen] = useState(true);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  if (agents.length === 0) return null;

  const running = agents.filter((agent) => agent.status === "running").length;
  const done = agents.filter((agent) => agent.status === "completed").length;

  return (
    <section className="inline-run-roster" aria-label="团队">
      <button type="button" className="inline-run-roster-head" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <Users size={13} />
        <strong>团队</strong>
        <span className="inline-run-roster-count">
          {running > 0 ? `${running} 运行中 · ` : ""}{done}/{agents.length} 完成
        </span>
      </button>
      {open && (
        <div className="inline-run-roster-list">
          {agents.map((agent) => {
            const isOpen = expanded[agent.id] === true;
            const tokens = formatTokens(agent.usage);
            return (
              <div key={agent.id} className={`inline-run-agent ${agent.status}`}>
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
                    {agent.error && <p className="inline-run-agent-error">{agent.error}</p>}
                    {agent.reportPath && <p className="inline-run-agent-path">回执：{agent.reportPath}</p>}
                    {agent.transcriptPath && <p className="inline-run-agent-path">过程：{agent.transcriptPath}</p>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
