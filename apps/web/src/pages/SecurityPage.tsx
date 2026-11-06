import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, History, LockKeyhole, ShieldCheck, ShieldOff } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
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

export function SecurityPage() {
  const queryClient = useQueryClient();
  const [noticed, setNoticed] = useState<string | null>(null);
  const securityQuery = useQuery({ queryKey: ["security"], queryFn: api.security, refetchInterval: 20_000 });
  const snapshot = securityQuery.data;
  const active = snapshot?.state.killSwitch ?? false;

  const toggleMutation = useMutation({
    mutationFn: async () => {
      if (!active) {
        const reason = window.prompt("全局停止原因（会写入安全审计）", "设备丢失或发现异常活动");
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
        ? "全局停止已启用，审批、桌面动作和调度器均已停止。"
        : "全局停止已关闭。执行器不会自动恢复，请到顶栏手动重新启动。");
      void queryClient.invalidateQueries({ queryKey: ["security"] });
      void queryClient.invalidateQueries({ queryKey: ["system"] });
      void queryClient.invalidateQueries({ queryKey: ["desktop"] });
      void queryClient.invalidateQueries({ queryKey: ["approvals"] });
    },
    onError: (error: Error) => setNoticed(error.message)
  });

  return (
    <div className="page security-page">
      <div className="page-head">
        <div>
          <h1>安全与撤销</h1>
          <p className="page-meta">全局停止会立即停下调度器、待处理审批和桌面会话；不会删除任务、记忆或产物。</p>
        </div>
        <Link className="ghost-button" to="/devices"><ShieldCheck size={14} /> 管理设备</Link>
      </div>

      {securityQuery.isError && <p className="form-error">{securityQuery.error.message}</p>}
      {noticed && <p className="page-meta">{noticed}</p>}

      <section className={`panel security-kill-panel ${active ? "is-active" : ""}`}>
        <div className="security-kill-copy">
          <span className={`security-state-icon ${active ? "danger" : "safe"}`}>{active ? <ShieldOff size={22} /> : <ShieldCheck size={22} />}</span>
          <div>
            <div className="security-kill-title"><h2>{active ? "全局停止已启用" : "外部动作处于可用状态"}</h2><span className={"tag " + (active ? "security-active-tag" : "")}>{active ? "已停止" : "运行中"}</span></div>
            <p>{active ? (snapshot?.state.reason ?? "用户启用了全局停止") : "审批、桌面动作和调度器只在显式授权的范围内运行。"}</p>
            <p className="page-meta">{snapshot?.state.updatedAt ? `最近变更 ${formatDate(snapshot.state.updatedAt)}` : "尚未启用全局停止"}</p>
          </div>
        </div>
        <button className={active ? "primary-button" : "ghost-button danger"} disabled={toggleMutation.isPending || securityQuery.isLoading} onClick={() => toggleMutation.mutate()}>
          {active ? <ShieldCheck size={15} /> : <ShieldOff size={15} />} {active ? "关闭全局停止" : "立即停止外部动作"}
        </button>
        {active && (
          <p className="security-kill-warning"><AlertTriangle size={14} /> 关闭后执行器仍需手动启动；已经终止的桌面会话不会自动恢复。</p>
        )}
      </section>

      <section className="panel">
        <div className="panel-head"><h2>删除与撤销</h2><span className="panel-meta">本机安全边界</span></div>
        <dl className="kv-grid security-boundaries">
          <div><dt>设备丢失</dt><dd>在设备页撤销后，令牌、能力和活动会话立即失效。需要重新配对。</dd></div>
          <div><dt>设备换密钥</dt><dd>在设备页轮换令牌后，旧令牌失效；新令牌只显示一次，需要交给桌面助手重新连接。</dd></div>
          <div><dt>同步对端</dt><dd>在同步页撤销后，旧令牌不能继续读取事件；不会删除本机已有任务或记忆。</dd></div>
          <div><dt>删除数据</dt><dd>全局停止不删除数据。备份、导出和忽略记忆分别有独立入口，不把“停止”伪装成删除。</dd></div>
        </dl>
      </section>

      <section className="panel table-panel">
        <div className="panel-head"><h2>安全审计</h2><span className="panel-meta"><History size={12} /> 最近 {(snapshot?.audits.length ?? 0)} 条</span></div>
        {securityQuery.isLoading ? (
          <p className="section-empty">正在读取安全审计…</p>
        ) : (snapshot?.audits.length ?? 0) === 0 ? (
          <p className="section-empty">还没有安全审计记录。撤销设备、轮换令牌或切换全局停止后会出现在这里。</p>
        ) : (
          <table className="data-table security-audit-table">
            <thead><tr><th>动作</th><th>对象</th><th>说明</th><th>时间</th></tr></thead>
            <tbody>
              {snapshot?.audits.map((audit) => <AuditRow key={audit.id} audit={audit} />)}
            </tbody>
          </table>
        )}
      </section>

      <p className="security-footnote"><LockKeyhole size={13} /> 安全事件保存在本机事件日志中，不同步到其他实例；设备与服务端令牌都不会进入浏览器列表。</p>
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
