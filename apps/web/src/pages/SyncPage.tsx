import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowDownToLine, Check, Copy, KeyRound, RefreshCw, ShieldOff } from "lucide-react";
import { useState } from "react";
import { EmptyState } from "../components/EmptyState.tsx";
import { api } from "../lib/api.ts";
import { formatDate, relativeTime } from "../lib/format.ts";
import type { SyncConflict, SyncPeerView } from "../lib/types.ts";

const PEER_STATUS_LABELS: Record<SyncPeerView["status"], string> = {
  active: "可用",
  revoked: "已撤销",
  error: "同步出错"
};

const ENTITY_LABELS: Record<string, string> = {
  task: "任务",
  memory: "记忆",
  method: "方法"
};

export function SyncPage() {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("http://127.0.0.1:4317");
  const [token, setToken] = useState("");
  const [issuedToken, setIssuedToken] = useState<{ name: string; token: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyPeerId, setBusyPeerId] = useState<string | null>(null);
  const snapshotQuery = useQuery({ queryKey: ["sync"], queryFn: api.sync, refetchInterval: 15_000 });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["sync"] });
  const snapshot = snapshotQuery.data;
  const pendingConflicts = (snapshot?.conflicts ?? []).filter((conflict) => conflict.status === "pending");

  const createMutation = useMutation({
    mutationFn: () => api.createSyncPeer({
      name: name.trim(),
      baseUrl: baseUrl.trim(),
      ...(token.trim() ? { token: token.trim() } : {})
    }),
    onSuccess: (result) => {
      setIssuedToken({ name: result.peer.name, token: result.token });
      setName("");
      setToken("");
      setNotice("同步对端已登记。令牌只显示这一次，请通过安全渠道交给对应设备。");
      refresh();
    },
    onError: (error: Error) => setNotice(error.message)
  });

  async function runPeerAction(id: string, action: () => Promise<unknown>, success: string) {
    setBusyPeerId(id);
    setNotice(null);
    try {
      await action();
      setNotice(success);
      refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyPeerId(null);
    }
  }

  const rotateMutation = useMutation({
    mutationFn: (peer: SyncPeerView) => api.rotateSyncPeer(peer.id),
    onSuccess: (result) => {
      setIssuedToken({ name: result.peer.name, token: result.token });
      setNotice("令牌已轮换；旧令牌立即失效。新令牌只显示这一次。");
      refresh();
    },
    onError: (error: Error) => setNotice(error.message)
  });

  const resolveMutation = useMutation({
    mutationFn: ({ id, resolution }: { id: string; resolution: "local" | "remote" }) => api.resolveSyncConflict(id, resolution),
    onSuccess: (conflict) => {
      setNotice(conflict.status === "remote" ? "冲突已采用远端版本。" : "冲突已保留本机版本。");
      void queryClient.invalidateQueries({ queryKey: ["tasks"] });
      void queryClient.invalidateQueries({ queryKey: ["memory"] });
      void queryClient.invalidateQueries({ queryKey: ["methods"] });
      refresh();
    },
    onError: (error: Error) => setNotice(error.message)
  });

  return (
    <div className="page sync-page">
      <div className="page-head">
        <h1>设备同步</h1>
        <span className="page-meta">只同步任务、普通记忆与可复用方法；审批、来源、发件箱和设备控制不会跨实例复制。</span>
      </div>

      {snapshotQuery.isError && <p className="form-error">{snapshotQuery.error.message}</p>}
      {notice && <p className="page-meta">{notice}</p>}

      <section className="panel">
        <div className="panel-head">
          <h2>本实例</h2>
          <span className="panel-meta">事件游标 {snapshot?.latestSeq ?? "读取中"}</span>
        </div>
        <dl className="kv-grid">
          <div><dt>实例 ID</dt><dd className="mono select-all">{snapshot?.instanceId ?? "读取中"}</dd></div>
          <div><dt>同步范围</dt><dd>任务状态、产物元数据、普通记忆、方法候选与冲突记录</dd></div>
          <div><dt>安全边界</dt><dd>令牌只以哈希和加密密文保存在本机；列表和浏览器不读取原始凭据</dd></div>
        </dl>
      </section>

      <section className="panel">
        <div className="panel-head"><h2>添加同步对端</h2><span className="panel-meta">增量拉取，不覆盖较新的本机状态</span></div>
        <div className="sync-form-grid">
          <label>设备名称<input value={name} placeholder="例如：办公室电脑" onChange={(event) => setName(event.target.value)} /></label>
          <label>对端地址<input value={baseUrl} placeholder="http://127.0.0.1:4317" onChange={(event) => setBaseUrl(event.target.value)} /></label>
          <label className="sync-field-wide">对端令牌（可选）<input value={token} type="password" placeholder="留空则生成供对端拉取本实例的令牌" onChange={(event) => setToken(event.target.value)} /></label>
        </div>
        <div className="sync-form-actions">
          <button className="primary-button" disabled={!name.trim() || !baseUrl.trim() || createMutation.isPending} onClick={() => createMutation.mutate()}>
            <KeyRound size={15} /> {token.trim() ? "登记对端" : "生成一次性令牌"}
          </button>
          <span className="page-meta">填写对方令牌时，本机主动从该地址拉取；留空时生成令牌交给对方登记。</span>
        </div>
      </section>

      {issuedToken && (
        <section className="panel sync-token-panel">
          <div className="panel-head"><h2>只显示一次的令牌</h2><span className="panel-meta">{issuedToken.name}</span></div>
          <div className="sync-token-row">
            <code className="select-all">{issuedToken.token}</code>
            <button className="ghost-button" onClick={() => void copyToken(issuedToken.token, setNotice)}><Copy size={14} /> 复制</button>
          </div>
          <p className="page-meta">关闭后无法再次查看；如果丢失，请轮换令牌并更新对端。</p>
        </section>
      )}

      <section className="panel table-panel">
        <div className="panel-head"><h2>同步对端</h2><span className="panel-meta">{snapshot?.peers.length ?? 0} 个</span></div>
        {snapshotQuery.isLoading ? (
          <p className="section-empty">正在读取同步对端…</p>
        ) : (snapshot?.peers.length ?? 0) === 0 ? (
          <EmptyState title="还没有同步对端" body="先在另一台实例创建一次性令牌，再回到这里登记地址与令牌。同步不会自动启用外部执行。" />
        ) : (
          <table className="data-table sync-peer-table">
            <thead><tr><th>设备</th><th>状态</th><th>游标</th><th>最近拉取</th><th>最近错误</th><th>操作</th></tr></thead>
            <tbody>
              {snapshot?.peers.map((peer) => (
                <tr key={peer.id}>
                  <td><strong>{peer.name}</strong><small className="sync-peer-url">{peer.baseUrl}</small></td>
                  <td><span className={"tag sync-status-" + peer.status}>{PEER_STATUS_LABELS[peer.status]}</span></td>
                  <td className="mono">{peer.lastPullSeq}</td>
                  <td title={formatDate(peer.lastPullAt)}>{peer.lastPullAt ? relativeTime(peer.lastPullAt) : "尚未拉取"}</td>
                  <td className="sync-peer-error">{peer.lastError ?? "—"}</td>
                  <td>
                    <div className="sync-peer-actions">
                      <button className="ghost-button" disabled={peer.status !== "active" || busyPeerId === peer.id} onClick={() => void runPeerAction(peer.id, () => api.pullSyncPeer(peer.id), "已拉取缺失事件。")}>
                        <ArrowDownToLine size={14} /> 拉取
                      </button>
                      <button className="ghost-button" disabled={peer.status === "revoked" || rotateMutation.isPending} onClick={() => {
                        if (window.confirm(`轮换「${peer.name}」的令牌？旧令牌会立即失效。`)) rotateMutation.mutate(peer);
                      }}><RefreshCw size={14} /> 轮换</button>
                      <button className="ghost-button danger" disabled={peer.status === "revoked" || busyPeerId === peer.id} onClick={() => {
                        if (window.confirm(`撤销「${peer.name}」？该设备将立即失去同步访问。`)) {
                          void runPeerAction(peer.id, () => api.revokeSyncPeer(peer.id), "同步对端已撤销。");
                        }
                      }}><ShieldOff size={14} /> 撤销</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel">
        <div className="panel-head"><h2>待处理冲突</h2><span className="panel-meta">{pendingConflicts.length} 个</span></div>
        {pendingConflicts.length === 0 ? (
          <p className="section-empty">没有待处理冲突。远端较旧的变化不会覆盖本机较新的记录。</p>
        ) : (
          <div className="sync-conflict-list">
            {pendingConflicts.map((conflict) => (
              <article className="sync-conflict" key={conflict.id}>
                <div className="sync-conflict-head">
                  <div>
                    <span className="tag"><AlertTriangle size={12} /> {ENTITY_LABELS[conflict.entityType] ?? conflict.entityType}</span>
                    <strong className="mono">{conflict.entityId}</strong>
                  </div>
                  <span className="panel-meta">本机 {formatDate(conflict.localUpdatedAt)} · 远端 {formatDate(conflict.remoteUpdatedAt)}</span>
                </div>
                <p>{describeConflict(conflict)}</p>
                <details><summary>查看两边记录</summary><pre>{JSON.stringify({ local: conflict.localPayload, remote: conflict.remotePayload }, null, 2)}</pre></details>
                <div className="sync-conflict-actions">
                  <button className="ghost-button" disabled={resolveMutation.isPending} onClick={() => resolveMutation.mutate({ id: conflict.id, resolution: "local" })}><Check size={14} /> 保留本机</button>
                  <button className="primary-button" disabled={resolveMutation.isPending} onClick={() => resolveMutation.mutate({ id: conflict.id, resolution: "remote" })}><ArrowDownToLine size={14} /> 采用远端</button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function describeConflict(conflict: SyncConflict): string {
  const local = conflict.localPayload as Record<string, unknown>;
  const remoteEvent = conflict.remotePayload as { payload?: Record<string, unknown> };
  const localLabel = String(local.title ?? local.name ?? local.content ?? local.nextAction ?? "本机版本");
  const remote = remoteEvent.payload ?? {};
  const remoteLabel = String(remote.title ?? remote.name ?? remote.content ?? remote.nextAction ?? "远端版本");
  return `本机：${truncate(localLabel)}；远端：${truncate(remoteLabel)}。请选择保留哪一边，另一边的记录仍保留在事件审计中。`;
}

function truncate(value: string): string {
  return value.length > 90 ? value.slice(0, 90) + "…" : value;
}

async function copyToken(value: string, setNotice: (message: string) => void): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
    setNotice("令牌已复制到剪贴板。");
  } catch {
    setNotice("无法访问剪贴板，请手动选择令牌复制。");
  }
}
