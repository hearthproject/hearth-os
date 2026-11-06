import type { RunRecord } from "../../lib/types.ts";
import { abbreviateHash, formatDuration, formatNumber, formatTime } from "../../lib/format.ts";
import { RunStatusTag } from "../StatusPill.tsx";
import { EmptyLine } from "./ProSection.tsx";

export function RunLedger({ runs }: { runs: RunRecord[] }) {
  if (runs.length === 0) return <EmptyLine text="还没有执行记录。" />;

  return (
    <div className="run-ledger">
      <table className="data-table">
        <thead>
          <tr>
            <th scope="col">次序</th>
            <th scope="col">状态</th>
            <th scope="col">开始</th>
            <th scope="col">时长</th>
            <th scope="col" className="align-num">输入</th>
            <th scope="col" className="align-num">缓存命中</th>
            <th scope="col" className="align-num">输出</th>
            <th scope="col" className="align-num">推理</th>
            <th scope="col">执行线程</th>
            <th scope="col">结束原因</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={run.id}>
              <td className="mono">
                #{run.attempt}
                <span className="subtle" title={run.id}>{abbreviateHash(run.id, 6, 4)}</span>
              </td>
              <td><RunStatusTag status={run.status} /></td>
              <td className="mono">{formatTime(run.startedAt)}</td>
              <td className="align-num">{formatDuration(durationMs(run))}</td>
              <td className="align-num mono">{run.usage ? formatNumber(run.usage.inputTokens) : "未记录"}</td>
              <td className="align-num mono">{run.usage ? formatNumber(run.usage.cachedInputTokens) : "未记录"}</td>
              <td className="align-num mono">{run.usage ? formatNumber(run.usage.outputTokens) : "未记录"}</td>
              <td className="align-num mono">{run.usage ? formatNumber(run.usage.reasoningOutputTokens) : "未记录"}</td>
              <td className="mono">{run.threadId ? abbreviateHash(run.threadId, 8, 4) : "未记录"}</td>
              <td title={run.failure?.message ?? ""}>{run.failure ? `${run.failure.kind}：${run.failure.message}` : "正常结束"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function durationMs(run: RunRecord): number | null {
  if (!run.startedAt || !run.endedAt) return null;
  const ms = Date.parse(run.endedAt) - Date.parse(run.startedAt);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}
