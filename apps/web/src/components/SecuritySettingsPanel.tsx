import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, History, LockKeyhole, ShieldCheck, ShieldOff } from "lucide-react";
import { useState } from "react";
import { api } from "../lib/api.ts";
import { formatDate, relativeTime } from "../lib/format.ts";
import type { SecurityAudit } from "../lib/types.ts";

const AUDIT_LABELS: Record<string, string> = {
  "security.kill-switch.enabled": "启用全局停止",
  "security.kill-switch.disabled": "关闭全局停止",
  "security.audit": "安全审计",
  "device.paired": "设备配对",
  "device.revoked": "撤销设备",
  "device.token.rotated": "轮换设备令牌",
  "device.capability.revoked": "撤销设备能力",
  "desktop.frozen": "终止桌面会话"
};

export function SecuritySettingsPanel() {
  const queryClient = useQueryClient();
  const [noticed, setNoticed] = useState<string | null>(null);
  const securityQuery = useQuery({ queryKey: ["security"], queryFn: api.security, refetchInterval: 20_000 });
  const snapshot = securityQuery.data;
  const active = snapshot?.state.killSwitch ?? false;

  const toggleMutation = useMutation({
    mutationFn: async () => {
      if (!active) {
        const reason = window.prompt("全局停止原因（会写入安全审计）", "发现异常活动");
        if (reason === null) return "cancelled" as const;
        await api.setKillSwitch(true, reason.trim() || "用户启用了全局停止");
        return "enabled" as const;
      }
      await api.setKillSwitch(false);
      return "disabled" as const;
    },
    onSuccess: (result) => {
      if (result === "cancelled") return;
      setNoticed(result === "enabled"
        ? "全局停止已启用，桌面动作和调度器均已停止。"
        : "全局停止已关闭。执行器不会自动恢复，请到顶栏手动重新启动。");
      void queryClient.invalidateQueries({ queryKey: ["security"] });
      void queryClient.invalidateQueries({ queryKey: ["system"] });
      void queryClient.invalidateQueries({ queryKey: ["desktop"] });
      void queryClient.invalidateQueries({ queryKey: ["approvals"] });
    },
    onError: (error: Error) => setNoticed(error.message)
  });

  return (
    <div className="settings-section security-page">
      <div className="section-heading">
        <div><h3>安全与撤销</h3><p>全局停止会立即停下调度器和桌面会话；不会删除任务、记忆或产物。</p></div>
      </div>

      {securityQuery.isError && <p className="form-error">{securityQuery.error.message}</p>}
      {noticed && <p className="data-notice info">{noticed}</p>}

      <div className={`security-kill ${active ? "is-active" : ""}`}>
        <div className="security-kill-head">
          <span className={`security-state-icon ${active ? "danger" : "safe"}`}>{active ? <ShieldOff size={20} /> : <ShieldCheck size={20} />}</span>
          <div className="security-kill-copy">
            <div className="security-kill-title">
              <strong>{active ? "全局停止已启用" : "外部动作处于可用状态"}</strong>
              <span className={`tag ${active ? "security-active-tag" : ""}`}>{active ? "已停止" : "运行中"}</span>
            </div>
            <p>{active ? (snapshot?.state.reason ?? "用户启用了全局停止") : "执行器和调度器在完全权限下运行，全局停止随时可用。"}</p>
            <small>{snapshot?.state.updatedAt ? `最近变更 ${formatDate(snapshot.state.updatedAt)}` : "尚未启用全局停止"}</small>
          </div>
          <button className={active ? "primary-button" : "ghost-button danger"} disabled={toggleMutation.isPending || securityQuery.isLoading} onClick={() => toggleMutation.mutate()}>
            {active ? <ShieldCheck size={15} /> : <ShieldOff size={15} />} {active ? "关闭全局停止" : "立即停止外部动作"}
          </button>
        </div>
        {active && (
          <p className="security-kill-warning"><AlertTriangle size={14} /> 关闭后执行器仍需手动启动；已经终止的桌面会话不会自动恢复。</p>
        )}
      </div>

      <div className="data-block">
        <div className="data-block-head"><strong>撤销与删除</strong><span className="data-block-meta">本机安全边界</span></div>
        <dl className="data-boundaries">
          <div><dt>停止不等于删除</dt><dd>全局停止只中断调度和桌面会话，不删除任务、记忆或产物。</dd></div>
          <div><dt>删除与恢复</dt><dd>在“数据”分区清理回收站或从加密备份恢复；彻底删除后磁盘上的受管工作区和产物也会移除。</dd></div>
        </dl>
      </div>

      <div className="data-block">
        <div className="data-block-head">
          <strong>安全审计</strong>
          <span className="data-block-meta"><History size={12} /> 最近 {snapshot?.audits.length ?? 0} 条</span>
        </div>
        {securityQuery.isLoading ? (
          <p className="data-note">正在读取安全审计…</p>
        ) : (snapshot?.audits.length ?? 0) === 0 ? (
          <p className="data-empty">还没有安全审计记录。切换全局停止或取消自动执行后会出现在这里。</p>
        ) : (
          <table className="data-table security-audit-table">
            <thead><tr><th>动作</th><th>对象</th><th>说明</th><th>时间</th></tr></thead>
            <tbody>
              {snapshot?.audits.map((audit) => <AuditRow key={audit.id} audit={audit} />)}
            </tbody>
          </table>
        )}
      </div>

      <p className="security-footnote"><LockKeyhole size={13} /> 安全事件保存在本机事件日志中，不同步到其他实例。</p>
    </div>
  );
}

function AuditRow({ audit }: { audit: SecurityAudit }) {
  return (
    <tr>
      <td><span className="tag">{AUDIT_LABELS[audit.action] ?? audit.action}</span></td>
      <td>{audit.subjectLabel ?? "本实例"}{audit.subjectId && <small className="security-subject-id">{audit.subjectId.slice(0, 8)}</small>}</td>
      <td>{audit.detail}</td>
      <td title={formatDate(audit.at)}>{relativeTime(audit.at)}</td>
    </tr>
  );
}
