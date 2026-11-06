import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, ExternalLink, Plus, RefreshCw, Trash2, Unplug } from "lucide-react";
import { Fragment, useState, type FormEvent } from "react";
import { EmptyState } from "../components/EmptyState.tsx";
import { SourceItemStatusTag, SourceStatusTag } from "../components/StatusPill.tsx";
import { api } from "../lib/api.ts";
import { abbreviateHash, formatBytes, formatDate, relativeTime } from "../lib/format.ts";
import { SOURCE_KIND_LABELS } from "../lib/labels.ts";
import type { SourceConnection, SourceItem, SourceKind } from "../lib/types.ts";
import { useViewMode } from "../lib/view-mode.tsx";

const SOURCE_KIND_OPTIONS: SourceKind[] = ["knowledge", "file", "web", "email", "calendar"];

interface SourceForm {
  kind: SourceKind;
  displayName: string;
  rootPath: string;
  allowedHosts: string;
  account: string;
}

const EMPTY_FORM: SourceForm = {
  kind: "knowledge",
  displayName: "",
  rootPath: "",
  allowedHosts: "",
  account: ""
};

export function SourcesPage() {
  const queryClient = useQueryClient();
  const { mode } = useViewMode();
  const pro = mode === "pro";
  const [form, setForm] = useState<SourceForm>(EMPTY_FORM);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [webUrls, setWebUrls] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [clearingId, setClearingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const sourcesQuery = useQuery({ queryKey: ["sources"], queryFn: api.sources, refetchInterval: 15_000 });
  const sources = sourcesQuery.data?.sources ?? [];

  const createMutation = useMutation({
    mutationFn: api.createSource,
    onSuccess: async () => {
      setForm(EMPTY_FORM);
      setNotice("来源已连接。");
      setActionError(null);
      await queryClient.invalidateQueries({ queryKey: ["sources"] });
    }
  });

  async function invalidateSources(): Promise<void> {
    await queryClient.invalidateQueries({ queryKey: ["sources"] });
    await queryClient.invalidateQueries({ queryKey: ["sourceItems"] });
  }

  function submitSource(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setActionError(null);
    setNotice(null);
    const rootPath = form.rootPath.trim();
    const allowedHosts = form.allowedHosts.split(/[,，\n]/).map((host) => host.trim()).filter(Boolean);
    const account = form.account.trim();
    const displayName = form.displayName.trim();
    createMutation.mutate({
      kind: form.kind,
      ...(displayName ? { displayName } : {}),
      ...(rootPath ? { rootPath } : {}),
      ...(allowedHosts.length > 0 ? { allowedHosts } : {}),
      ...(account ? { account } : {})
    });
  }

  async function readSource(source: SourceConnection): Promise<void> {
    const url = webUrls[source.id]?.trim();
    if (source.kind === "web" && !url) {
      setExpanded(source.id);
      setActionError("读取网页来源前，先填写要读取的 URL。");
      return;
    }
    setBusyId(source.id);
    setActionError(null);
    setNotice(null);
    try {
      const result = await api.readSource(source.id, url);
      setExpanded(source.id);
      setNotice(result.changed > 0 ? `读取完成，更新了 ${result.changed} 个条目。` : "读取完成，没有发现新内容。");
      await invalidateSources();
    } catch (error) {
      setActionError(errorMessage(error));
      await invalidateSources();
    } finally {
      setBusyId(null);
    }
  }

  async function toggleConnection(source: SourceConnection): Promise<void> {
    setBusyId(source.id);
    setActionError(null);
    setNotice(null);
    try {
      if (source.status === "disconnected") await api.reconnectSource(source.id);
      else await api.disconnectSource(source.id);
      await invalidateSources();
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setBusyId(null);
    }
  }

  async function clearSource(source: SourceConnection): Promise<void> {
    if (clearingId !== source.id) {
      setClearingId(source.id);
      setActionError(null);
      return;
    }
    setClearingId(null);
    setBusyId(source.id);
    setActionError(null);
    setNotice(null);
    try {
      await api.clearSource(source.id);
      setNotice("已清除这个来源保存的读取内容；来源连接仍然保留。");
      await invalidateSources();
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setBusyId(null);
    }
  }

  const createError = createMutation.error ? errorMessage(createMutation.error) : null;

  return (
    <div className="page sources-page">
      <div className="page-head">
        <h1>来源</h1>
        <span className="page-meta">只读读取。每次读取都记录来源、时间和内容校验值。</span>
      </div>

      <section className="panel">
        <div className="panel-head">
          <h2>连接来源</h2>
          <span className="panel-meta">本地目录 / 公开网页</span>
        </div>
        <form className="custom-task-form source-form" onSubmit={submitSource}>
          <div className="source-form-grid">
            <label>
              类型
              <select value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value as SourceKind })}>
                {SOURCE_KIND_OPTIONS.map((kind) => <option key={kind} value={kind}>{SOURCE_KIND_LABELS[kind]}</option>)}
              </select>
            </label>
            <label>
              显示名
              <input value={form.displayName} maxLength={120} placeholder="可选" onChange={(event) => setForm({ ...form, displayName: event.target.value })} />
            </label>
            {(form.kind === "file" || form.kind === "knowledge") && (
              <label className="source-field-wide">
                目录或文件路径
                <input value={form.rootPath} required placeholder="例如 D:\\资料\\团队知识库" onChange={(event) => setForm({ ...form, rootPath: event.target.value })} />
              </label>
            )}
            {form.kind === "web" && (
              <label className="source-field-wide">
                允许的网页主机
                <input value={form.allowedHosts} required placeholder="example.com, docs.example.org" onChange={(event) => setForm({ ...form, allowedHosts: event.target.value })} />
              </label>
            )}
            {(form.kind === "email" || form.kind === "calendar") && (
              <>
                <label>
                  账户
                  <input value={form.account} placeholder="可选" onChange={(event) => setForm({ ...form, account: event.target.value })} />
                </label>
                <p className="source-form-note">当前没有可用的登录凭据，只会记录为“需要你处理”，不会伪造读取结果。</p>
              </>
            )}
          </div>
          <div className="source-form-actions">
            <button className="primary-button" type="submit" disabled={createMutation.isPending}>
              <Plus size={15} /> {createMutation.isPending ? "正在连接…" : "连接来源"}
            </button>
            {createError && <span className="form-error">{createError}</span>}
          </div>
        </form>
      </section>

      {(actionError || notice) && (
        <p className={actionError ? "form-error" : "section-empty"} role="status">{actionError ?? notice}</p>
      )}

      {sourcesQuery.isLoading ? (
        <p className="section-empty">正在读取来源…</p>
      ) : sources.length === 0 ? (
        <section className="panel">
          <EmptyState title="还没有来源" body="连接一个本地目录，或添加允许访问的公开网页主机。" />
        </section>
      ) : (
        <section className="panel table-panel">
          <table className="data-table source-table">
            <thead>
              <tr>
                <th scope="col">来源</th>
                <th scope="col">类型</th>
                <th scope="col">状态</th>
                <th scope="col">范围</th>
                <th scope="col" className="align-num">条目</th>
                <th scope="col">最近读取</th>
                {pro && <th scope="col">提供方</th>}
                <th scope="col">操作</th>
              </tr>
            </thead>
            <tbody>
              {sources.map((source) => {
                const open = expanded === source.id;
                const busy = busyId === source.id;
                return (
                  <Fragment key={source.id}>
                    <tr>
                      <td>
                        <button className="source-name" aria-expanded={open} onClick={() => setExpanded(open ? null : source.id)}>
                          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                          {source.displayName}
                        </button>
                      </td>
                      <td>{SOURCE_KIND_LABELS[source.kind]}</td>
                      <td><SourceStatusTag status={source.status} /></td>
                      <td className="truncate source-scope" title={sourceScope(source)}>{sourceScope(source)}</td>
                      <td className="align-num">{source.itemCount}</td>
                      <td>{source.lastReadAt ? relativeTime(source.lastReadAt) : "未读取"}</td>
                      {pro && <td className="mono">{source.provider}</td>}
                      <td>
                        <div className="source-actions">
                          <button
                            className="link-button"
                            disabled={busy || source.kind === "email" || source.kind === "calendar"}
                            onClick={() => void readSource(source)}
                          >
                            <RefreshCw size={13} className={busy ? "spin" : ""} /> 读取
                          </button>
                          <button className="link-button" disabled={busy} onClick={() => void toggleConnection(source)}>
                            <Unplug size={13} /> {source.status === "disconnected" ? "重连" : "断开"}
                          </button>
                          <button
                            className={`link-button ${clearingId === source.id ? "danger" : ""}`}
                            disabled={busy || source.itemCount === 0}
                            onClick={() => void clearSource(source)}
                          >
                            <Trash2 size={13} /> {clearingId === source.id ? "确认清除" : "清除"}
                          </button>
                        </div>
                      </td>
                    </tr>
                    {open && (
                      <tr className="source-detail-row">
                        <td colSpan={pro ? 8 : 7}>
                          <SourceDetail
                            source={source}
                            pro={pro}
                            webUrl={webUrls[source.id] ?? ""}
                            onWebUrlChange={(url) => setWebUrls({ ...webUrls, [source.id]: url })}
                            onRead={() => void readSource(source)}
                            busy={busy}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

function SourceDetail({
  source,
  pro,
  webUrl,
  onWebUrlChange,
  onRead,
  busy
}: {
  source: SourceConnection;
  pro: boolean;
  webUrl: string;
  onWebUrlChange: (url: string) => void;
  onRead: () => void;
  busy: boolean;
}) {
  const itemsQuery = useQuery({
    queryKey: ["sourceItems", source.id],
    queryFn: () => api.sourceItems(source.id),
    enabled: source.itemCount > 0
  });
  const items = itemsQuery.data?.items ?? [];

  return (
    <div className="source-detail">
      <dl className="kv-grid source-detail-meta">
        <div><dt>权限</dt><dd>只读；不会发送、修改或删除来源内容</dd></div>
        <div><dt>连接时间</dt><dd>{formatDate(source.createdAt)}</dd></div>
        <div><dt>最近读取</dt><dd>{formatDate(source.lastReadAt)}</dd></div>
        {source.account && <div><dt>账户</dt><dd>{source.account}</dd></div>}
        {source.rootPath && <div><dt>根路径</dt><dd className="mono select-all">{source.rootPath}</dd></div>}
        {source.allowedHosts.length > 0 && <div><dt>允许主机</dt><dd className="mono">{source.allowedHosts.join("、")}</dd></div>}
        {pro && <div><dt>提供方 ID</dt><dd className="mono">{source.provider}</dd></div>}
        {pro && <div><dt>来源 ID</dt><dd className="mono select-all">{source.id}</dd></div>}
      </dl>

      {source.lastError && (
        <p className="form-error">{source.lastError.code} · {source.lastError.message}</p>
      )}

      {source.kind === "web" && source.status !== "disconnected" && (
        <div className="source-read-row">
          <label>
            要读取的公开网页
            <input
              value={webUrl}
              placeholder={`https://${source.allowedHosts[0] ?? "example.com"}/page`}
              onChange={(event) => onWebUrlChange(event.target.value)}
            />
          </label>
          <button className="ghost-button" disabled={busy} onClick={onRead}>
            <RefreshCw size={14} className={busy ? "spin" : ""} /> 读取这个网页
          </button>
        </div>
      )}

      {itemsQuery.isLoading ? (
        <p className="section-empty">正在读取条目…</p>
      ) : items.length === 0 ? (
        <p className="section-empty">还没有读取内容。点击读取后，这里会列出实际读到的条目。</p>
      ) : (
        <table className="data-table source-item-table">
          <thead>
            <tr>
              <th scope="col">条目</th>
              <th scope="col">状态</th>
              {pro && <th scope="col">位置</th>}
              {pro && <th scope="col">SHA-256</th>}
              {pro && <th scope="col" className="align-num">大小</th>}
              <th scope="col">读取时间</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td>
                  {item.status === "ready" ? (
                    <button className="link-button" onClick={() => window.open(api.sourceContentUrl(source.id, item.id), "_blank", "noopener")}>
                      {item.label} <ExternalLink size={12} />
                    </button>
                  ) : item.label}
                  {item.error && <small className="source-item-error">{item.error.message}</small>}
                </td>
                <td><SourceItemStatusTag status={item.status} /></td>
                {pro && <td className="mono truncate" title={item.locator}>{item.locator}</td>}
                {pro && <td className="mono tiny" title={item.contentHash ?? undefined}>{item.contentHash ? abbreviateHash(item.contentHash, 12, 6) : "—"}</td>}
                {pro && <td className="align-num">{formatBytes(item.bytes)}</td>}
                <td>{relativeTime(item.fetchedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function sourceScope(source: SourceConnection): string {
  if (source.rootPath) return source.rootPath;
  if (source.allowedHosts.length > 0) return source.allowedHosts.join("、");
  return source.account ?? "未配置";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
