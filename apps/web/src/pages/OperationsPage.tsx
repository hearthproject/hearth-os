import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, Download, FileUp, RefreshCw, ShieldAlert } from "lucide-react";
import { useState } from "react";
import { api } from "../lib/api.ts";
import { formatBytes, formatDate } from "../lib/format.ts";
import type { BackupRestoreResult } from "../lib/types.ts";

export function OperationsPage() {
  const queryClient = useQueryClient();
  const [backupPassphrase, setBackupPassphrase] = useState("");
  const [confirmPassphrase, setConfirmPassphrase] = useState("");
  const [restoreId, setRestoreId] = useState<string | null>(null);
  const [restorePassphrase, setRestorePassphrase] = useState("");
  const [uploadedName, setUploadedName] = useState<string | null>(null);
  const [uploadedEnvelope, setUploadedEnvelope] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [restoreResult, setRestoreResult] = useState<BackupRestoreResult | null>(null);
  const backupsQuery = useQuery({ queryKey: ["backups"], queryFn: api.backups, refetchInterval: 30_000 });
  const snapshot = backupsQuery.data;

  const createMutation = useMutation({
    mutationFn: () => api.createBackup(backupPassphrase),
    onSuccess: (record) => {
      setNotice(`加密备份已创建：${record.id.slice(0, 8)}。请把归档文件和口令分开保管。`);
      setBackupPassphrase("");
      setConfirmPassphrase("");
      void queryClient.invalidateQueries({ queryKey: ["backups"] });
    },
    onError: (error: Error) => setNotice(error.message)
  });

  const restoreMutation = useMutation({
    mutationFn: async () => {
      if (!window.confirm("恢复会用备份内容替换当前任务、记忆、审批和设置。当前数据库会先通过事务回滚保护，但已放行的外部动作无法撤销。继续？")) {
        throw new Error("已取消恢复");
      }
      if (uploadedEnvelope) return api.restoreBackupFile(uploadedEnvelope, restorePassphrase);
      if (!restoreId) throw new Error("请选择本机备份或上传归档文件");
      return api.restoreBackup(restoreId, restorePassphrase);
    },
    onSuccess: (result) => {
      setRestoreResult(result);
      setNotice("恢复完成。执行器保持停止，界面数据需要重新载入。");
      setRestorePassphrase("");
      setUploadedEnvelope(null);
      setUploadedName(null);
      void queryClient.invalidateQueries();
    },
    onError: (error: Error) => setNotice(error.message)
  });

  function submitBackup() {
    setNotice(null);
    if (backupPassphrase !== confirmPassphrase) {
      setNotice("两次输入的口令不一致。");
      return;
    }
    createMutation.mutate();
  }

  async function chooseEnvelope(file: File | null) {
    setRestoreId(null);
    setUploadedEnvelope(null);
    setUploadedName(null);
    if (!file) return;
    try {
      const text = await file.text();
      setUploadedEnvelope(text);
      setUploadedName(file.name);
      setNotice(`已读取 ${file.name}，输入口令后可恢复。`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <div className="page operations-page">
      <div className="page-head">
        <div>
          <h1>备份与运维</h1>
          <p className="page-meta">备份使用口令派生密钥加密；恢复前会在临时数据库执行 schema、完整性与投影校验。</p>
        </div>
        <button className="ghost-button" onClick={() => void backupsQuery.refetch()} disabled={backupsQuery.isFetching}>
          <RefreshCw size={14} className={backupsQuery.isFetching ? "spin" : ""} /> 刷新
        </button>
      </div>

      {backupsQuery.isError && <p className="form-error">{backupsQuery.error.message}</p>}
      {notice && <p className="page-meta">{notice}</p>}

      {restoreResult && (
        <section className="panel backup-restore-result">
          <div className="panel-head"><h2>恢复完成</h2><span className="panel-meta">{formatDate(restoreResult.restoredAt)}</span></div>
          <dl className="kv-grid">
            <div><dt>来源实例</dt><dd className="mono select-all">{restoreResult.sourceInstanceId}</dd></div>
            <div><dt>任务</dt><dd>{restoreResult.counts.tasks ?? 0}</dd></div>
            <div><dt>记忆</dt><dd>{restoreResult.counts.memories ?? 0}</dd></div>
            <div><dt>master key</dt><dd>{restoreResult.masterKeyRestored ? "已恢复" : "未恢复"}</dd></div>
          </dl>
          {restoreResult.warnings.map((warning) => <p className="backup-warning" key={warning}><ShieldAlert size={14} /> {warning}</p>)}
          {restoreResult.schedulerStopped && <p className="page-meta">执行器在恢复前运行，现已停止。确认数据无误后到顶栏手动启动。</p>}
          <button className="primary-button" onClick={() => window.location.reload()}>重新载入界面</button>
        </section>
      )}

      <section className="panel">
        <div className="panel-head"><h2>创建加密备份</h2><span className="panel-meta"><Archive size={12} /> AES-256-GCM · scrypt</span></div>
        <div className="backup-form">
          <label>口令<input type="password" value={backupPassphrase} autoComplete="new-password" placeholder={`至少 ${snapshot?.encryption.minimumPassphraseLength ?? 12} 个字符`} onChange={(event) => setBackupPassphrase(event.target.value)} /></label>
          <label>确认口令<input type="password" value={confirmPassphrase} autoComplete="new-password" onChange={(event) => setConfirmPassphrase(event.target.value)} /></label>
          <button className="primary-button" disabled={createMutation.isPending || backupPassphrase.length < 12} onClick={submitBackup}><Archive size={15} /> 创建备份</button>
        </div>
        <p className="page-meta">口令不会写入数据库。忘记口令后，归档无法恢复；请把口令与归档文件分开保存。</p>
      </section>

      <section className="panel table-panel">
        <div className="panel-head"><h2>本机归档</h2><span className="panel-meta">{snapshot?.records.length ?? 0} 个</span></div>
        {backupsQuery.isLoading ? (
          <p className="section-empty">正在读取备份记录…</p>
        ) : (snapshot?.records.length ?? 0) === 0 ? (
          <p className="section-empty">还没有加密备份。创建后的文件保存在本机 `.hearth/backups/`。</p>
        ) : (
          <table className="data-table">
            <thead><tr><th>创建时间</th><th>大小</th><th>校验值</th><th>操作</th></tr></thead>
            <tbody>
              {snapshot?.records.map((record) => (
                <tr key={record.id}>
                  <td title={formatDate(record.createdAt)}>{formatDate(record.createdAt)}</td>
                  <td>{formatBytes(record.bytes)}</td>
                  <td className="mono backup-hash">{record.sha256.slice(0, 16)}…</td>
                  <td><div className="sync-peer-actions">
                    <a className="ghost-button" href={api.backupDownloadUrl(record.id)}><Download size={14} /> 下载</a>
                    <button className="ghost-button" onClick={() => { setRestoreId(record.id); setUploadedEnvelope(null); setUploadedName(null); setNotice("已选择本机归档，输入口令后可恢复。"); }}>选择恢复</button>
                  </div></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel">
        <div className="panel-head"><h2>恢复备份</h2><span className="panel-meta">{restoreId ? "已选择本机归档" : uploadedName ? `已选择 ${uploadedName}` : "尚未选择归档"}</span></div>
        <div className="backup-restore-grid">
          <label className="backup-file-picker"><FileUp size={16} /> 上传 `.hearth-backup` 文件<input type="file" accept=".hearth-backup,application/json" onChange={(event) => void chooseEnvelope(event.target.files?.[0] ?? null)} /></label>
          <label>恢复口令<input type="password" value={restorePassphrase} autoComplete="current-password" onChange={(event) => setRestorePassphrase(event.target.value)} /></label>
          <button className="primary-button danger" disabled={restoreMutation.isPending || !restorePassphrase || (!restoreId && !uploadedEnvelope)} onClick={() => restoreMutation.mutate()}>恢复并替换当前数据</button>
        </div>
        <p className="page-meta">恢复会清除旧任务租约、配对请求和桌面会话临时记录；当前实例 ID 与全局停止状态会保留。</p>
      </section>

      {snapshot && (
        <section className="panel">
          <div className="panel-head"><h2>归档边界</h2><span className="panel-meta">不把数据库备份称为完整迁移</span></div>
          <div className="backup-scope-grid">
            <div><h3>包含</h3><ul className="plain-list">{snapshot.scope.includes.map((item) => <li key={item}>{item}</li>)}</ul></div>
            <div><h3>不包含</h3><ul className="plain-list">{snapshot.scope.excludes.map((item) => <li key={item}>{item}</li>)}</ul></div>
          </div>
        </section>
      )}
    </div>
  );
}

