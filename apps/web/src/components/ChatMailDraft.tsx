import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Loader2, Send } from "lucide-react";
import { api } from "../lib/api.ts";
import { parseMailDraft } from "../lib/mail-draft.ts";
import { ApprovalCard } from "./ApprovalCard.tsx";

export function ChatMailDraft({ content }: { content: string }) {
  const [initial] = useState(() => parseMailDraft(content));
  const [subject, setSubject] = useState(initial.subject);
  const [body, setBody] = useState(initial.body);
  const [to, setTo] = useState("");
  const [accountId, setAccountId] = useState("");
  const [draftId, setDraftId] = useState<string | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const sending = useRef(false);
  const accounts = useQuery({ queryKey: ["mailAccounts"], queryFn: api.mailAccounts });
  const task = useQuery({ queryKey: ["task", taskId], queryFn: () => api.task(taskId!), enabled: Boolean(taskId), refetchInterval: (query) => taskId && !["completed", "failed", "cancelled"].includes(query.state.data?.task.status ?? "") ? 2000 : false });
  const approval = task.data?.approvals.find((item) => item.kind === "email.smtp-send");
  const effect = task.data?.effects.find((item) => item.id === approval?.effectId);
  const locked = Boolean(taskId) && approval?.status !== "rejected";
  const selectedId = accountId || accounts.data?.accounts[0]?.id || "";

  async function prepare() {
    if (sending.current) return;
    sending.current = true;
    setBusy(true); setError("");
    try {
      const input = { account: `smtp:${selectedId}`, to: to.split(/[,;，；\n]+/).map((value) => value.trim()).filter(Boolean), subject, body };
      const draft = draftId ? await api.updateOutboxDraft(draftId, input) : await api.createOutboxDraft(input);
      setDraftId(draft.id);
      const result = await api.submitOutboxDraft(draft.id);
      setTaskId(result.task.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法准备邮件，请重试。");
    } finally { sending.current = false; setBusy(false); }
  }

  return <section className="chat-mail-draft" aria-label="可编辑邮件草稿">
    <div className="chat-mail-fields">
      <label>发件账户<select aria-label="发件账户" value={selectedId} disabled={locked || busy} onChange={(event) => setAccountId(event.target.value)}>
        {!accounts.data?.accounts.length && <option value="">尚未连接邮箱</option>}
        {accounts.data?.accounts.map((item) => <option key={item.id} value={item.id}>{item.fromAddress}</option>)}
      </select></label>
      {!selectedId && <Link to="/mail">连接邮箱</Link>}
      <label>收件人<input aria-label="收件人邮箱" value={to} disabled={locked || busy} onChange={(event) => setTo(event.target.value)} placeholder="老师的邮箱地址" /></label>
      <label>主题<input aria-label="邮件主题" value={subject} disabled={locked || busy} onChange={(event) => setSubject(event.target.value)} /></label>
      <textarea aria-label="信件正文" rows={12} value={body} disabled={locked || busy} onChange={(event) => setBody(event.target.value)} />
    </div>
    {error && <p role="alert">{error}</p>}
    {accounts.isError && <p role="alert">邮箱账户读取失败，请刷新重试。</p>}
    <div className="chat-mail-footer"><span>{task.data?.task.status === "completed" ? "邮件发送流程已完成，可查看下方发送记录" : locked ? "已准备邮件，请在下方查看确认与发送状态" : "可以直接修改；点击小飞机后确认发送"}</span>
      <button type="button" className="primary-button" aria-label="准备发送邮件" title="准备发送邮件" onClick={() => void prepare()} disabled={locked || busy || !selectedId || !to.trim() || !subject.trim() || !body.trim()}>{busy ? <Loader2 size={17} className="spin" /> : <Send size={17} />}</button>
    </div>
    {approval && <ApprovalCard approval={approval} effect={effect} />}
    {taskId && <Link to={`/tasks/${taskId}`}>查看发送状态</Link>}
  </section>;
}
