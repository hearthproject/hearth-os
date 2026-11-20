import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  Archive,
  Check,
  Copy,
  Database,
  Download,
  FileDown,
  FileUp,
  FolderTree,
  HardDrive,
  Loader2,
  Play,
  ShieldAlert,
  Trash2
} from "lucide-react";
import { api } from "../lib/api.ts";
import { formatBytes, formatDate, formatDuration, formatNumber, relativeTime } from "../lib/format.ts";
import type { BackupRestoreResult, TrashItem, TrashKind } from "../lib/types.ts";
import { SecuritySettingsPanel } from "./SecuritySettingsPanel.tsx";

const MAINTENANCE_ACTION_LABELS: Record<string, string> = {
  approvalsExpired: "过期审批",
  tasksRecovered: "恢复任务",
  leasesExpired: "过期租约",
  commandsExpired: "过期桌面命令",
  framesExpired: "过期截图",
  frameFilesRemoved: "删除截图文件",
  frameFileErrors: "截图文件失败",
  pairingsExpired: "过期配对",
  temporaryFilesRemoved: "临时文件",
  maintenanceRunsPruned: "修剪维护记录"
};

const SQLITE_TABLES: Array<{ name: string; text: string }> = [
  { name: "app_settings", text: "聊天模型、界面键值和注册表更新时间" },
  { name: "model_profiles", text: "模型供应商、协议、地址与加密 API Key" },
  { name: "executor_model_bindings", text: "执行器与模型档案的绑定和覆盖" },
  { name: "settings_migrations", text: "旧 JSON 迁移状态、源路径和备份路径" },
  { name: "context_items / context_summaries", text: "统一上下文账本与任务摘要" },
  { name: "handoffs / diagnoses", text: "执行器接管记录与模型诊断证据" }
];

type Notice = { tone: "ok" | "error" | "info"; text: string } | null;

export function DataSettingsPanel() {
  return (
    <section className="settings-tab-panel data-panel">
      <StorageSection />
      <BackupSection />
      <MaintenanceSection />
      <TrashSection />
      <SecuritySettingsPanel />
    </section>
  );
}

function StorageSection() {
  const storageQuery = useQuery({ queryKey: ["settingsStorage"], queryFn: api.settingsStorage });
  const healthQuery = useQuery({ queryKey: ["health"], queryFn: api.health, refetchInterval: 30_000 });
  const backupsQuery = useQuery({ queryKey: ["backups"], queryFn: api.backups, refetchInterval: 30_000 });
  const trashQuery = useQuery({ queryKey: ["trash", "summary"], queryFn: () => api.trash({}), refetchInterval: 30_000 });
  const storage = storageQuery.data;
  const health = healthQuery.data;
  const [copyState, setCopyState] = useState<"idle" | "ok" | "error">("idle");

  async function copyDataDir() {
    if (!storage) return;
    try {
      await navigator.clipboard.writeText(storage.dataDir);
      setCopyState("ok");
    } catch {
      setCopyState("error");
    }
    window.setTimeout(() => setCopyState("idle"), 1_800);
  }

  return (
    <section className="settings-section">
      <div className="data-overview">
        <div>
          <span><Database size={13} /> 数据库</span>
          <strong>{health ? formatBytes(health.disk.dataBytes + health.disk.walBytes) : "—"}</strong>
          <small>{health ? `WAL ${formatBytes(health.disk.walBytes)}` : "读取中"}</small>
        </div>
        <div>
          <span><HardDrive size={13} /> 可用磁盘</span>
          <strong>{health?.disk.freeBytes == null ? "—" : formatBytes(health.disk.freeBytes)}</strong>
          <small>本机磁盘余量</small>
        </div>
        <div>
          <span><Archive size={13} /> 加密备份</span>
          <strong>{backupsQuery.data ? `${backupsQuery.data.records.length} 个` : "—"}</strong>
          <small>本机归档</small>
        </div>
        <div>
          <span><Trash2 size={13} /> 回收站</span>
          <strong>{trashQuery.data ? `${trashQuery.data.items.length} 项` : "—"}</strong>
          <small>可恢复或彻底删除</small>
        </div>
      </div>

      <div className="section-heading">
        <div><h3>存储位置</h3><p>所有运行时数据都在这个目录下。</p></div>
        {storage && (
          <button className="ghost-button compact" type="button" onClick={() => void copyDataDir()}>
            {copyState === "ok" ? <Check size={13} /> : <Copy size={13} />}
            {copyState === "ok" ? "已复制" : copyState === "error" ? "复制失败" : "复制路径"}
          </button>
        )}
      </div>

      {storageQuery.isLoading && <p className="data-note"><Loader2 size={13} className="spin" /> 正在读取存储信息</p>}
      {storageQuery.isError && <p className="form-error">{storageQuery.error.message}</p>}
      {storage && (
        <>
          <div className="data-path">
            <FolderTree size={14} />
            <code>{storage.dataDir}</code>
            <span className="data-path-meta">schema v{storage.schemaVersion}</span>
          </div>

          <dl className="data-locations">
            <div>
              <dt>SQLite 数据库 <small>设置、任务与事件索引</small></dt>
              <dd><code>{relativeTo(storage.dataDir, storage.paths.database)}</code></dd>
            </div>
            <div>
              <dt>执行器运行时 <small>Codex 与 DeepSeek Harness 独立 home</small></dt>
              <dd><code>{relativeTo(storage.dataDir, storage.paths.executors)}</code></dd>
            </div>
            <div>
              <dt>上下文 Blob <small>大段正文，内容寻址</small></dt>
              <dd><code>{relativeTo(storage.dataDir, storage.paths.contextBlobs)}</code></dd>
            </div>
            <div>
              <dt>加密备份 <small>口令派生密钥的本机归档</small></dt>
              <dd><code>{relativeTo(storage.dataDir, storage.paths.backups)}</code></dd>
            </div>
            <div>
              <dt>附件 <small>聊天与任务附件</small></dt>
              <dd><code>{relativeTo(storage.dataDir, storage.paths.attachments)}</code></dd>
            </div>
          </dl>

          <details className="data-disclosure">
            <summary><Database size={13} /> 数据库表与旧设置迁移</summary>
            <div className="data-disclosure-body">
              <div className="data-advanced-block">
                <h4>SQLite 设置表</h4>
                <p className="data-note">运行时以 SQLite 为唯一事实来源，旧 JSON 只在迁移时读取。</p>
                <div className="data-row-list">
                  {SQLITE_TABLES.map((table) => (
                    <div className="data-row" key={table.name}>
                      <code>{table.name}</code>
                      <span>{table.text}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="data-advanced-block">
                <h4>旧设置迁移</h4>
                <div className="data-row-list">
                  <div className="data-row"><span>旧模型设置</span><code>{storage.legacy.modelSettings}</code></div>
                  <div className="data-row"><span>旧执行器设置</span><code>{storage.legacy.executorSettings}</code></div>
                </div>
                {storage.migrations.length === 0 ? (
                  <p className="data-note">没有迁移记录；这是干净的 SQLite 配置。</p>
                ) : (
                  <div className="data-row-list">
                    {storage.migrations.map((migration) => (
                      <div className="data-row" key={migration.id}>
                        <code>{migration.sourcePath}</code>
                        <span className={`status-chip ${migration.status === "completed" ? "ok" : "warn"}`}>{migration.status}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </details>
        </>
      )}
    </section>
  );
}

function BackupSection() {
  const queryClient = useQueryClient();
  const backupsQuery = useQuery({ queryKey: ["backups"], queryFn: api.backups, refetchInterval: 30_000 });
  const snapshot = backupsQuery.data;
  const [passphrase, setPassphrase] = useState("");
  const [confirmPassphrase, setConfirmPassphrase] = useState("");
  const [restoreId, setRestoreId] = useState<string | null>(null);
  const [restorePassphrase, setRestorePassphrase] = useState("");
  const [uploadedName, setUploadedName] = useState<string | null>(null);
  const [uploadedEnvelope, setUploadedEnvelope] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [restoreResult, setRestoreResult] = useState<BackupRestoreResult | null>(null);
  const restoreRef = useRef<HTMLDetailsElement | null>(null);
  const minimumLength = snapshot?.encryption.minimumPassphraseLength ?? 12;

  const createMutation = useMutation({
    mutationFn: () => api.createBackup(passphrase),
    onSuccess: (record) => {
      setNotice({ tone: "ok", text: `加密备份已创建：${record.id.slice(0, 8)}。请把归档和口令分开保管。` });
      setPassphrase("");
      setConfirmPassphrase("");
      void queryClient.invalidateQueries({ queryKey: ["backups"] });
    },
    onError: (error: Error) => setNotice({ tone: "error", text: error.message })
  });

  const restoreMutation = useMutation({
    mutationFn: async () => {
      if (uploadedEnvelope) return api.restoreBackupFile(uploadedEnvelope, restorePassphrase);
      if (!restoreId) throw new Error("请选择本机备份或上传归档文件");
      return api.restoreBackup(restoreId, restorePassphrase);
    },
    onSuccess: (result) => {
      setRestoreResult(result);
      setNotice({ tone: "ok", text: "恢复完成。执行器保持停止，界面数据需要重新载入。" });
      setRestorePassphrase("");
      setUploadedEnvelope(null);
      setUploadedName(null);
      setRestoreId(null);
      void queryClient.invalidateQueries();
    },
    onError: (error: Error) => setNotice({ tone: "error", text: error.message })
  });

  function submitBackup() {
    setNotice(null);
    if (passphrase !== confirmPassphrase) {
      setNotice({ tone: "error", text: "两次输入的口令不一致。" });
      return;
    }
    createMutation.mutate();
  }

  function submitRestore() {
    if (!window.confirm("恢复会用备份内容替换当前任务、审批和设置。当前数据库有事务回滚保护，但已放行的外部动作无法撤销。继续？")) return;
    restoreMutation.mutate();
  }

  function chooseArchive(recordId: string) {
    setRestoreId(recordId);
    setUploadedEnvelope(null);
    setUploadedName(null);
    setNotice({ tone: "info", text: "已选择本机归档，输入口令后可恢复。" });
    if (restoreRef.current) restoreRef.current.open = true;
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
      setNotice({ tone: "info", text: `已读取 ${file.name}，输入口令后可恢复。` });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    }
  }

  const records = snapshot?.records ?? [];

  return (
    <section className="settings-section">
      <div className="section-heading">
        <div><h3>备份与恢复</h3><p>备份使用口令派生密钥加密；恢复前会校验 schema、完整性和投影。</p></div>
        <span className="muted-count">{records.length} 个归档</span>
      </div>

      {backupsQuery.isError && <p className="form-error">{backupsQuery.error.message}</p>}
      {backupsQuery.isLoading && <p className="data-note"><Loader2 size={13} className="spin" /> 正在读取备份记录</p>}
      <DataNotice notice={notice} />

      <div className="data-inline-form">
        <label className="data-field">
          <span>口令</span>
          <input
            type="password"
            value={passphrase}
            autoComplete="new-password"
            placeholder={`至少 ${minimumLength} 个字符`}
            onChange={(event) => setPassphrase(event.target.value)}
          />
        </label>
        <label className="data-field">
          <span>确认口令</span>
          <input
            type="password"
            value={confirmPassphrase}
            autoComplete="new-password"
            onChange={(event) => setConfirmPassphrase(event.target.value)}
          />
        </label>
        <button
          className="primary-button"
          type="button"
          disabled={createMutation.isPending || passphrase.length < minimumLength}
          onClick={submitBackup}
        >
          {createMutation.isPending ? <Loader2 size={14} className="spin" /> : <Archive size={14} />} 创建备份
        </button>
      </div>
      <p className="data-note">口令不会写入数据库；忘记口令后归档无法恢复，请与归档文件分开保存。</p>

      {!backupsQuery.isLoading && records.length === 0 && (
        <p className="data-empty">还没有加密备份。创建后的文件保存在本机 <code>.hearth/backups/</code>。</p>
      )}
      {records.length > 0 && (
        <div className="data-archive-list">
          {records.map((record) => (
            <div className="data-archive-row" key={record.id}>
              <span className="data-archive-time" title={formatDate(record.createdAt)}>{formatDate(record.createdAt)}</span>
              <span className="data-archive-size">{formatBytes(record.bytes)}</span>
              <code className="data-archive-hash">{record.sha256.slice(0, 12)}…</code>
              <div className="data-archive-actions">
                <a className="ghost-button compact" href={api.backupDownloadUrl(record.id)}><Download size={13} /> 下载</a>
                <button className="ghost-button compact" type="button" onClick={() => chooseArchive(record.id)}>恢复</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {restoreResult && (
        <div className="data-result">
          <div className="data-result-head">
            <strong><Check size={14} /> 恢复完成</strong>
            <span>{formatDate(restoreResult.restoredAt)}</span>
          </div>
          <dl>
            <div><dt>来源实例</dt><dd className="mono">{restoreResult.sourceInstanceId.slice(0, 12)}</dd></div>
            <div><dt>任务</dt><dd>{restoreResult.counts.tasks ?? 0}</dd></div>
            <div><dt>记忆</dt><dd>{restoreResult.counts.memories ?? 0}</dd></div>
            <div><dt>Master key</dt><dd>{restoreResult.masterKeyRestored ? "已恢复" : "未恢复"}</dd></div>
          </dl>
          {restoreResult.warnings.map((warning) => <p className="data-issue" key={warning}><ShieldAlert size={13} /> {warning}</p>)}
          {restoreResult.schedulerStopped && <p className="data-note">执行器在恢复前运行，现已停止。确认数据无误后在顶栏手动启动。</p>}
          <button className="primary-button" type="button" onClick={() => window.location.reload()}>重新载入界面</button>
        </div>
      )}

      <details className="data-disclosure" ref={(node) => { restoreRef.current = node; }}>
        <summary>
          <FileUp size={13} /> 从归档恢复
          <span className="data-disclosure-meta">{restoreId ? "已选择本机归档" : uploadedName ? `已选择 ${uploadedName}` : "尚未选择"}</span>
        </summary>
        <div className="data-disclosure-body">
          <div className="data-inline-form">
            <label className="data-file-field">
              <FileUp size={14} /> 上传 <code>.hearth-backup</code>
              <input type="file" accept=".hearth-backup,application/json" onChange={(event) => void chooseEnvelope(event.target.files?.[0] ?? null)} />
            </label>
            <label className="data-field">
              <span>恢复口令</span>
              <input
                type="password"
                value={restorePassphrase}
                autoComplete="current-password"
                onChange={(event) => setRestorePassphrase(event.target.value)}
              />
            </label>
            <button
              className="primary-button danger"
              type="button"
              disabled={restoreMutation.isPending || !restorePassphrase || (!restoreId && !uploadedEnvelope)}
              onClick={submitRestore}
            >
              {restoreMutation.isPending ? <Loader2 size={14} className="spin" /> : null} 恢复并替换
            </button>
          </div>
          <p className="data-note">恢复会清理旧任务租约、配对请求和桌面会话临时记录；当前实例 ID 与全局停止状态会保留。</p>
        </div>
      </details>

      {snapshot && (
        <details className="data-disclosure">
          <summary><Archive size={13} /> 归档边界</summary>
          <div className="data-scope">
            <div>
              <h4>包含</h4>
              <ul>{snapshot.scope.includes.map((item) => <li key={item}>{item}</li>)}</ul>
            </div>
            <div>
              <h4>不包含</h4>
              <ul>{snapshot.scope.excludes.map((item) => <li key={item}>{item}</li>)}</ul>
            </div>
          </div>
        </details>
      )}
    </section>
  );
}

function MaintenanceSection() {
  const queryClient = useQueryClient();
  const healthQuery = useQuery({ queryKey: ["health"], queryFn: api.health, refetchInterval: 20_000 });
  const maintenanceQuery = useQuery({ queryKey: ["maintenance"], queryFn: api.maintenance, refetchInterval: 20_000 });
  const [notice, setNotice] = useState<Notice>(null);
  const health = healthQuery.data;
  const maintenance = maintenanceQuery.data;

  const maintenanceMutation = useMutation({
    mutationFn: api.runMaintenance,
    onSuccess: (run) => {
      if (!run) return;
      const changed = Object.values(run.actions).reduce((sum, count) => sum + count, 0);
      setNotice({ tone: "ok", text: `维护完成：处理 ${changed} 项过期临时状态，任务、记忆和产物没有被删除。` });
      void queryClient.invalidateQueries({ queryKey: ["maintenance"] });
      void queryClient.invalidateQueries({ queryKey: ["health"] });
      void queryClient.invalidateQueries({ queryKey: ["tasks"] });
      void queryClient.invalidateQueries({ queryKey: ["trash"] });
    },
    onError: (error: Error) => setNotice({ tone: "error", text: error.message })
  });

  const lastActions = maintenance?.latest
    ? Object.entries(maintenance.latest.actions).filter(([, count]) => count > 0)
    : [];
  const lastActionTotal = lastActions.reduce((sum, [, count]) => sum + count, 0);

  return (
    <section className="settings-section">
      <div className="section-heading">
        <div><h3>运行与维护</h3><p>维护只清理过期临时状态，不会删除任务、记忆或产物。</p></div>
        <span className={`status-chip ${health?.status === "ok" ? "ok" : ""}`}>
          <span className={`status-dot ${health?.status === "ok" ? "online" : "idle"}`} />
          {health ? (health.status === "ok" ? "运行正常" : "需要关注") : "读取中"}
        </span>
      </div>

      {healthQuery.isError && <p className="form-error">{healthQuery.error.message}</p>}
      {health && (
        <>
          <div className="data-health">
            <div>
              <span>运行时长</span>
              <strong>{formatDuration(health.uptimeSeconds * 1000)}</strong>
            </div>
            <div>
              <span>内存</span>
              <strong>{formatBytes(health.memory.rssBytes)}</strong>
              <small>堆 {formatBytes(health.memory.heapUsedBytes)} / {formatBytes(health.memory.heapTotalBytes)}</small>
            </div>
            <div>
              <span>任务</span>
              <strong>{formatNumber(health.tasks.total)}</strong>
              <small>排队 {health.tasks.queued} · 运行 {health.tasks.running} · 待审批 {health.tasks.waitingApproval} · 可恢复 {health.tasks.recoverable}</small>
            </div>
            <div>
              <span>执行器</span>
              <strong className="data-health-text">{health.scheduler.enabled ? (health.scheduler.running ? "已启用" : "已停止") : "未启用"}</strong>
              <small>全局停止 {health.security.killSwitch ? "已启用" : "未启用"}</small>
            </div>
          </div>
          {health.issues.length > 0 && (
            <div className="data-issues">
              {health.issues.map((issue) => <p className="data-issue" key={issue}><ShieldAlert size={13} /> {issue}</p>)}
            </div>
          )}
        </>
      )}

      <div className="data-actions">
        <button
          className="primary-button"
          type="button"
          disabled={maintenanceMutation.isPending || maintenance?.running}
          onClick={() => maintenanceMutation.mutate()}
        >
          {maintenanceMutation.isPending ? <Loader2 size={14} className="spin" /> : <Play size={14} />} 立即维护
        </button>
        <a className="ghost-button" href={api.diagnosticsUrl}><FileDown size={14} /> 下载脱敏诊断</a>
        <span className="data-actions-meta">
          {maintenance?.latest
            ? `上次维护 ${relativeTime(maintenance.latest.startedAt)} · ${maintenance.latest.status}`
            : "还没有维护记录"}
        </span>
      </div>

      <DataNotice notice={notice} />

      {maintenance && (
        <>
          <div className="data-maintenance">
            {!maintenance.latest ? (
              <p className="data-note">还没有维护记录；首次自动维护会在启动后 6 小时内运行。</p>
            ) : lastActions.length === 0 ? (
              <p className="data-note">最近一次维护没有需要清理的过期状态。</p>
            ) : (
              <>
                <span className="data-note">最近一次维护处理 {lastActionTotal} 项：</span>
                <div className="data-chips">
                  {lastActions.map(([key, count]) => (
                    <span className="tag" key={key}>{MAINTENANCE_ACTION_LABELS[key] ?? key} {count}</span>
                  ))}
                </div>
              </>
            )}
          </div>
          {maintenance.latest?.error && <p className="data-issue"><ShieldAlert size={13} /> {maintenance.latest.error}</p>}
          <p className="data-note">
            启动后每 6 小时自动维护一次，记录保留最近 {maintenance.policy.keptRuns} 条；命令超时 {maintenance.policy.claimedCommandTtlMinutes} 分钟，临时文件超过 {maintenance.policy.temporaryFileTtlHours} 小时清理。
          </p>
          {maintenance.runs.length > 1 && (
            <details className="data-disclosure">
              <summary><Activity size={13} /> 最近 {maintenance.runs.length} 次维护</summary>
              <div className="data-disclosure-body">
                <table className="data-table">
                  <thead><tr><th>开始</th><th>状态</th><th>处理项</th><th>错误</th></tr></thead>
                  <tbody>
                    {maintenance.runs.slice(1).map((run) => (
                      <tr key={run.id}>
                        <td title={formatDate(run.startedAt)}>{relativeTime(run.startedAt)}</td>
                        <td><span className="tag">{run.status}</span></td>
                        <td>{Object.values(run.actions).reduce((sum, count) => sum + count, 0)}</td>
                        <td>{run.error ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
        </>
      )}
    </section>
  );
}

function TrashSection() {
  const queryClient = useQueryClient();
  const [olderThanDays, setOlderThanDays] = useState<7 | 15 | 30 | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<Notice>(null);
  const trashQuery = useQuery({
    queryKey: ["trash", olderThanDays ?? "all"],
    queryFn: () => api.trash(olderThanDays ? { olderThanDays } : {}),
    refetchInterval: 30_000
  });
  const items = trashQuery.data?.items ?? [];
  const selectedItems = items.filter((item) => selected.has(trashKey(item)));

  function toggle(item: TrashItem) {
    const key = trashKey(item);
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function restoreSelected() {
    if (selectedItems.length === 0) return;
    setNotice(null);
    try {
      await api.restoreTrash(selectedItems.map(({ kind, id }) => ({ kind, id })));
      setSelected(new Set());
      setNotice({ tone: "ok", text: `已恢复 ${selectedItems.length} 个项目` });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["trash"] }),
        queryClient.invalidateQueries({ queryKey: ["conversations"] }),
        queryClient.invalidateQueries({ queryKey: ["tasks"] })
      ]);
    } catch (caught) {
      setNotice({ tone: "error", text: caught instanceof Error ? caught.message : "恢复失败" });
    }
  }

  async function purgeSelected() {
    if (selectedItems.length === 0) return;
    if (!window.confirm(`要彻底删除所选的 ${selectedItems.length} 个项目吗？此操作不能撤销。`)) return;
    if (!window.confirm("再次确认：数据库记录、受管工作区和产物将被永久移除。")) return;
    setNotice(null);
    try {
      const result = await api.purgeTrash(selectedItems.map(({ kind, id }) => ({ kind, id })));
      setSelected(new Set());
      setNotice({
        tone: "ok",
        text: `已彻底删除 ${result.purgedConversations} 个对话、${result.purgedTasks} 个任务，并清理 ${result.removedAttachments} 个孤立附件`
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["trash"] }),
        queryClient.invalidateQueries({ queryKey: ["conversations"] }),
        queryClient.invalidateQueries({ queryKey: ["tasks"] })
      ]);
    } catch (caught) {
      setNotice({ tone: "error", text: caught instanceof Error ? caught.message : "彻底删除失败" });
    }
  }

  return (
    <section className="settings-section">
      <div className="section-heading">
        <div><h3>回收站</h3><p>只恢复经 Hearth 删除的对话和任务；直接删除的文件不会进入回收站。</p></div>
        <span className="muted-count">{items.length} 项</span>
      </div>

      <div className="data-toolbar">
        <label className="data-field compact">
          <span>删除时间</span>
          <select
            value={olderThanDays ?? ""}
            onChange={(event) => {
              setSelected(new Set());
              setOlderThanDays(event.target.value ? Number(event.target.value) as 7 | 15 | 30 : null);
            }}
          >
            <option value="">全部</option>
            <option value="7">7 天以前</option>
            <option value="15">15 天以前</option>
            <option value="30">30 天以前</option>
          </select>
        </label>
        <div className="data-toolbar-actions">
          <button className="ghost-button compact" type="button" onClick={() => void restoreSelected()} disabled={selectedItems.length === 0}>恢复所选</button>
          <button className="ghost-button compact danger" type="button" onClick={() => void purgeSelected()} disabled={selectedItems.length === 0}>彻底删除</button>
        </div>
      </div>

      {trashQuery.isLoading && <p className="data-note"><Loader2 size={13} className="spin" /> 正在读取回收站</p>}
      {!trashQuery.isLoading && items.length === 0 && <p className="data-empty">回收站是空的。</p>}
      {items.length > 0 && (
        <div className="data-trash-list">
          {items.map((item) => (
            <label key={trashKey(item)} className="data-trash-row">
              <input type="checkbox" checked={selected.has(trashKey(item))} onChange={() => toggle(item)} />
              <span className="data-trash-kind">{item.kind === "conversation" ? "对话" : "任务"}</span>
              <span className="data-trash-title">{item.title}</span>
              <time>{relativeTime(item.deletedAt)}</time>
            </label>
          ))}
        </div>
      )}

      <DataNotice notice={notice} />
    </section>
  );
}

function DataNotice({ notice }: { notice: Notice }) {
  if (!notice) return null;
  const Icon = notice.tone === "ok" ? Check : notice.tone === "error" ? ShieldAlert : Archive;
  return <p className={`data-notice ${notice.tone}`}><Icon size={13} /> {notice.text}</p>;
}

function trashKey(item: { kind: TrashKind; id: string }): string {
  return `${item.kind}:${item.id}`;
}

function relativeTo(base: string, target: string): string {
  const normalizedBase = base.replace(/[\\/]+$/, "").toLowerCase();
  if (target.toLowerCase().startsWith(normalizedBase)) {
    return target.slice(normalizedBase.length).replace(/^[\\/]+/, "");
  }
  return target;
}
