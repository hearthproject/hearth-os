import { useEffect, useMemo, useState } from "react";
import { Cpu, Flag, PencilLine, X } from "lucide-react";
import type {
  ExecutorId,
  ExecutorView,
  GoalContractPatch,
  GoalCriterion,
  GoalExecutionProfile,
  GoalReviewPolicy,
  GoalView,
  TaskKind
} from "@hearth/core";
import { executorLabel, taskKindLabel } from "../lib/labels.ts";

export type GoalManageMode = "executor" | "contract";

export function GoalManageDialog({
  mode,
  view,
  executors,
  busy,
  onClose,
  onSwitchExecutor,
  onAmendContract
}: {
  mode: GoalManageMode | null;
  view: GoalView | null;
  executors: ExecutorView[];
  busy: boolean;
  onClose: () => void;
  onSwitchExecutor: (execution: GoalExecutionProfile, note: string) => void;
  onAmendContract: (contract: GoalContractPatch, note: string) => void;
}) {
  const goal = view?.goal ?? null;
  const currentExecution = goal?.execution;
  const [executorId, setExecutorId] = useState<ExecutorId>(currentExecution?.executorId ?? "native");
  const [taskKind, setTaskKind] = useState<TaskKind>(currentExecution?.taskKind ?? "general");
  const [title, setTitle] = useState(goal?.title ?? "");
  const [objective, setObjective] = useState(goal?.objective ?? "");
  const [criteria, setCriteria] = useState(criteriaText(goal?.successCriteria ?? []));
  const [constraints, setConstraints] = useState(linesText(goal?.constraints ?? []));
  const [evidence, setEvidence] = useState(linesText(goal?.evidenceRequirements ?? []));
  const [forbidden, setForbidden] = useState(linesText(goal?.forbiddenActions ?? []));
  const [stopConditions, setStopConditions] = useState(linesText(goal?.stopConditions ?? []));
  const [reviewPolicy, setReviewPolicy] = useState<GoalReviewPolicy>(goal?.reviewPolicy ?? "human_on_risk");
  const [note, setNote] = useState("");

  useEffect(() => {
    if (!goal || !mode) return;
    setExecutorId(goal.execution?.executorId ?? "native");
    setTaskKind(goal.execution?.taskKind ?? "general");
    setTitle(goal.title);
    setObjective(goal.objective);
    setCriteria(criteriaText(goal.successCriteria));
    setConstraints(linesText(goal.constraints));
    setEvidence(linesText(goal.evidenceRequirements));
    setForbidden(linesText(goal.forbiddenActions));
    setStopConditions(linesText(goal.stopConditions));
    setReviewPolicy(goal.reviewPolicy);
    setNote("");
  }, [goal?.goalId, goal?.revision, mode]);

  const executorOptions = useMemo(() => {
    const available = executors.filter((executor) => executor.health.canRun);
    if (currentExecution && !available.some((executor) => executor.id === currentExecution.executorId)) {
      const current = executors.find((executor) => executor.id === currentExecution.executorId);
      if (current) return [current, ...available];
    }
    return available.length > 0 ? available : executors;
  }, [currentExecution, executors]);

  if (!mode || !view || !goal) return null;
  const canSwitch = Boolean(currentExecution) && executorId !== currentExecution?.executorId;
  const parsedCriteria = parseCriteria(criteria, goal.successCriteria);
  const canSubmitContract = Boolean(
    title.trim()
      && objective.trim()
      && (parsedCriteria.length > 0 || (goal.successCriteria ?? []).length === 0)
  );

  function submitExecutor(): void {
    if (!currentExecution || !canSwitch) return;
    onSwitchExecutor({
      ...currentExecution,
      executorId,
      taskKind
    }, note.trim());
  }

  function submitContract(): void {
    if (!canSubmitContract) return;
    const parsed = parseCriteria(criteria, goal?.successCriteria ?? []);
    onAmendContract({
      title: title.trim(),
      objective: objective.trim(),
      ...(parsed.length > 0 ? { successCriteria: parsed } : {}),
      constraints: parseLines(constraints),
      evidenceRequirements: parseLines(evidence),
      forbiddenActions: parseLines(forbidden),
      stopConditions: parseLines(stopConditions),
      reviewPolicy
    }, note.trim());
  }

  return (
    <div className="goal-dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="goal-dialog goal-manage-dialog" role="dialog" aria-modal="true" aria-label="目标管理" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <span className="goal-dialog-mark">{mode === "executor" ? <Cpu size={16} /> : <Flag size={16} />}</span>
          <div>
            <h2>{mode === "executor" ? "切换执行器" : "调整目标契约"}</h2>
            <p>
              {mode === "executor"
                ? "切换只影响下一轮。历史轮次、证据和当前产物会保留，旧执行器的迟到结果会被拒绝。"
                : "原始目标和历次契约都会保留。修改命令型成功标准时，旧命令审批会失效。"}
            </p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="关闭"><X size={16} /></button>
        </header>

        {mode === "executor" ? (
          <>
            <div className="goal-dialog-meta">
              <span><b>当前执行器</b>{executorLabel(currentExecution?.executorId)}</span>
              <span><b>执行修订</b>v{(goal.executionRevision ?? 0) + 1}</span>
            </div>
            <label>
              <span>下一轮执行器</span>
              <select value={executorId} onChange={(event) => setExecutorId(event.target.value as ExecutorId)}>
                {executorOptions.map((executor) => (
                  <option key={executor.id} value={executor.id}>
                    {executor.name}{executor.health.canRun ? "" : "（当前不可运行）"}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>任务类型</span>
              <select value={taskKind} onChange={(event) => setTaskKind(event.target.value as TaskKind)}>
                {(["workspace", "delivery", "general"] as const).map((kind) => (
                  <option key={kind} value={kind}>{taskKindLabel(kind)}</option>
                ))}
              </select>
            </label>
            <label>
              <span>切换原因</span>
              <input value={note} onChange={(event) => setNote(event.target.value)} placeholder="例如：本轮需要更强的仓库调查能力" />
            </label>
          </>
        ) : (
          <>
            <div className="goal-dialog-meta">
              <span><b>契约修订</b>v{(goal.contractRevision ?? 0) + 1}</span>
              <span className="goal-dialog-meta-wide"><b>原始目标</b>{goal.originalObjective ?? goal.objective}</span>
            </div>
            <label>
              <span>标题</span>
              <input value={title} onChange={(event) => setTitle(event.target.value)} />
            </label>
            <label>
              <span>当前目标</span>
              <textarea rows={4} value={objective} onChange={(event) => setObjective(event.target.value)} />
            </label>
            <label>
              <span>成功标准</span>
              <textarea rows={4} value={criteria} onChange={(event) => setCriteria(event.target.value)} placeholder="每行：描述 | 验证器(file/git/command/schema/manual/llm_review) | 检查内容" />
              <small>保留完整验证器与检查内容。命令型标准发生变化时，需要重新审批命令。</small>
            </label>
            <div className="goal-dialog-grid">
              <label>
                <span>约束</span>
                <textarea rows={3} value={constraints} onChange={(event) => setConstraints(event.target.value)} />
              </label>
              <label>
                <span>证据要求</span>
                <textarea rows={3} value={evidence} onChange={(event) => setEvidence(event.target.value)} />
              </label>
              <label>
                <span>禁止动作</span>
                <textarea rows={3} value={forbidden} onChange={(event) => setForbidden(event.target.value)} />
              </label>
              <label>
                <span>停止条件</span>
                <textarea rows={3} value={stopConditions} onChange={(event) => setStopConditions(event.target.value)} />
              </label>
            </div>
            <label>
              <span>完成判定</span>
              <select value={reviewPolicy} onChange={(event) => setReviewPolicy(event.target.value as GoalReviewPolicy)}>
                <option value="human_on_risk">有风险时问我</option>
                <option value="auto">通过就完成</option>
                <option value="human_on_complete">通过后也要我确认</option>
              </select>
            </label>
            <label>
              <span>修订原因</span>
              <input value={note} onChange={(event) => setNote(event.target.value)} placeholder="例如：交付范围缩小到后端，前端保持不变" />
            </label>
          </>
        )}

        <footer>
          <button type="button" className="ghost" onClick={onClose}>取消</button>
          <button
            type="button"
            className="primary"
            disabled={busy || (mode === "executor" ? !canSwitch : !canSubmitContract)}
            onClick={mode === "executor" ? submitExecutor : submitContract}
          >
            {mode === "executor" ? <><Cpu size={13} />应用切换</> : <><PencilLine size={13} />保存契约</>}
          </button>
        </footer>
      </section>
    </div>
  );
}

function linesText(values: string[]): string {
  return values.join("\n");
}

function parseLines(value: string): string[] {
  return value.split("\n").map((line) => line.trim()).filter(Boolean).slice(0, 20);
}

function criteriaText(criteria: GoalCriterion[]): string {
  return criteria.map((criterion) => `${criterion.description} | ${criterion.validator} | ${criterion.check}`).join("\n");
}

function parseCriteria(value: string, previous: GoalCriterion[]): GoalCriterion[] {
  return parseLines(value).flatMap((line, index) => {
    const [description = "", validator = "manual", ...checkParts] = line.split("|").map((part) => part.trim());
    if (!description) return [];
    const check = checkParts.join(" | ").trim() || description;
    const allowed = ["file", "git", "command", "schema", "manual", "llm_review"] as const;
    const kind = allowed.includes(validator as GoalCriterion["validator"])
      ? validator as GoalCriterion["validator"]
      : "manual";
    const existing = previous[index];
    return [{
      id: existing?.id ?? `c${index + 1}`,
      description,
      validator: kind,
      check,
      required: existing?.required ?? true
    }];
  });
}
