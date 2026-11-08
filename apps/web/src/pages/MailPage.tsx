import { useEffect, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import {
  CheckCircle2,
  Inbox,
  Loader2,
  Mail,
  PenLine,
  Plus,
  RefreshCw,
  Save,
  Send,
  Settings2,
  Trash2,
  X
} from "lucide-react";
import { api } from "../lib/api.ts";
import { formatDate } from "../lib/format.ts";
import type { MailAccountInput, MailAccountView, SourceItem } from "../lib/types.ts";

type MailTab = "inbox" | "compose" | "accounts";

const EMPTY_ACCOUNT: MailAccountInput = {
  name: "",
  fromName: "Hearth",
  fromAddress: "",
  smtp: { host: "", port: 465, secure: true, user: "", password: "" },
  imap: { host: "", port: 993, secure: true, user: "", password: "" },
  syncEnabled: true,
  syncIntervalMinutes: 15
};

export function MailPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [tab, setTab] = useState<MailTab>("inbox");
  const [notice, setNotice] = useState<{ tone: "ok" | "error" | "info"; text: string } | null>(null);

  const accountsQuery = useQuery({ queryKey: ["mailAccounts"], queryFn: api.mailAccounts, refetchInterval: 30_000 });
  const sourcesQuery = useQuery({ queryKey: ["sources"], queryFn: api.sources, refetchInterval: 20_000 });
  const accounts = accountsQuery.data?.accounts ?? [];
  const emailSources = (sourcesQuery.data?.sources ?? []).filter((source) => source.kind === "email");
  const [sourceId, setSourceId] = useState("");
  const activeSourceId = emailSources.some((source) => source.id === sourceId) ? sourceId : emailSources[0]?.id ?? "";
  const activeSource = emailSources.find((source) => source.id === activeSourceId) ?? null;
  const itemsQuery = useQuery({
    queryKey: ["sourceItems", activeSourceId],
    queryFn: () => api.sourceItems(activeSourceId),
    enabled: Boolean(activeSourceId)
  });
  const [activeItem, setActiveItem] = useState<SourceItem | null>(null);
  const [itemContent, setItemContent] = useState("");
  const [contentBusy, setContentBusy] = useState(false);

  useEffect(() => {
    setActiveItem(null);
    setItemContent("");
  }, [activeSourceId]);

  async function openItem(item: SourceItem) {
    setActiveItem(item);
    setContentBusy(true);
    setItemContent("");
    try {
      const response = await fetch(api.sourceContentUrl(item.sourceId, item.id));
      setItemContent(response.ok ? await response.text() : `读取失败（${response.status}）`);
    } catch (error) {
      setItemContent(error instanceof Error ? error.message : "读取失败");
    } finally {
      setContentBusy(false);
    }
  }

  async function syncSource(sourceIdValue: string) {
    const source = emailSources.find((item) => item.id === sourceIdValue);
    if (!source?.account) {
      setNotice({ tone: "error", text: "这个来源没有关联邮件账户。" });
      return;
    }
    setNotice({ tone: "info", text: "正在同步收件箱…" });
    try {
      const result = await api.syncMailAccount(source.account);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["sources"] }),
        queryClient.invalidateQueries({ queryKey: ["sourceItems", sourceIdValue] })
      ]);
      setNotice({ tone: "ok", text: `同步完成：读取 ${result.fetched} 封，新增 ${result.changed} 封。` });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "同步失败" });
    }
  }

  return (
    <div className="page mail-page">
      <div className="page-head">
        <div>
          <span className="eyebrow">邮件</span>
          <h1>邮件工作台</h1>
          <p className="page-meta">读取是只读的；发送会生成一次性审批，批准后才通过 SMTP 真正发出。</p>
        </div>
        <div className="mail-tabs" role="tablist" aria-label="邮件视图">
          <button className={tab === "inbox" ? "active" : ""} onClick={() => setTab("inbox")}><Inbox size={15} /> 收件箱</button>
          <button className={tab === "compose" ? "active" : ""} onClick={() => setTab("compose")}><PenLine size={15} /> 写邮件</button>
          <button className={tab === "accounts" ? "active" : ""} onClick={() => setTab("accounts")}><Settings2 size={15} /> 账户</button>
        </div>
      </div>

      {notice && (
        <div className={`settings-notice ${notice.tone}`}>
          {notice.tone === "ok" ? <CheckCircle2 size={15} /> : notice.tone === "error" ? <X size={15} /> : <Mail size={15} />}
          <span>{notice.text}</span>
        </div>
      )}

      {tab === "inbox" && (
        <MailInbox
          accounts={accounts}
          sources={emailSources}
          activeSourceId={activeSourceId}
          onSelectSource={setSourceId}
          onSync={syncSource}
          items={itemsQuery.data?.items ?? []}
          itemsLoading={itemsQuery.isLoading}
          activeItem={activeItem}
          content={itemContent}
          contentBusy={contentBusy}
          onOpenItem={openItem}
          onGoAccounts={() => setTab("accounts")}
        />
      )}

      {tab === "compose" && (
        <MailCompose
          accounts={accounts}
          onNotice={setNotice}
          onGoAccounts={() => setTab("accounts")}
          onSubmitted={(taskId) => navigate(`/tasks/${encodeURIComponent(taskId)}`)}
        />
      )}

      {tab === "accounts" && (
        <MailAccounts
          accounts={accounts}
          loading={accountsQuery.isLoading}
          onNotice={setNotice}
          onChanged={async () => {
            await Promise.all([
              queryClient.invalidateQueries({ queryKey: ["mailAccounts"] }),
              queryClient.invalidateQueries({ queryKey: ["sources"] })
            ]);
          }}
        />
      )}
    </div>
  );
}

function MailInbox({
  accounts,
  sources,
  activeSourceId,
  onSelectSource,
  onSync,
  items,
  itemsLoading,
  activeItem,
  content,
  contentBusy,
  onOpenItem,
  onGoAccounts
}: {
  accounts: MailAccountView[];
  sources: Array<{ id: string; account: string | null; displayName: string; status: string; lastReadAt: string | null }>;
  activeSourceId: string;
  onSelectSource: (id: string) => void;
  onSync: (id: string) => void;
  items: SourceItem[];
  itemsLoading: boolean;
  activeItem: SourceItem | null;
  content: string;
  contentBusy: boolean;
  onOpenItem: (item: SourceItem) => void;
  onGoAccounts: () => void;
}) {
  if (accounts.length === 0) {
    return <EmptyMail title="还没有邮件账户" body="先添加一个 SMTP/IMAP 账户，才能同步收件箱和发送邮件。" action={<button className="primary-button" onClick={onGoAccounts}><Plus size={15} /> 添加账户</button>} />;
  }
  if (sources.length === 0) {
    return <EmptyMail title="还没有同步过收件箱" body="到账户页点击“同步”，或等待每 15 分钟自动同步。" action={<button className="primary-button" onClick={onGoAccounts}><RefreshCw size={15} /> 去账户页</button>} />;
  }
  return (
    <section className="mail-layout">
      <div className="panel mail-item-panel">
        <div className="panel-head">
          <div>
            <h2>收件箱</h2>
            <span className="panel-meta">{sources.find((source) => source.id === activeSourceId)?.displayName ?? "邮件来源"}</span>
          </div>
          <button className="ghost-button compact" onClick={() => onSync(activeSourceId)}><RefreshCw size={14} /> 同步</button>
        </div>
        <label className="mail-source-picker">
          <span>来源</span>
          <select value={activeSourceId} onChange={(event) => onSelectSource(event.target.value)}>
            {sources.map((source) => <option key={source.id} value={source.id}>{source.displayName}</option>)}
          </select>
        </label>
        <div className="mail-item-list">
          {itemsLoading && <p className="section-empty"><Loader2 size={14} className="spin" /> 正在读取…</p>}
          {!itemsLoading && items.length === 0 && <p className="section-empty">收件箱还没有条目，点击“同步”读取最近邮件。</p>}
          {items.map((item) => (
            <button key={item.id} className={`mail-item ${activeItem?.id === item.id ? "active" : ""}`} onClick={() => onOpenItem(item)}>
              <strong>{item.title || item.label}</strong>
              <small>{item.locator.replace(/^imap:\/\//, "")}</small>
              <span>{formatDate(item.fetchedAt)}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="panel mail-content-panel">
        <div className="panel-head">
          <div>
            <h2>{activeItem?.title || activeItem?.label || "选择一封邮件"}</h2>
            <span className="panel-meta">{activeItem?.locator ?? "只读预览；不会标记为已读"}</span>
          </div>
        </div>
        {contentBusy ? <p className="section-empty"><Loader2 size={14} className="spin" /> 正在读取正文…</p> : <pre className="mail-content-body">{content || "从左侧选择一封邮件查看正文。"}</pre>}
      </div>
    </section>
  );
}

function MailCompose({
  accounts,
  onNotice,
  onGoAccounts,
  onSubmitted
}: {
  accounts: MailAccountView[];
  onNotice: (notice: { tone: "ok" | "error" | "info"; text: string }) => void;
  onGoAccounts: () => void;
  onSubmitted: (taskId: string) => void;
}) {
  const [accountId, setAccountId] = useState("");
  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [bcc, setBcc] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!accountId && accounts[0]) setAccountId(accounts[0].id);
  }, [accountId, accounts]);

  const account = accounts.find((item) => item.id === accountId) ?? null;

  async function submit() {
    if (!account) return onNotice({ tone: "error", text: "先选择一个发件账户。" });
    if (!to.trim() || !subject.trim() || !body.trim()) return onNotice({ tone: "error", text: "收件人、主题和正文都不能为空。" });
    setBusy(true);
    onNotice({ tone: "info", text: "正在创建草稿并生成审批…" });
    try {
      const draft = await api.createOutboxDraft({
        account: `smtp:${account.id}`,
        to: splitAddresses(to),
        cc: splitAddresses(cc),
        bcc: splitAddresses(bcc),
        subject: subject.trim(),
        body
      });
      const submitted = await api.submitOutboxDraft(draft.id);
      onNotice({ tone: "ok", text: "审批已生成。批准后才会真正发送。" });
      onSubmitted(submitted.task.id);
    } catch (error) {
      onNotice({ tone: "error", text: error instanceof Error ? error.message : "提交失败" });
    } finally {
      setBusy(false);
    }
  }

  if (accounts.length === 0) {
    return <EmptyMail title="还没有发件账户" body="先配置 SMTP 账户，再写信。" action={<button className="primary-button" onClick={onGoAccounts}><Plus size={15} /> 添加账户</button>} />;
  }

  return (
    <section className="mail-compose panel">
      <div className="panel-head">
        <h2>写邮件</h2>
        <span className="panel-meta">提交后进入一次性审批，不会立即发送</span>
      </div>
      <div className="mail-compose-grid">
        <label><span>发件账户</span>
          <select value={accountId} onChange={(event) => setAccountId(event.target.value)}>
            {accounts.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.fromAddress}</option>)}
          </select>
        </label>
        <label><span>收件人</span><input value={to} onChange={(event) => setTo(event.target.value)} placeholder="a@example.com, b@example.com" /></label>
        <label><span>抄送</span><input value={cc} onChange={(event) => setCc(event.target.value)} placeholder="可选" /></label>
        <label><span>密送</span><input value={bcc} onChange={(event) => setBcc(event.target.value)} placeholder="可选" /></label>
        <label className="span-2"><span>主题</span><input value={subject} onChange={(event) => setSubject(event.target.value)} placeholder="邮件主题" /></label>
        <label className="span-2"><span>正文</span><textarea value={body} onChange={(event) => setBody(event.target.value)} rows={10} placeholder="写邮件正文…" /></label>
      </div>
      <div className="mail-compose-foot">
        <p className="page-meta">首版不支持选择附件；后端已支持 artifact 附件。</p>
        <button className="primary-button" onClick={() => void submit()} disabled={busy || !account}>
          {busy ? <Loader2 size={15} className="spin" /> : <Send size={15} />} 提交审批
        </button>
      </div>
    </section>
  );
}

function MailAccounts({
  accounts,
  loading,
  onNotice,
  onChanged
}: {
  accounts: MailAccountView[];
  loading: boolean;
  onNotice: (notice: { tone: "ok" | "error" | "info"; text: string }) => void;
  onChanged: () => Promise<void>;
}) {
  const [draft, setDraft] = useState<MailAccountInput>(EMPTY_ACCOUNT);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  function edit(account: MailAccountView) {
    setEditingId(account.id);
    setDraft({
      name: account.name,
      fromName: account.fromName,
      fromAddress: account.fromAddress,
      smtp: { host: account.smtp.host, port: account.smtp.port, secure: account.smtp.secure, user: account.smtp.user, password: "" },
      imap: { host: account.imap.host, port: account.imap.port, secure: account.imap.secure, user: account.imap.user, password: "" },
      syncEnabled: account.syncEnabled,
      syncIntervalMinutes: account.syncIntervalMinutes
    });
  }

  function updateServer(server: "smtp" | "imap", key: keyof MailAccountInput["smtp"], value: string | number | boolean) {
    setDraft((current) => ({ ...current, [server]: { ...current[server], [key]: value } }));
  }

  async function save() {
    setBusy("save");
    onNotice({ tone: "info", text: "正在保存账户…" });
    try {
      if (editingId) await api.updateMailAccount(editingId, draft);
      else await api.createMailAccount(draft);
      await onChanged();
      onNotice({ tone: "ok", text: editingId ? "账户已更新。" : "账户已创建，可以测试或同步。" });
      setDraft(EMPTY_ACCOUNT);
      setEditingId(null);
    } catch (error) {
      onNotice({ tone: "error", text: error instanceof Error ? error.message : "保存失败" });
    } finally {
      setBusy(null);
    }
  }

  async function test(account: MailAccountView) {
    setBusy(account.id);
    onNotice({ tone: "info", text: `正在测试 ${account.name}…` });
    try {
      const result = await api.testMailAccount(account.id);
      onNotice({
        tone: result.ok ? "ok" : "error",
        text: `SMTP：${result.smtp.ok ? "可用" : result.smtp.error}；IMAP：${result.imap.ok ? "可用" : result.imap.error}`
      });
    } catch (error) {
      onNotice({ tone: "error", text: error instanceof Error ? error.message : "测试失败" });
    } finally {
      setBusy(null);
    }
  }

  async function sync(account: MailAccountView) {
    setBusy(account.id);
    onNotice({ tone: "info", text: `正在同步 ${account.name}…` });
    try {
      const result = await api.syncMailAccount(account.id);
      await onChanged();
      onNotice({ tone: "ok", text: `同步完成：读取 ${result.fetched} 封，新增 ${result.changed} 封。` });
    } catch (error) {
      onNotice({ tone: "error", text: error instanceof Error ? error.message : "同步失败" });
    } finally {
      setBusy(null);
    }
  }

  async function remove(account: MailAccountView) {
    if (!window.confirm(`删除邮件账户「${account.name}」？已有来源和邮件正文不会自动删除。`)) return;
    setBusy(account.id);
    try {
      await api.deleteMailAccount(account.id);
      await onChanged();
      onNotice({ tone: "ok", text: "账户已删除。" });
    } catch (error) {
      onNotice({ tone: "error", text: error instanceof Error ? error.message : "删除失败" });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="mail-accounts-layout">
      <div className="panel mail-account-list">
        <div className="panel-head"><h2>邮件账户</h2><span className="panel-meta">{loading ? "读取中" : `${accounts.length} 个`}</span></div>
        {accounts.length === 0 && <p className="section-empty">还没有账户。</p>}
        {accounts.map((account) => (
          <article key={account.id} className="mail-account-card">
            <div className="mail-account-head">
              <div><strong>{account.name}</strong><small>{account.fromName} · {account.fromAddress}</small></div>
              <span className="status-chip ok">只读同步</span>
            </div>
            <dl className="mail-account-meta">
              <div><dt>SMTP</dt><dd>{account.smtp.host}:{account.smtp.port}{account.smtp.secure ? " · TLS" : ""}</dd></div>
              <div><dt>IMAP</dt><dd>{account.imap.host}:{account.imap.port}{account.imap.secure ? " · TLS" : ""}</dd></div>
              <div><dt>密钥</dt><dd>{account.smtp.hasPassword ? account.smtp.passwordMasked : "未设置"}</dd></div>
            </dl>
            <div className="mail-account-actions">
              <button className="ghost-button compact" onClick={() => void test(account)} disabled={busy !== null}>{busy === account.id ? <Loader2 size={13} className="spin" /> : <CheckCircle2 size={13} />} 测试</button>
              <button className="ghost-button compact" onClick={() => void sync(account)} disabled={busy !== null}>{busy === account.id ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />} 同步</button>
              <button className="ghost-button compact" onClick={() => edit(account)}>编辑</button>
              <button className="ghost-button compact danger" onClick={() => void remove(account)} disabled={busy !== null}><Trash2 size={13} /> 删除</button>
            </div>
          </article>
        ))}
      </div>

      <div className="panel mail-account-editor">
        <div className="panel-head">
          <h2>{editingId ? "编辑账户" : "添加账户"}</h2>
          {editingId && <button className="ghost-button compact" onClick={() => { setEditingId(null); setDraft(EMPTY_ACCOUNT); }}>取消编辑</button>}
        </div>
        <div className="mail-form">
          <label><span>账户名称</span><input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="工作邮箱" /></label>
          <label><span>发件人名称</span><input value={draft.fromName} onChange={(event) => setDraft({ ...draft, fromName: event.target.value })} /></label>
          <label className="span-2"><span>发件地址</span><input value={draft.fromAddress} onChange={(event) => setDraft({ ...draft, fromAddress: event.target.value })} placeholder="hearth@example.com" /></label>
          <ServerFields label="SMTP" value={draft.smtp} onChange={(key, value) => updateServer("smtp", key, value)} defaultPort={465} />
          <ServerFields label="IMAP" value={draft.imap} onChange={(key, value) => updateServer("imap", key, value)} defaultPort={993} />
          <label className="checkbox-field span-2"><input type="checkbox" checked={draft.syncEnabled ?? true} onChange={(event) => setDraft({ ...draft, syncEnabled: event.target.checked })} /> <span>定时同步收件箱（只读）</span></label>
          <label><span>同步间隔（分钟）</span><input type="number" min={5} max={1440} value={draft.syncIntervalMinutes ?? 15} onChange={(event) => setDraft({ ...draft, syncIntervalMinutes: Number(event.target.value) })} /></label>
        </div>
        <div className="settings-actions">
          <button className="primary-button" onClick={() => void save()} disabled={busy !== null}>{busy === "save" ? <Loader2 size={15} className="spin" /> : <Save size={15} />} {editingId ? "保存修改" : "添加账户"}</button>
        </div>
        <p className="settings-hint">密码使用本机密钥加密保存；编辑时留空表示保留原密码。首版使用 SMTP/IMAP 密码或应用专用密码，不支持 OAuth2。</p>
      </div>
    </section>
  );
}

function ServerFields({
  label,
  value,
  onChange,
  defaultPort
}: {
  label: "SMTP" | "IMAP";
  value: MailAccountInput["smtp"];
  onChange: (key: keyof MailAccountInput["smtp"], value: string | number | boolean) => void;
  defaultPort: number;
}) {
  return (
    <>
      <label><span>{label} 服务器</span><input value={value.host} onChange={(event) => onChange("host", event.target.value)} placeholder={label === "SMTP" ? "smtp.example.com" : "imap.example.com"} /></label>
      <label><span>{label} 端口</span><input type="number" value={value.port || defaultPort} onChange={(event) => onChange("port", Number(event.target.value))} /></label>
      <label><span>{label} 用户名</span><input value={value.user} onChange={(event) => onChange("user", event.target.value)} placeholder="通常就是邮箱地址" /></label>
      <label><span>{label} 密码</span><input type="password" value={value.password ?? ""} onChange={(event) => onChange("password", event.target.value)} placeholder="留空保留原密码" autoComplete="off" /></label>
      <label className="checkbox-field span-2"><input type="checkbox" checked={value.secure} onChange={(event) => onChange("secure", event.target.checked)} /> <span>{label} 使用 TLS</span></label>
    </>
  );
}

function EmptyMail({ title, body, action }: { title: string; body: string; action: ReactNode }) {
  return (
    <section className="panel mail-empty">
      <Mail size={24} />
      <h2>{title}</h2>
      <p>{body}</p>
      {action}
    </section>
  );
}

function splitAddresses(value: string): string[] {
  return value.split(/[,;\n，；]/).map((item) => item.trim()).filter(Boolean);
}