import type { ApprovalRecord, EffectRecord } from "../../lib/types.ts";
import { abbreviateHash, formatTime } from "../../lib/format.ts";
import { APPROVAL_STATUS_LABELS, approvalKindLabel, externalEffectSummary } from "../../lib/labels.ts";
import { EffectStatusTag } from "../StatusPill.tsx";
import { EmptyLine } from "./ProSection.tsx";

export function EffectLedger({ effects, approvals }: { effects: EffectRecord[]; approvals: ApprovalRecord[] }) {
  if (effects.length === 0 && approvals.length === 0) {
    return <EmptyLine text="这个任务没有外部动作，也没有待确认事项。" />;
  }
  const uncertain = effects.filter((effect) => effect.status === "uncertain");

  return (
    <div className="effect-ledger">
      {uncertain.length > 0 && (
        <p className="reconcile-note">
          {externalEffectSummary(approvals, effects)}幂等键已登记，重试不会重复执行；请先在目标系统确认是否已经生效。
        </p>
      )}

      {effects.length > 0 && (
        <table className="data-table">
          <caption className="table-caption">外部动作</caption>
          <thead>
            <tr>
              <th scope="col">状态</th>
              <th scope="col">类型</th>
              <th scope="col">幂等键</th>
              <th scope="col">回执</th>
              <th scope="col">错误</th>
              <th scope="col">更新时间</th>
            </tr>
          </thead>
          <tbody>
            {effects.map((effect) => (
              <tr key={effect.id} className={effect.status === "uncertain" ? "row-risk" : undefined}>
                <td><EffectStatusTag status={effect.status} /></td>
                <td>{approvalKindLabel(effect.kind)}</td>
                <td className="mono select-all" title={effect.idempotencyKey}>{abbreviateHash(effect.idempotencyKey, 24, 8)}</td>
                <td className="payload-cell">
                  {effect.receipt
                    ? <details><summary>{receiptSummary(effect.receipt)}</summary><pre className="json-block">{JSON.stringify(effect.receipt, null, 2)}</pre></details>
                    : "无回执"}
                </td>
                <td className="truncate" title={effect.error ?? ""}>{effect.error ?? "—"}</td>
                <td className="mono">{formatTime(effect.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {approvals.length > 0 && (
        <table className="data-table">
          <caption className="table-caption">确认记录</caption>
          <thead>
            <tr>
              <th scope="col">状态</th>
              <th scope="col">类型</th>
              <th scope="col">摘要</th>
              <th scope="col">参数指纹</th>
              <th scope="col">决定时间</th>
              <th scope="col">有效期</th>
            </tr>
          </thead>
          <tbody>
            {approvals.map((approval) => (
              <tr key={approval.id}>
                <td>{APPROVAL_STATUS_LABELS[approval.status]}</td>
                <td>{approvalKindLabel(approval.kind)}</td>
                <td className="truncate" title={approval.summary}>{approval.summary}</td>
                <td className="mono select-all" title={approval.parameterHash}>{abbreviateHash(approval.parameterHash, 12, 6)}</td>
                <td className="mono">{formatTime(approval.decidedAt)}</td>
                <td className="mono">{formatTime(approval.expiresAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function receiptSummary(receipt: Record<string, unknown>): string {
  const url = typeof receipt.url === "string" ? receipt.url : null;
  const pull = typeof receipt.pull === "number" ? `PR #${receipt.pull}` : null;
  const reused = receipt.idempotent === true ? "已存在，未重复执行" : null;
  return [pull, url ? abbreviateHash(url, 28, 6) : null, reused].filter(Boolean).join(" · ") || "回执已记录";
}
