import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, ExternalLink, Loader2, X } from "lucide-react";
import { api } from "../lib/api.ts";
import { abbreviateHash, formatDate, formatTime } from "../lib/format.ts";
import { APPROVAL_STATUS_LABELS, approvalKindLabel } from "../lib/labels.ts";
import type { ApprovalRecord, EffectRecord } from "../lib/types.ts";
import { EffectStatusTag } from "./StatusPill.tsx";
import { useViewMode } from "../lib/view-mode.tsx";

export function ApprovalCard({ approval, effect }: { approval: ApprovalRecord; effect?: EffectRecord | undefined }) {
  const { mode } = useViewMode();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const preview = approval.preview;
  const target = approval.target;
  const title = text(preview.title) ?? text(target.title);
  const body = text(preview.body) ?? text(target.body);
  const repo = text(preview.repo) ?? text(target.repo);
  const branch = text(preview.branch) ?? text(target.branch);
  const base = text(preview.base) ?? text(target.base);
  const commit = text(preview.commit) ?? text(target.expectedCommit) ?? text(target.headSha);
  const pull = typeof target.pull === "number" ? target.pull : typeof preview.pull === "number" ? preview.pull : null;
  const isPending = approval.status === "pending";
  const pro = mode === "pro";

  const decide = useMutation({
    mutationFn: (decision: "approve" | "reject") => api.decideApproval(approval.id, decision, approval.parameterHash),
    onSuccess: () => {
      setError(null);
      setConfirming(false);
      void queryClient.invalidateQueries({ queryKey: ["task", approval.taskId] });
      void queryClient.invalidateQueries({ queryKey: ["tasks"] });
    },
    onError: (mutationError) => setError(mutationError instanceof Error ? mutationError.message : "确认失败")
  });

  return (
    <section className={`approval-card ${isPending ? "pending" : approval.status}`}>
      <div className="panel-head">
        <h2>审批 · {approvalKindLabel(approval.kind)}</h2>
        <span className="panel-meta">{isPending ? "等你决定" : APPROVAL_STATUS_LABELS[approval.status]}</span>
      </div>

      <p className="approval-summary">{approval.summary}</p>
      {isPending && <p className="approval-scope">外部副作用。确认后执行一次。</p>}

      <dl className="kv-grid">
        <div><dt>对谁</dt><dd className="mono select-all">{repo ?? "未提供"}</dd></div>
        <div>
          <dt>做什么</dt>
          <dd>{approvalKindLabel(approval.kind)}{pull !== null ? ` #${pull}` : ""}{branch && base ? ` ${branch} → ${base}` : ""}</dd>
        </div>
        <div>
          <dt>做到什么程度</dt>
          <dd className="mono select-all">{commit ? `固定到 ${abbreviateHash(commit, 12, 6)}` : "未指定提交"}</dd>
        </div>
        <div><dt>确认截止到</dt><dd className="mono">{formatTime(approval.expiresAt)}</dd></div>
      </dl>

      {(title || body) && (
        <div className="approval-preview">
          {title && <strong>{title}</strong>}
          {body && <pre>{body}</pre>}
        </div>
      )}

      {error && <p className="form-error">{error}</p>}

      {isPending ? (
        confirming ? (
          <div className="approval-confirm">
            <span><AlertTriangle size={15} /> 立即执行，不能撤销。</span>
            <div>
              <button className="ghost-button" onClick={() => setConfirming(false)} disabled={decide.isPending}>返回检查</button>
              <button className="primary-button" onClick={() => decide.mutate("approve")} disabled={decide.isPending}>
                {decide.isPending ? <><Loader2 className="spin" size={15} /> 正在执行</> : <><CheckCircle2 size={15} /> 确认执行</>}
              </button>
            </div>
          </div>
        ) : (
          <footer className="approval-actions">
            <button className="ghost-button" onClick={() => decide.mutate("reject")} disabled={decide.isPending}>拒绝</button>
            <button className="primary-button" onClick={() => setConfirming(true)} disabled={decide.isPending}>检查并确认执行</button>
          </footer>
        )
      ) : (
        <div className={`approval-result ${approval.status}`}>
          <span>{approvalResultLabel(approval.status, effect)}</span>
          {effect && <EffectStatusTag status={effect.status} />}
          {typeof effect?.receipt?.url === "string" && (
            <a href={effect.receipt.url} target="_blank" rel="noreferrer">打开结果 <ExternalLink size={13} /></a>
          )}
        </div>
      )}

      {pro && (
        <div className="approval-audit">
          <dl className="kv-grid">
            <div><dt>审批 ID</dt><dd className="mono select-all">{approval.id}</dd></div>
            <div><dt>参数指纹</dt><dd className="mono select-all">{approval.parameterHash}</dd></div>
            <div><dt>创建时间</dt><dd className="mono">{formatTime(approval.createdAt)}</dd></div>
            <div><dt>决定时间</dt><dd className="mono">{formatDate(approval.decidedAt)}</dd></div>
            <div><dt>关联外部动作</dt><dd className="mono select-all">{approval.effectId ?? "无"}</dd></div>
          </dl>
          <details className="raw-block">
            <summary>核对 target 原文</summary>
            <pre className="json-block">{JSON.stringify(approval.target, null, 2)}</pre>
          </details>
          <details className="raw-block">
            <summary>核对 preview 原文</summary>
            <pre className="json-block">{JSON.stringify(approval.preview, null, 2)}</pre>
          </details>
        </div>
      )}

      {!pro && (
        <p className="approval-binding">内容变化后必须重新确认 · 指纹 {abbreviateHash(approval.parameterHash, 12, 6)}</p>
      )}
    </section>
  );
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function approvalResultLabel(status: ApprovalRecord["status"], effect?: EffectRecord): string {
  if (status === "rejected") return "你拒绝了这次外部动作，没有产生外部影响。";
  if (status === "expired") return "确认已过期，没有执行外部动作。";
  if (effect?.status === "succeeded") return "外部动作已经完成，回执已记录。";
  if (effect?.status === "uncertain") return "结果不确定：可能已部分生效。先到目标核对，再决定是否重试。";
  if (effect?.status === "failed") return `执行失败：${effect.error ?? "未知原因"}`;
  return "审批已记录。";
}
