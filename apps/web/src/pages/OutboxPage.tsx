import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, FileText, Inbox, Pencil, Plus, Send, Trash2 } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { EmptyState } from "../components/EmptyState.tsx";
import { OutboxStatusTag } from "../components/StatusPill.tsx";
import { api } from "../lib/api.ts";
import { formatBytes, formatDate, relativeTime } from "../lib/format.ts";
import type { OutboxDraftListItem, OutboxDraftRequest } from "../lib/types.ts";
import { useViewMode } from "../lib/view-mode.tsx";

interface DraftForm {
  id: string | null;
  account: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  body: string;
  attachmentIds: string[];
}

const EMPTY_FORM: DraftForm = {
  id: null,
  account: "local-outbox",
  to: "",
  cc: "",
  bcc: "",
  subject: "",
  body: "",
  attachmentIds: []
};

export function OutboxPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { mode } = useViewMode();
  const pro = mode === "pro";
  const [form, setForm] = useState<DraftForm | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const outboxQuery = useQuery({ queryKey: ["outbox"], queryFn: api.outbox, refetchInterval: 8_000 });
  const artifactsQuery = useQuery({
    queryKey: ["artifacts"],
    queryFn: api.artifacts,
    enabled: form !== null
  });
  const drafts = outboxQuery.data?.drafts ?? [];
  const artifacts = artifactsQuery.data?.artifacts ?? [];

  function openNew(): void {
    setForm({ ...EMPTY_FORM });
    setError(null);
    setNotice(null);
  }

  function openEdit(draft: OutboxDraftListItem): void {
    setForm({
      id: draft.id,
      account: draft.account,
      to: draft.to.join(", "),
      cc: draft.cc.join(", "),
      bcc: draft.bcc.join(", "),
      subject: draft.subject,
      body: draft.body,
      attachmentIds: draft.attachments.map((attachment) => attachment.artifactId)
    });
    setError(null);
    setNotice(null);
  }

  async function saveDraft(submit: boolean): Promise<void> {
    if (!form) return;
    setBusy(submit ? "submit" : "save");
    setError(null);
    setNotice(null);
    const input: OutboxDraftRequest = {
      account: form.account.trim(),
      to: parseAddresses(form.to),
      cc: parseAddresses(form.cc),
      bcc: parseAddresses(form.bcc),
      subject: form.subject,
      body: form.body,
      attachmentIds: form.attachmentIds
    };
    try {
      const saved = form.id
        ? await api.updateOutboxDraft(form.id, input)
        : await api.createOutboxDraft(input);
      if (submit) {
        const result = await api.submitOutboxDraft(saved.id);
        await queryClient.invalidateQueries({ queryKey: ["outbox"] });
        await queryClient.invalidateQueries({ queryKey: ["tasks"] });
        navigate(`/tasks/${result.task.id}`);
        return;
      }
      setForm({ ...form, id: saved.id });
      setNotice("草稿已保存。确认写入前不会创建审批，也不会写入发件箱。");
      await queryClient.invalidateQueries({ queryKey: ["outbox"] });
    } catch (saveError) {
      setError(errorMessage(saveError));
    } finally {
      setBusy(null);
    }
  }

  async function discard(draft: OutboxDraftListItem): Promise<void> {
    if (!window.confirm(`丢弃“${draft.subject || "未命名草稿"}”？审批记录会保留，草稿不会再出现在待处理列表。`)) return;
    setBusy(draft.id);
    setError(null);
    setNotice(null);
    try {
      await api.discardOutboxDraft(draft.id);
      if (form?.id === draft.id) setForm(null);
      setNotice("草稿已丢弃。");
      await queryClient.invalidateQueries({ queryKey: ["outbox"] });
    } catch (discardError) {
      setError(errorMessage(discardError));
    } finally {
      setBusy(null);
    }
  }

  function toggleAttachment(artifactId: string): void {
    if (!form) return;
    setForm({
      ...form,
      attachmentIds: form.attachmentIds.includes(artifactId)
        ? form.attachmentIds.filter((id) => id !== artifactId)
        : [...form.attachmentIds, artifactId]
    });
  }

  return (
    <div className="page outbox-page">
      <div className="page-head">
        <h1>发件箱</h1>
        <span className="page-meta">草稿、一次性审批和本地回执。不会连接邮件服务器，也不会发送。</span>
      </div>

      <section className="panel outbox-notice">
        <div>
          <strong>这是本机发件箱，不是已发送邮件。</strong>
          <p>确认后只把邮件和附件写入本机数据目录，并留下可核对的回执。删除对应文件即可撤销。</p>
        </div>
        <button className="primary-button" onClick={openNew}><Plus size={15} /> 新建草稿</button>
      </section>

      {(error || notice) && <p className={error ? "form-error" : "section-empty"} role="status">{error ?? notice}</p>}

      {form && (
        <section className="panel">
          <div className="panel-head">
            <h2>{form.id ? "编辑草稿" : "新建草稿"}</h2>
            <span className="panel-meta">保存不等于批准</span>
          </div>
          <div className="custom-task-form outbox-form">
            <div className="source-form-grid">
              <label>
                发件账户标签
                <input
                  value={form.account}
                  maxLength={200}
                  placeholder="local-outbox"
                  onChange={(event) => setForm({ ...form, account: event.target.value })}
                />
              </label>
              <label>
                主题
                <input
                  value={form.subject}
                  maxLength={500}
                  placeholder="例如：周会纪要"
                  onChange={(event) => setForm({ ...form, subject: event.target.value })}
                />
              </label>
              <label className="source-field-wide">
                收件人
                <input
                  value={form.to}
                  placeholder="reviewer@example.test, teammate@example.test"
                  onChange={(event) => setForm({ ...form, to: event.target.value })}
                />
              </label>
              <label>
                抄送
                <input value={form.cc} onChange={(event) => setForm({ ...form, cc: event.target.value })} />
              </label>
              <label>
                密送
                <input value={form.bcc} onChange={(event) => setForm({ ...form, bcc: event.target.value })} />
              </label>
              <label className="source-field-wide">
                正文
                <textarea
                  value={form.body}
                  rows={9}
                  onChange={(event) => setForm({ ...form, body: event.target.value })}
                />
              </label>
            </div>

            <div className="outbox-attachments">
              <div className="panel-head">
                <h3>附件</h3>
                <span className="panel-meta">来自已有产物，不复制聊天内容</span>
              </div>
              {artifacts.length === 0 ? (
                <p className="section-empty">还没有可附加的产物。</p>
              ) : (
                <div className="outbox-attachment-list">
                  {artifacts.map((artifact) => (
                    <label key={artifact.id} className="outbox-attachment-option">
                      <input
                        type="checkbox"
                        checked={form.attachmentIds.includes(artifact.id)}
                        onChange={() => toggleAttachment(artifact.id)}
                      />
                      <FileText size={14} />
                      <span>
                        <strong>{artifact.relativePath}</strong>
                        <small>{formatBytes(artifact.bytes)} · {artifact.taskTitle}</small>
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </div>

            <div className="source-form-actions">
              <button className="ghost-button" onClick={() => setForm(null)} disabled={busy !== null}>取消</button>
              <div className="outbox-form-actions">
                <button className="ghost-button" onClick={() => void saveDraft(false)} disabled={busy !== null}>
                  {busy === "save" ? "正在保存…" : "保存草稿"}
                </button>
                <button className="primary-button" onClick={() => void saveDraft(true)} disabled={busy !== null}>
                  <Send size={15} /> {busy === "submit" ? "正在提交…" : "保存并提交审批"}
                </button>
              </div>
            </div>
          </div>
        </section>
      )}

      {outboxQuery.isLoading ? (
        <p className="section-empty">正在读取发件箱…</p>
      ) : drafts.length === 0 ? (
        <section className="panel">
          <EmptyState title="还没有草稿" body="先写一封草稿。提交后会进入审批；批准后只写入本机。" />
        </section>
      ) : (
        <section className="panel outbox-list">
          {drafts.map((draft) => (
            <OutboxDraftRow
              key={draft.id}
              draft={draft}
              pro={pro}
              busy={busy === draft.id}
              onEdit={() => openEdit(draft)}
              onDiscard={() => void discard(draft)}
              onOpenTask={() => draft.taskId && navigate(`/tasks/${draft.taskId}`)}
            />
          ))}
        </section>
      )}
    </div>
  );
}

function OutboxDraftRow({
  draft,
  pro,
  busy,
  onEdit,
  onDiscard,
  onOpenTask
}: {
  draft: OutboxDraftListItem;
  pro: boolean;
  busy: boolean;
  onEdit: () => void;
  onDiscard: () => void;
  onOpenTask: () => void;
}) {
  const editable = draft.status === "draft" || draft.status === "rejected";
  const discardable = draft.status === "draft" || draft.status === "rejected" || draft.status === "failed";
  const receipt = draft.effect?.receipt ?? null;
  const messagePath = typeof receipt?.messagePath === "string" ? receipt.messagePath : null;
  return (
    <article className={`outbox-item status-${draft.status}`}>
      <div className="outbox-item-main">
        <div className="outbox-item-title">
          <Inbox size={16} />
          <strong>{draft.subject || "未命名草稿"}</strong>
          <OutboxStatusTag status={draft.status} />
        </div>
        <p className="outbox-recipient">收件人：{draft.to.length > 0 ? draft.to.join(", ") : "未填写"} · 账户：{draft.account}</p>
        <p className="outbox-preview">{excerpt(draft.body) || "还没有正文。"}</p>
        <p className="outbox-meta">
          {draft.attachments.length > 0 ? `${draft.attachments.length} 个附件 · ` : ""}
          更新于 {relativeTime(draft.updatedAt)} · {formatDate(draft.updatedAt)}
        </p>
        {draft.status === "stored" && (
          <div className="outbox-receipt">
            <CheckCircle2 size={15} />
            <span>已写入本机，未发送。{messagePath ? <code>{messagePath}</code> : null}</span>
          </div>
        )}
        {draft.status === "uncertain" && (
          <p className="form-error"><AlertTriangle size={14} /> 结果不确定，文件可能只写入一部分。请先核对本地发件箱目录。</p>
        )}
        {draft.status === "failed" && draft.effect?.error && (
          <p className="form-error">写入失败：{draft.effect.error}</p>
        )}
        {pro && (
          <dl className="kv-grid outbox-audit">
            <div><dt>草稿 ID</dt><dd className="mono select-all">{draft.id}</dd></div>
            <div><dt>审批 ID</dt><dd className="mono select-all">{draft.approvalId ?? "无"}</dd></div>
            <div><dt>回执 ID</dt><dd className="mono select-all">{draft.effectId ?? "无"}</dd></div>
            <div><dt>提交时间</dt><dd className="mono">{formatDate(draft.submittedAt)}</dd></div>
          </dl>
        )}
      </div>
      <div className="outbox-item-actions">
        {editable && <button className="ghost-button" onClick={onEdit} disabled={busy}><Pencil size={14} /> 编辑</button>}
        {draft.status === "pending_approval" && <button className="primary-button" onClick={onOpenTask}>查看审批</button>}
        {discardable && <button className="ghost-button danger" onClick={onDiscard} disabled={busy}><Trash2 size={14} /> 丢弃</button>}
      </div>
    </article>
  );
}

function parseAddresses(value: string): string[] {
  return value.split(/[,，;\n]/).map((item) => item.trim()).filter(Boolean);
}

function excerpt(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > 160 ? `${compact.slice(0, 160)}…` : compact;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "操作失败";
}
