import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, CircleDashed, CircleSlash, ExternalLink, Loader2 } from "lucide-react";
import { api } from "../lib/api.ts";
import { abbreviateHash, formatDate, formatTime } from "../lib/format.ts";
import { APPROVAL_STATUS_LABELS, EFFECT_STATUS_LABELS, approvalKindLabel, isToolApproval } from "../lib/labels.ts";
import type { ApprovalDisplay, ApprovalRecord, EffectRecord } from "../lib/types.ts";

type ApprovalWithDisplay = ApprovalRecord & { display?: ApprovalDisplay | null };

export function ApprovalCard({ approval, effect }: { approval: ApprovalWithDisplay; effect?: EffectRecord | undefined }) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [alwaysAllow, setAlwaysAllow] = useState(false);
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
  const isTool = isToolApproval(approval);
  const toolName = isTool ? approval.display?.toolName ?? approval.kind.slice("tool.".length) : null;
  const toolArguments = isTool ? target.arguments ?? preview.arguments : null;
  const browserPreview = isBrowserPreview(preview.browser) ? preview.browser : null;
  const isBrowserAction = Boolean(browserPreview) || toolName?.startsWith("browser_");
  const isPending = approval.status === "pending";
  const canAlwaysAllow = preview.canAlwaysAllow === true;

  const decide = useMutation({
    mutationFn: (decision: "approve" | "reject" | "approve_always") => api.decideApproval(approval.id, decision, approval.parameterHash),
    onSuccess: () => {
      setError(null);
      setConfirming(false);
      void queryClient.invalidateQueries({ queryKey: ["task", approval.taskId] });
      void queryClient.invalidateQueries({ queryKey: ["tasks"] });
      void queryClient.invalidateQueries({ queryKey: ["approvals"] });
    },
    onError: (mutationError) => setError(mutationError instanceof Error ? mutationError.message : "确认失败")
  });

  return (
    <section className={`approval-card ${isPending ? "pending" : approval.status}`}>
      <div className="panel-head">
        <h2>{isPending ? "待处理确认" : "历史确认"} · {approvalKindLabel(approval.kind)}</h2>
        <span className="panel-meta">{isPending ? "等你决定" : APPROVAL_STATUS_LABELS[approval.status]}</span>
      </div>

      <p className="approval-summary">{approval.summary}</p>
      {isPending && (
        <p className="approval-scope">
          {isTool
            ? "外部工具调用。拒绝后 Agent 会跳过它并继续尝试完成任务。"
            : "外部副作用。确认后执行一次。"}
        </p>
      )}

      {isTool ? (
        <dl className="kv-grid">
          <div><dt>工具</dt><dd className="mono select-all">{toolName}</dd></div>
          <div>
            <dt>批准范围</dt>
            <dd>{canAlwaysAllow ? "默认只允许这一次；你也可以选择以后自动执行同类操作。" : "仅本次调用；无法自动放行。"}</dd>
          </div>
          <div><dt>确认截止到</dt><dd className="mono">{formatTime(approval.expiresAt)}</dd></div>
        </dl>
      ) : (
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
      )}

      {(title || body) && (
        <div className="approval-preview">
          {title && <strong>{title}</strong>}
          {body && <pre>{body}</pre>}
        </div>
      )}

      {isTool && (
        <div className="approval-preview">
          <strong>本次工具参数</strong>
          {approval.display?.kind === "tool" ? (
            <dl className="kv-grid approval-tool-fields">
              {approval.display.fields.map((field, index) => (
                <div key={`${field.label}-${index}`}>
                  <dt>{field.label}</dt>
                  <dd className="mono select-all">{field.value}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <pre>{formatToolArguments(toolArguments)}</pre>
          )}
        </div>
      )}

      {isBrowserAction && (
        <div className="approval-browser">
          <strong>网页现场</strong>
          <img
            src={`/api/tasks/${encodeURIComponent(approval.taskId)}/browser/screenshot?t=${encodeURIComponent(approval.createdAt)}`}
            alt="浏览器审批截图"
          />
          <dl className="kv-grid">
            {browserPreview && <div><dt>网址</dt><dd className="mono select-all">{browserPreview.url}</dd></div>}
            {browserPreview && <div><dt>动作</dt><dd className="mono">{browserPreview.action}</dd></div>}
            {browserPreview?.elementRef && <div><dt>目标元素</dt><dd className="mono">{browserPreview.elementRef}</dd></div>}
            {browserPreview && <div><dt>风险</dt><dd>{browserPreview.risk}</dd></div>}
            <div><dt>截图</dt><dd>只有当前网页画面，不包含 Cookie、密码或本地文件。</dd></div>
          </dl>
        </div>
      )}

      {error && <p className="form-error">{error}</p>}

      {isPending ? (
        confirming ? (
          <div className="approval-confirm">
            <span>
              <AlertTriangle size={15} /> {isTool ? "仅批准这次工具调用。拒绝后 Agent 会继续执行。" : "立即执行，不能撤销。"}
            </span>
            {canAlwaysAllow && (
              <label className="approval-always">
                <input
                  type="checkbox"
                  checked={alwaysAllow}
                  onChange={(event) => setAlwaysAllow(event.target.checked)}
                  disabled={decide.isPending}
                />
                以后遇到同类外部操作都直接执行（可在“安全与撤销”里取消）
              </label>
            )}
            <div>
              <button className="ghost-button" onClick={() => setConfirming(false)} disabled={decide.isPending}>返回检查</button>
              <button className="primary-button" onClick={() => decide.mutate(alwaysAllow ? "approve_always" : "approve")} disabled={decide.isPending}>
                {decide.isPending
                  ? <><Loader2 className="spin" size={15} /> 正在执行</>
                  : <><CheckCircle2 size={15} /> {alwaysAllow ? "确认并记住" : isTool ? "允许本次工具" : "确认执行"}</>}
              </button>
            </div>
          </div>
        ) : (
          <footer className="approval-actions">
            <button className="ghost-button" onClick={() => decide.mutate("reject")} disabled={decide.isPending}>{isTool ? "拒绝并继续" : "拒绝"}</button>
            <button className="primary-button" onClick={() => setConfirming(true)} disabled={decide.isPending}>
              {isTool ? "检查并允许本次工具" : "检查并确认执行"}
            </button>
          </footer>
        )
      ) : (
        <div className={`approval-result ${approval.status}`}>
          <span>{approvalResultLabel(approval.status, effect, isTool)}</span>
          {effect && <EffectStatusTag status={effect.status} />}
          {typeof effect?.receipt?.url === "string" && (
            <a href={effect.receipt.url} target="_blank" rel="noreferrer">打开结果 <ExternalLink size={13} /></a>
          )}
        </div>
      )}

      <p className="approval-binding">内容变化后必须重新确认 · 指纹 {abbreviateHash(approval.parameterHash, 12, 6)}</p>

      <details className="approval-audit">
        <summary>审计信息</summary>
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
      </details>
    </section>
  );
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function isBrowserPreview(value: unknown): value is { url: string; action: string; elementRef: string | null; risk: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.url === "string" && typeof record.action === "string" && typeof record.risk === "string";
}

function formatToolArguments(value: unknown): string {
  if (value === null || value === undefined) return "（无参数）";
  try {
    const text = JSON.stringify(value, null, 2);
    return text.length > 16_000 ? `${text.slice(0, 16_000)}\n...（参数过长已截断）` : text;
  } catch {
    return String(value);
  }
}

function approvalResultLabel(status: ApprovalRecord["status"], effect?: EffectRecord, isTool = false): string {
  if (isTool && status === "rejected") return "你拒绝了这次工具调用，Agent 已跳过它继续执行。";
  if (isTool && status === "expired") return "工具审批已过期，本次调用没有执行。";
  if (isTool && status === "approved") return "已允许本次工具调用，Agent 已继续执行。";
  if (status === "rejected") return "你拒绝了这次外部动作，没有产生外部影响。";
  if (status === "expired") return "确认已过期，没有执行外部动作。";
  if (effect?.status === "succeeded") return "外部动作已经完成，回执已记录。";
  if (effect?.status === "uncertain") return "结果不确定：可能已部分生效。先到目标核对，再决定是否重试。";
  if (effect?.status === "failed") return `执行失败：${effect.error ?? "未知原因"}`;
  return "审批已记录。";
}

const EFFECT_TONE: Record<EffectRecord["status"], "neutral" | "active" | "risk" | "done"> = {
  pending: "neutral",
  prepared: "neutral",
  admitted: "active",
  executing: "active",
  committed: "done",
  succeeded: "done",
  failed: "risk",
  uncertain: "risk",
  reconciled_committed: "done",
  reconciled_absent: "neutral",
  abandoned: "neutral"
};

function EffectStatusTag({ status }: { status: EffectRecord["status"] }) {
  const Icon = status === "uncertain" ? AlertTriangle : status === "succeeded" ? CheckCircle2 : status === "failed" ? CircleSlash : CircleDashed;
  return (
    <span className={`status-pill tone-${EFFECT_TONE[status]}`}>
      <Icon size={13} />
      {status === "uncertain" && <Icon size={13} className="glyph-offset" />}
      {EFFECT_STATUS_LABELS[status]}
    </span>
  );
}
