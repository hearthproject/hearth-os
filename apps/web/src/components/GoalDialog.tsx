import { useState } from "react";
import { Flag, X } from "lucide-react";
import type { GoalSettingsInput } from "../lib/api.ts";

export function GoalDialog({
  open,
  hasActiveGoal,
  initial,
  onClose,
  onConfirm
}: {
  open: boolean;
  hasActiveGoal: boolean;
  initial: GoalSettingsInput;
  onClose: () => void;
  onConfirm: (settings: GoalSettingsInput) => void;
}) {
  const [reviewPolicy, setReviewPolicy] = useState<NonNullable<GoalSettingsInput["reviewPolicy"]>>(initial.reviewPolicy ?? "human_on_risk");
  const [criteria, setCriteria] = useState((initial.criteria ?? []).join("\n"));
  const [forbidden, setForbidden] = useState((initial.forbiddenActions ?? []).join("\n"));

  if (!open) return null;

  const submit = () => {
    const settings: GoalSettingsInput = {
      reviewPolicy,
      ...(criteria.trim() ? { criteria: criteria.split("\n").map((line) => line.trim()).filter(Boolean).slice(0, 20) } : {}),
      ...(forbidden.trim() ? { forbiddenActions: forbidden.split("\n").map((line) => line.trim()).filter(Boolean).slice(0, 20) } : {})
    };
    onConfirm(settings);
  };

  return (
    <div className="goal-dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="goal-dialog" role="dialog" aria-modal="true" aria-label="目标模式设置" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <span className="goal-dialog-mark"><Flag size={16} /></span>
          <div>
            <h2>目标模式</h2>
            <p>目标会持续推进，直到成功标准满足或你主动停止。宿主重启后，进行中的目标会暂停并保留现场，确认后再继续。</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="关闭"><X size={16} /></button>
        </header>
        {hasActiveGoal ? (
          <p className="goal-dialog-warning">当前会话已有未结束的目标。请先在目标栏暂停、停止或完成它，再创建新目标。</p>
        ) : (
          <>
            <label>
              <span>完成判定</span>
              <select value={reviewPolicy} onChange={(event) => setReviewPolicy(event.target.value as NonNullable<GoalSettingsInput["reviewPolicy"]>)}>
                <option value="human_on_risk">有风险时问我（默认）</option>
                <option value="auto">通过就完成</option>
                <option value="human_on_complete">通过后也要我确认</option>
              </select>
            </label>
            <label>
              <span>成功标准</span>
              <textarea rows={3} value={criteria} onChange={(event) => setCriteria(event.target.value)} placeholder="每行一条，交给独立模型验收；不填则按目标整体判断。" />
            </label>
            <label>
              <span>禁止动作</span>
              <textarea rows={2} value={forbidden} onChange={(event) => setForbidden(event.target.value)} placeholder="每行一条，例如：删除项目外的用户文件。" />
            </label>
          </>
        )}
        <footer>
          <button type="button" className="ghost" onClick={onClose}>取消</button>
          {!hasActiveGoal && <button type="button" className="primary" onClick={submit}>启用目标模式</button>}
        </footer>
      </section>
    </div>
  );
}
