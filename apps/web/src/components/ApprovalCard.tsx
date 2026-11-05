import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Clock3, ExternalLink, GitPullRequest, Loader2, MessageSquare, ShieldCheck, X } from "lucide-react";
import { api } from "../lib/api.ts";
import { formatDate } from "../lib/format.ts";
import type { ApprovalRecord, EffectRecord } from "../lib/types.ts";

export function ApprovalCard({ approval, effect }: { approval: ApprovalRecord; effect?: EffectRecord | undefined }) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const preview = approval.preview;
  const title = stringValue(preview.title);
  const body = stringValue(preview.body);
  const repo = stringValue(preview.repo) ?? stringValue(approval.target.repo);
  const branch = stringValue(preview.branch) ?? stringValue(approval.target.branch);
  const base = stringValue(preview.base) ?? stringValue(approval.target.base);
  const isPending = approval.status === "pending";

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
      <header className="approval-card-head">
        <span className="approval-card-icon"><ShieldCheck size={20} /></span>
        <div>
          <span className="eyebrow">需要你确认 · {actionLabel(approval.kind)}</span>
          <h2>{approval.summary}</h2>
          <p>这一步会在 Hearth 之外产生真实影响。只有你确认后才会执行一次。</p>
        </div>
        <span className="approval-status">{approvalStatusLabel(approval.status)}</span>
      </header>

      <div className="approval-target">
        <div><span>位置</span><strong>{repo ?? "未提供"}</strong></div>
        <div><span>分支</span><strong>{branch ?? "未提供"} → {base ?? "未提供"}</strong></div>
        <div><span>确认有效期</span><strong><Clock3 size={13} /> {formatDate(approval.expiresAt)}</strong></div>
      </div>

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
            <span><AlertTriangle size={17} /> 确认后 Hearth 会立即执行，不能撤销。</span>
            <div>
              <button className="ghost-button" onClick={() => setConfirming(false)} disabled={decide.isPending}>返回检查</button>
              <button className="primary-button" onClick={() => decide.mutate("approve")} disabled={decide.isPending}>
                {decide.isPending ? <><Loader2 className="spin" size={16} /> 正在执行</> : <><CheckCircle2 size={16} /> 确认执行</>}
              </button>
            </div>
          </div>
        ) : (
          <footer className="approval-actions">
            <button className="ghost-button danger" onClick={() => decide.mutate("reject")} disabled={decide.isPending}><X size={16} /> 拒绝</button>
            <button className="primary-button" onClick={() => setConfirming(true)} disabled={decide.isPending}><GitPullRequest size={16} /> 检查并确认执行</button>
          </footer>
        )
      ) : (
        <div className={`approval-result ${approval.status}`}>
          {approval.status === "approved" && effect?.status === "succeeded" ? <CheckCircle2 size={17} /> : <MessageSquare size={17} />}
          <span>{approvalResultLabel(approval.status, effect)}</span>
          {typeof effect?.receipt?.url === "string" && (
            <a href={effect.receipt.url} target="_blank" rel="noreferrer">打开结果 <ExternalLink size={13} /></a>
          )}
        </div>
      )}

      <small className="approval-binding">参数指纹 {approval.parameterHash.slice(0, 12)}… · 内容变化后必须重新确认</small>
    </section>
  );
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function actionLabel(kind: string): string {
  if (kind === "github.publish-pr") return "创建 GitHub PR";
  if (kind === "github.comment") return "发布 GitHub 评论";
  return kind;
}

function approvalStatusLabel(status: ApprovalRecord["status"]): string {
  if (status === "pending") return "等待决定";
  if (status === "approved") return "已批准";
  if (status === "rejected") return "已拒绝";
  return "已过期";
}

function approvalResultLabel(status: ApprovalRecord["status"], effect?: EffectRecord): string {
  if (status === "rejected") return "你拒绝了这次外部动作，没有产生外部影响。";
  if (status === "expired") return "确认已过期，没有执行外部动作。";
  if (effect?.status === "succeeded") return "外部动作已经完成，回执已记录。";
  if (effect?.status === "uncertain") return "执行结果不确定，请先到目标系统核对，避免重复操作。";
  if (effect?.status === "failed") return `执行失败：${effect.error ?? "未知原因"}`;
  return "审批已记录。";
}
