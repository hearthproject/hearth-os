import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../../lib/api.ts";
import { EVENT_LABELS } from "../../lib/labels.ts";
import { abbreviateHash, formatTime } from "../../lib/format.ts";
import { EmptyLine } from "./ProSection.tsx";

const WINDOW = 100;

export function EvidenceLog({ taskId }: { taskId: string }) {
  const [before, setBefore] = useState<number | null>(null);
  const query = useQuery({
    queryKey: ["taskEvents", taskId, before],
    queryFn: () => api.taskEvents(taskId, before === null ? { limit: WINDOW } : { limit: WINDOW, before }),
    staleTime: 30_000,
    placeholderData: keepPreviousData
  });
  const page = query.data;
  const events = page?.events ?? [];
  const first = events.at(0);
  const last = events.at(-1);

  return (
    <div className="evidence-log">
      <div className="table-toolbar">
        <span className="mono">
          {page ? `共 ${page.total} 条` : "正在读取事实记录…"}
          {first && last ? ` · 本页 seq ${first.seq}–${last.seq}` : ""}
        </span>
        <span className="toolbar-actions">
          {page?.nextBefore !== null && page?.nextBefore !== undefined && (
            <button className="ghost-button" onClick={() => setBefore(page.nextBefore)}>更早 {WINDOW} 条</button>
          )}
          {before !== null && <button className="ghost-button" onClick={() => setBefore(null)}>回到最新</button>}
          <button className="ghost-button" onClick={() => void query.refetch()}>刷新</button>
        </span>
      </div>
      {query.isError && <p className="form-error">事实记录读取失败，本机服务可能已停止。</p>}
      {events.length === 0 && !query.isLoading && <EmptyLine text="这一段没有事实记录。" />}
      {events.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">seq</th>
              <th scope="col">时间</th>
              <th scope="col">类型</th>
              <th scope="col">执行记录</th>
              <th scope="col">内容</th>
            </tr>
          </thead>
          <tbody>
            {events.map((event) => (
              <tr key={event.seq}>
                <td className="mono">{event.seq}</td>
                <td className="mono">{formatTime(event.createdAt)}</td>
                <td>
                  {EVENT_LABELS[event.type] ?? event.type}
                  <span className="mono subtle">{event.type}</span>
                </td>
                <td className="mono">{event.runId ? abbreviateHash(event.runId, 6, 4) : "—"}</td>
                <td className="payload-cell">
                  <details>
                    <summary>{describe(event.payload)}</summary>
                    <pre className="json-block">{JSON.stringify(event.payload, null, 2)}</pre>
                  </details>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function describe(payload: unknown): string {
  if (payload === null || typeof payload !== "object") return "无内容";
  const record = payload as Record<string, unknown>;
  const keys = Object.keys(record);
  const detail = typeof record.message === "string" ? record.message
    : typeof record.status === "string" ? record.status
      : typeof record.relativePath === "string" ? record.relativePath
        : `${keys.length} 个字段`;
  return keys.length > 0 ? detail : "空对象";
}
