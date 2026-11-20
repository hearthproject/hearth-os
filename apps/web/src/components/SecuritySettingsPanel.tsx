import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, History, LockKeyhole, ShieldCheck, ShieldOff } from "lucide-react";
import { useState } from "react";
import { api } from "../lib/api.ts";
import { formatDate, relativeTime } from "../lib/format.ts";
import type { ApprovalGrant, SecurityAudit } from "../lib/types.ts";

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
  const grantsQuery = useQuery({ queryKey: ["approval-grants"], queryFn: api.approvalGrants });
  const snapshot = securityQuery.data;
  const active = snapshot?.state.killSwitch ?? false;

  const revokeGrant = useMutation({
    mutationFn: (id: string) => api.revokeApprovalGrant(id),
    onSuccess: () => {
      setNoticed("已取消这条自动执行规则，下一次同类操作会重新确认。");
      void queryClient.invalidateQueries({ queryKey: ["approval-grants"] });
    },
    onError: (error: Error) => setNoticed(error.message)
  });

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
    <div className="settings-section security-page">
      <div className="section-heading">
        <div><h3>安全与撤销</h3><p>全局停止会立即停下调度器、待处理审批和桌面会话；不会删除任务、记忆或产物。</p></div>
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
            <p>{active ? (snapshot?.state.reason ?? "用户启用了全局停止") : "审批、桌面动作和调度器只在显式授权的范围内运行。"}</p>
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
        <div className="data-block-head">
          <strong>自动执行规则</strong>
          <span className="data-block-meta">只影响你主动勾选过的同类外部操作</span>
        </div>
        {grantsQuery.isLoading ? (
          <p className="data-note">正在读取自动执行规则…</p>
        ) : (grantsQuery.data?.grants.length ?? 0) === 0 ? (
          <p className="data-empty">还没有自动执行规则。外部操作第一次确认时，可以勾选“以后遇到同类外部操作都直接执行”。</p>
        ) : (
          <table className="data-table security-audit-table">
            <thead><tr><th>操作</th><th>最近执行</th><th>创建时间</th><th /></tr></thead>
            <tbody>
              {grantsQuery.data?.grants.map((grant) => (
                <GrantRow
                  key={grant.id}
                  grant={grant}
                  pending={revokeGrant.isPending}
                  onRevoke={() => revokeGrant.mutate(grant.id)}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="data-block">
        <div className="data-block-head"><strong>撤销与删除</strong><span className="data-block-meta">本机安全边界</span></div>
        <dl className="data-boundaries">
          <div><dt>停止不等于删除</dt><dd>全局停止只中断调度、审批和桌面会话，不删除任务、记忆或产物。</dd></div>
          <div><dt>删除与恢复</dt><dd>在“数据”分区清理回收站或从加密备份恢复；彻底删除后磁盘上的受管工作区和产物也会移除。</dd></div>
          <div><dt>撤销自动执行</dt><dd>取消上面任何一条规则后，下一次同类操作会重新确认。</dd></div>
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

function GrantRow({ grant, pending, onRevoke }: { grant: ApprovalGrant; pending: boolean; onRevoke: () => void }) {
  return (
    <tr>
      <td><span className="tag">{grantActionLabel(grant.action)}</span></td>
      <td>{grant.lastUsedAt ? relativeTime(grant.lastUsedAt) : "还没有自动执行过"}</td>
      <td title={formatDate(grant.createdAt)}>{relativeTime(grant.createdAt)}</td>
      <td>
        <button className="ghost-button danger" disabled={pending} onClick={onRevoke}>取消自动执行</button>
      </td>
    </tr>
  );
}

function grantActionLabel(action: string): string {
  const labels: Record<string, string> = {
    browser_submit: "网页提交",
    browser_upload: "网页上传",
    browser_download: "网页下载",
    browser_recipe: "网页连续操作",
    send_email: "发送邮件",
    "email.smtp-send": "发送邮件",
    send_message: "发送消息",
    "github.publish-pr": "创建 PR",
    "github.comment": "在 GitHub 留言",
    publish: "发布内容",
    post: "发布内容",
    comment: "发表评论"
  };
  if (labels[action]) return labels[action];
  if (action.startsWith("mcp__")) return `外部工具 ${action.split("__").slice(2).join("__")}`;
  return action;
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
