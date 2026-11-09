import { createHash, randomUUID } from "node:crypto";
import type { MethodApplication, MethodCandidate, MethodEvaluation, MethodMetrics, MethodSelection, MethodSettings, MethodTrial, MethodVerdict, TaskRecord } from "@hearth/core";
import { getTemplate } from "@hearth/templates";
import type { HearthService } from "./service.ts";

export interface MethodSnapshot {
  methods: MethodCandidate[];
  evaluations: MethodEvaluation[];
  trials: MethodTrial[];
  applications: MethodApplication[];
  settings: MethodSettings;
}

const METHOD_SETTINGS_KEY = "method.settings";
const DEFAULT_METHOD_SETTINGS: MethodSettings = { autoLearn: true, updatedAt: null };

export interface CreateMethodInput {
  name: string;
  summary: string;
  applicability: string;
  steps: string[];
  sourceTaskIds: string[];
  templateId?: string | null;
  allowedCapabilities?: string[];
  guardrails?: string[];
  fingerprint?: string | null;
}

export interface EvaluateMethodInput {
  baselineTaskIds: string[];
  trialTaskIds: string[];
  notes?: string;
}

export class MethodError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = "MethodError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

const EMPTY_METRICS: MethodMetrics = {
  tasks: 0,
  completed: 0,
  failed: 0,
  successRate: null,
  avgDurationMs: null,
  inputTokens: 0,
  outputTokens: 0,
  approvals: 0
};

const DEFAULT_GUARDRAILS = [
  "候选方法只能继承或收窄来源任务的工具与审批权限",
  "外部动作保持原有审批，不得由记忆或候选方法自动批准",
  "评估和试跑只读取已有轨迹，不额外触发外部副作用"
];

const TERMINAL_TASK_STATUSES = new Set(["completed", "failed", "recoverable"]);
const ASSIGNABLE_TASK_STATUSES = new Set(["queued", "failed", "recoverable", "waiting_input"]);
const UNASSIGNABLE_METHOD_STATUSES = new Set(["rejected", "reverted", "superseded"]);

export class MethodService {
  private readonly service: HearthService;
  private readonly clock: () => Date;

  constructor(service: HearthService, clock: () => Date = () => new Date()) {
    this.service = service;
    this.clock = clock;
  }

  settings(): MethodSettings {
    const raw = this.service.store.getAppSetting(METHOD_SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_METHOD_SETTINGS };
    try {
      const parsed = JSON.parse(raw) as Partial<MethodSettings>;
      const updatedAt = typeof parsed.updatedAt === "string" ? parsed.updatedAt : null;
      if (parsed.autoLearn === true) return { autoLearn: true, updatedAt };
      const migrated: MethodSettings = { autoLearn: true, updatedAt: this.nowIso() };
      this.service.store.setAppSetting(METHOD_SETTINGS_KEY, JSON.stringify(migrated));
      return migrated;
    } catch {
      return { ...DEFAULT_METHOD_SETTINGS };
    }
  }

  updateSettings(patch: { autoLearn?: boolean | undefined }): MethodSettings {
    if (patch.autoLearn !== undefined && patch.autoLearn !== true) {
      throw new MethodError("METHOD_AUTO_LEARN_REQUIRED", "自动学习始终开启");
    }
    const next: MethodSettings = {
      autoLearn: true,
      updatedAt: this.nowIso()
    };
    this.service.store.setAppSetting(METHOD_SETTINGS_KEY, JSON.stringify(next));
    return next;
  }

  snapshot(): MethodSnapshot {
    return {
      methods: this.service.store.listMethodCandidates(),
      evaluations: this.service.store.listMethodEvaluations(),
      trials: this.service.store.listMethodTrials(),
      applications: this.service.store.listMethodApplications({ limit: 500 }),
      settings: this.settings()
    };
  }

  resolveForTask(task: TaskRecord): { method: MethodCandidate; selection: MethodSelection } | null {
    if (task.methodId) {
      const method = this.service.store.getMethodCandidate(task.methodId);
      if (!method || UNASSIGNABLE_METHOD_STATUSES.has(method.status)) return null;
      return { method, selection: "pinned" };
    }
    if (!task.templateId) return null;
    const adopted = this.service.store.listMethodCandidates("adopted")
      .filter((method) => method.templateId === task.templateId && !method.sourceTaskIds.includes(task.id))
      .sort((left, right) =>
        (right.adoptedAt ?? right.updatedAt).localeCompare(left.adoptedAt ?? left.updatedAt)
        || left.id.localeCompare(right.id)
      );
    const method = adopted[0];
    return method ? { method, selection: "auto_template" } : null;
  }

  recordApplication(input: {
    taskId: string;
    runId: string;
    methodId: string;
    methodVersion: number;
    selection: MethodSelection;
    promptSha256: string;
  }): MethodApplication {
    const application: MethodApplication = {
      id: randomUUID(),
      taskId: input.taskId,
      runId: input.runId,
      methodId: input.methodId,
      methodVersion: input.methodVersion,
      selection: input.selection,
      promptSha256: input.promptSha256,
      createdAt: this.nowIso()
    };
    return this.service.store.insertMethodApplication(application);
  }

  listApplications(filter: { taskId?: string; methodId?: string; methodVersion?: number; limit?: number } = {}): MethodApplication[] {
    return this.service.store.listMethodApplications(filter);
  }

  generateFromTask(taskId: string, input: { name?: string; summary?: string } = {}): MethodCandidate {
    const task = this.requireTrajectoryTask(taskId);
    const template = task.templateId ? getTemplate(task.templateId) : undefined;
    const contextItems = [...this.service.store.listContextItems(task.id, { limit: 200 }).items].reverse()
      .filter((item) => !["method", "summary", "checkpoint", "notice"].includes(item.kind));
    const inputLabels = template?.inputs.map((item) => item.label).join("、") || task.inputs.map((item) => item.label).join("、") || "任务文本";
    const toolNames = unique(contextItems
      .filter((item) => item.kind === "tool_call")
      .map((item) => item.content.split("\n")[0]?.trim() ?? "")
      .filter(Boolean)
      .map((name) => clip(name, 60)))
      .slice(0, 6);
    const evidence = unique(contextItems
      .filter((item) => ["decision", "failure", "diagnosis"].includes(item.kind))
      .map((item) => clip(item.content.replace(/\s+/g, " ").trim(), 160))
      .filter(Boolean))
      .slice(-2);
    const artifacts = unique(this.service.store.listArtifacts(task.id).map((artifact) => artifact.relativePath));
    const outputs = template?.expectedOutputs.length ? template.expectedOutputs : artifacts;
    const outputLine = outputs.length > 0 ? outputs.join("、") : "任务要求的交付物";
    const capabilities = this.capabilitiesForTask(task);
    const steps = [
      "核对输入范围：" + inputLabels,
      ...(toolNames.length > 0 ? ["按顺序完成关键动作：" + toolNames.join(" → ")] : []),
      ...(evidence.length > 0 ? ["处理关键决策/失败：" + evidence.join("；")] : []),
      "生成期望产物：" + outputLine,
      task.error ? `保留失败样本并标注阻塞：${clip(task.error.message, 160)}` : "记录完成证据和可复现的验收结果",
      "发布或外部写入前保留原有审批门，不因方法复用而跳过确认"
    ];
    const fingerprint = createHash("sha256").update(JSON.stringify({
      templateId: task.templateId,
      inputs: task.inputs.map((item) => `${item.kind}:${item.label}`).sort(),
      steps,
      capabilities
    })).digest("hex");
    const existing = this.service.store.listMethodCandidates()
      .find((method) => method.fingerprint === fingerprint && !["rejected", "reverted"].includes(method.status));
    if (existing) return existing;
    return this.create({
      name: input.name?.trim() || (template ? template.title + "复盘方法" : task.title + "复盘方法"),
      summary: input.summary?.trim() || this.summaryForTask(task, outputs),
      applicability: task.templateId ? "模板 " + task.templateId + " 及同类输入" : "与来源任务目标、输入和输出结构相同的工作",
      steps,
      sourceTaskIds: [task.id],
      templateId: task.templateId,
      allowedCapabilities: capabilities,
      fingerprint
    });
  }

  autoLearnFromTask(taskId: string): MethodCandidate | null {
    const task = this.requireTrajectoryTask(taskId);
    if (task.status !== "completed") return null;
    const method = this.generateFromTask(taskId);
    if (method.status === "adopted") return method;
    if (!["candidate", "evaluating", "trial"].includes(method.status)) return null;
    const sources = method.sourceTaskIds.map((id) => this.service.store.getTask(id)).filter((item): item is TaskRecord => Boolean(item));
    if (sources.length === 0 || sources.some((source) => source.status !== "completed")) return null;
    return this.adopt(method.id);
  }

  validateAssignment(input: { methodId: string; templateId?: string | null }): { methodId: string; methodVersion: number } {
    const method = this.requireMethod(input.methodId);
    if (UNASSIGNABLE_METHOD_STATUSES.has(method.status)) {
      throw new MethodError("METHOD_NOT_ASSIGNABLE", "当前方法状态不能绑定到任务", 409);
    }
    if (method.templateId && method.templateId !== input.templateId) {
      throw new MethodError("METHOD_TEMPLATE_MISMATCH", "方法只适用于模板 " + method.templateId, 409);
    }
    return { methodId: method.id, methodVersion: method.version };
  }

  assignToTask(taskId: string, methodId: string | null): TaskRecord {
    const task = this.requireTask(taskId);
    if (!ASSIGNABLE_TASK_STATUSES.has(task.status)) {
      throw new MethodError("METHOD_TASK_NOT_ASSIGNABLE", "当前任务状态不能绑定方法", 409);
    }
    if (methodId === null) {
      return this.service.updateTask(taskId, { methodId: null, methodVersion: null });
    }
    const assignment = this.validateAssignment({ methodId, templateId: task.templateId });
    return this.service.updateTask(taskId, assignment);
  }

  create(input: CreateMethodInput): MethodCandidate {
    const name = input.name.trim();
    const summary = input.summary.trim();
    const applicability = input.applicability.trim();
    const sourceTaskIds = unique(input.sourceTaskIds.map((id) => id.trim()).filter(Boolean));
    const steps = input.steps.map((step) => step.trim()).filter(Boolean);
    if (!name) throw new MethodError("METHOD_NAME_REQUIRED", "候选方法需要名称");
    if (!summary) throw new MethodError("METHOD_SUMMARY_REQUIRED", "候选方法需要摘要");
    if (!applicability) throw new MethodError("METHOD_APPLICABILITY_REQUIRED", "候选方法需要适用范围");
    if (steps.length === 0) throw new MethodError("METHOD_STEPS_REQUIRED", "候选方法至少需要一个步骤");
    if (sourceTaskIds.length === 0) throw new MethodError("METHOD_SOURCE_REQUIRED", "候选方法必须关联来源任务");
    for (const taskId of sourceTaskIds) this.requireTrajectoryTask(taskId);

    const inheritedCapabilities = this.intersectionCapabilities(sourceTaskIds);
    const requested = input.allowedCapabilities ? unique(input.allowedCapabilities.map((item) => item.trim()).filter(Boolean)) : inheritedCapabilities;
    const expanded = requested.filter((capability) => !inheritedCapabilities.includes(capability));
    if (expanded.length > 0) {
      throw new MethodError("METHOD_PERMISSION_EXPANSION", "候选方法声明了来源任务没有的能力：" + expanded.join("、"), 409);
    }

    const now = this.nowIso();
    const method: MethodCandidate = {
      id: randomUUID(),
      name,
      summary,
      applicability,
      steps,
      sourceTaskIds,
      templateId: input.templateId?.trim() || null,
      status: "candidate",
      version: 1,
      generation: null,
      fingerprint: input.fingerprint?.trim() || null,
      previousVersionId: null,
      allowedCapabilities: requested,
      guardrails: unique([...DEFAULT_GUARDRAILS, ...(input.guardrails ?? [])]),
      baseline: this.metrics(sourceTaskIds),
      trial: { ...EMPTY_METRICS },
      evaluationVerdict: null,
      createdAt: now,
      updatedAt: now,
      adoptedAt: null,
      retiredAt: null
    };
    this.emit("method.candidate.created", method);
    return method;
  }

  recordTrial(id: string, taskId: string): MethodCandidate {
    const method = this.requireMutableMethod(id);
    const task = this.requireTrajectoryTask(taskId);
    if (this.service.store.listEffects(task.id).length > 0) {
      throw new MethodError("METHOD_TRIAL_SIDE_EFFECT", "试跑样本包含外部副作用，不能作为 Shadow 证据", 409);
    }
    const existingTrial = this.service.store.listMethodTrials().find((trial) => trial.taskId === taskId);
    if (existingTrial?.methodId === id) return method;
    if (existingTrial) {
      throw new MethodError("METHOD_TRIAL_TASK_TAKEN", "该任务已经是其他方法的试跑样本", 409);
    }
    const applications = this.service.store.listMethodApplications({ taskId, methodId: id, limit: 20 });
    if (applications.length === 0) {
      throw new MethodError("METHOD_TRIAL_NOT_INJECTED", "该任务没有注入过这个方法，不能作为试跑证据", 409);
    }
    const application = applications.find((item) => item.methodVersion === method.version);
    if (!application) {
      throw new MethodError("METHOD_TRIAL_VERSION_MISMATCH", "试跑任务使用的版本与当前方法版本不一致", 409);
    }
    if (!this.service.store.getRun(application.runId)) {
      throw new MethodError("METHOD_TRIAL_RUN_MISSING", "试跑任务对应的运行记录不存在", 409);
    }
    const trial: MethodTrial = {
      id: randomUUID(),
      methodId: id,
      methodVersion: method.version,
      taskId: task.id,
      createdAt: this.nowIso()
    };
    this.emit("method.trial.recorded", trial);
    const trialIds = this.service.store.listMethodTrials(id).map((item) => item.taskId);
    const next: MethodCandidate = {
      ...this.requireMethod(id),
      status: "trial",
      trial: this.metrics(trialIds),
      updatedAt: this.nowIso()
    };
    this.emit("method.candidate.updated", next);
    return next;
  }

  evaluate(id: string, input: EvaluateMethodInput): MethodEvaluation {
    const method = this.requireMutableMethod(id);
    const baselineTaskIds = unique(input.baselineTaskIds.map((item) => item.trim()).filter(Boolean));
    const trialTaskIds = unique(input.trialTaskIds.map((item) => item.trim()).filter(Boolean));
    if (baselineTaskIds.length === 0 || trialTaskIds.length === 0) {
      throw new MethodError("METHOD_EVAL_SAMPLES_REQUIRED", "基线和试跑都需要至少一个任务样本");
    }
    const overlap = baselineTaskIds.filter((taskId) => trialTaskIds.includes(taskId));
    if (overlap.length > 0) throw new MethodError("METHOD_EVAL_OVERLAP", "基线和试跑样本不能重叠");
    const sampleTasks = [...baselineTaskIds, ...trialTaskIds].map((taskId) => this.requireTrajectoryTask(taskId));
    const expectedTemplate = method.templateId ?? sampleTasks[0]?.templateId ?? null;
    if (expectedTemplate && sampleTasks.some((task) => task.templateId !== expectedTemplate)) {
      throw new MethodError("METHOD_EVAL_UNPAIRED", "基线和试跑样本必须属于同一模板", 409);
    }
    const trials = this.service.store.listMethodTrials(id);
    for (const taskId of trialTaskIds) {
      if (!trials.some((trial) => trial.taskId === taskId && trial.methodVersion === method.version)) {
        throw new MethodError("METHOD_EVAL_NOT_INJECTED", "试跑样本没有对应的试跑记录", 409);
      }
      if (this.service.store.listMethodApplications({ taskId, methodId: id, methodVersion: method.version }).length === 0) {
        throw new MethodError("METHOD_EVAL_NOT_INJECTED", "试跑样本缺少方法注入证据", 409);
      }
    }
    for (const taskId of baselineTaskIds) {
      if (this.service.store.listMethodApplications({ taskId, methodId: id }).length > 0) {
        throw new MethodError("METHOD_EVAL_BASELINE_APPLIED", "基线任务已经注入过这个方法，不能作为基线", 409);
      }
    }

    const baseline = this.metrics(baselineTaskIds);
    const trial = this.metrics(trialTaskIds);
    const baselineCapabilities = this.intersectionCapabilities(baselineTaskIds);
    const trialCapabilities = this.intersectionCapabilities(trialTaskIds);
    const expanded = method.allowedCapabilities.filter((capability) =>
      !baselineCapabilities.includes(capability) || !trialCapabilities.includes(capability)
    );
    const verdict = decideVerdict(baseline, trial, expanded.length > 0);
    const notes = [input.notes?.trim(), expanded.length > 0 ? "权限越界：" + expanded.join("、") : ""].filter(Boolean).join("；");
    const evaluation: MethodEvaluation = {
      id: randomUUID(),
      methodId: id,
      methodVersion: method.version,
      baselineTaskIds,
      trialTaskIds,
      baseline,
      trial,
      verdict,
      notes,
      createdAt: this.nowIso()
    };
    this.emit("method.evaluation.recorded", evaluation);
    const next: MethodCandidate = {
      ...this.requireMethod(id),
      status: expanded.length > 0 ? "rejected" : verdict === "improved" ? "trial" : "evaluating",
      baseline,
      trial,
      evaluationVerdict: verdict,
      retiredAt: expanded.length > 0 ? this.nowIso() : null,
      updatedAt: this.nowIso()
    };
    this.emit("method.candidate.updated", next);
    return evaluation;
  }

  pairingSuggestion(id: string): { baselineTaskIds: string[]; trialTaskIds: string[]; notes: string[] } {
    const method = this.requireMethod(id);
    const notes: string[] = [];
    if (!method.templateId) {
      return { baselineTaskIds: [], trialTaskIds: [], notes: ["方法没有模板，无法自动配对；请手动选择样本。"] };
    }
    const trials = this.service.store.listMethodTrials(id)
      .filter((trial) => trial.methodVersion === method.version)
      .filter((trial) => this.service.store.listMethodApplications({ taskId: trial.taskId, methodId: id, methodVersion: method.version }).length > 0)
      .map((trial) => trial.taskId);
    const trialTaskIds = unique(trials).filter((taskId) => {
      const task = this.service.store.getTask(taskId);
      return Boolean(task && TERMINAL_TASK_STATUSES.has(task.status));
    });
    const terminal = this.service.store.listTasks()
      .filter((task) => task.templateId === method.templateId && TERMINAL_TASK_STATUSES.has(task.status))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    const candidates = terminal.filter((task) =>
      !trialTaskIds.includes(task.id)
      && !method.sourceTaskIds.includes(task.id)
      && this.service.store.listMethodApplications({ taskId: task.id, methodId: id }).length === 0
    );
    const fallback = terminal.filter((task) =>
      !trialTaskIds.includes(task.id)
      && method.sourceTaskIds.includes(task.id)
      && this.service.store.listMethodApplications({ taskId: task.id, methodId: id }).length === 0
    );
    const wanted = Math.max(2, trialTaskIds.length);
    const baselineTaskIds = candidates.slice(0, wanted).map((task) => task.id);
    if (baselineTaskIds.length < wanted) {
      const fill = fallback.slice(0, wanted - baselineTaskIds.length).map((task) => task.id);
      baselineTaskIds.push(...fill);
      if (fill.length > 0) notes.push("基线包含来源任务，证据较弱。");
    }
    if (baselineTaskIds.length < 2) notes.push("没有足够的同模板基线任务。");
    if (trialTaskIds.length < 2) notes.push("试跑样本不足 2 个。");
    return { baselineTaskIds, trialTaskIds, notes };
  }

  promote(id: string): MethodCandidate {
    const method = this.requireMethod(id);
    if (method.status !== "trial") throw new MethodError("METHOD_NOT_IN_TRIAL", "只有试跑中的候选方法可以晋升", 409);
    const latestEvaluation = this.service.store.listMethodEvaluations(id)
      .find((evaluation) => evaluation.methodVersion === method.version);
    if (!latestEvaluation || latestEvaluation.verdict !== "improved") {
      throw new MethodError("METHOD_NOT_IMPROVED", "候选方法没有可重复的改进证据", 409);
    }
    if (latestEvaluation.baseline.tasks < 2 || latestEvaluation.trial.tasks < 2) {
      throw new MethodError("METHOD_EVIDENCE_INSUFFICIENT", "晋升至少需要 2 个基线和 2 个试跑样本", 409);
    }
    const trialIds = this.service.store.listMethodTrials(id)
      .filter((trial) => trial.methodVersion === method.version)
      .filter((trial) => this.service.store.listMethodApplications({ taskId: trial.taskId, methodId: id, methodVersion: method.version }).length > 0)
      .map((trial) => trial.taskId);
    if (trialIds.length < 2) throw new MethodError("METHOD_TRIAL_REQUIRED", "晋升前至少需要两个有注入证据的试跑样本", 409);
    return this.adopt(id, trialIds);
  }

  private adopt(id: string, trialTaskIds: string[] = []): MethodCandidate {
    const method = this.requireMethod(id);
    if (method.status === "adopted") return method;
    if (["reverted", "rejected", "superseded"].includes(method.status)) {
      throw new MethodError("METHOD_READ_ONLY", "当前候选方法状态不允许晋升", 409);
    }
    const baselineCapabilities = this.intersectionCapabilities(method.sourceTaskIds);
    const expanded = method.allowedCapabilities.filter((capability) => !baselineCapabilities.includes(capability));
    if (expanded.length > 0) throw new MethodError("METHOD_PERMISSION_EXPANSION", "候选方法权限超出基线，不能晋升", 409);
    const now = this.nowIso();
    const adopted = this.service.store.listMethodCandidates("adopted")
      .filter((candidate) => candidate.id !== id && candidate.templateId === method.templateId)
      .sort((left, right) => (right.adoptedAt ?? right.updatedAt).localeCompare(left.adoptedAt ?? left.updatedAt));
    const previous = adopted[0] ?? null;
    const generation = previous ? (previous.generation ?? previous.version ?? 1) + 1 : 1;
    for (const prior of adopted) {
      this.emit("method.candidate.updated", {
        ...prior,
        status: "superseded",
        guardrails: unique([...prior.guardrails, `被第 ${generation} 代取代`]),
        retiredAt: now,
        updatedAt: now
      });
    }
    const next: MethodCandidate = {
      ...method,
      status: "adopted",
      generation,
      previousVersionId: previous?.id ?? null,
      trial: trialTaskIds.length > 0 ? this.metrics(trialTaskIds) : method.trial,
      adoptedAt: now,
      retiredAt: null,
      updatedAt: now
    };
    this.emit("method.candidate.updated", next);
    return next;
  }

  rollback(id: string, reason: string): MethodCandidate {
    const method = this.requireMethod(id);
    if (method.status !== "adopted") throw new MethodError("METHOD_NOT_ADOPTED", "只有已采用的方法可以回退", 409);
    const explanation = reason.trim() || "用户要求回退";
    const now = this.nowIso();
    const next: MethodCandidate = {
      ...method,
      status: "reverted",
      guardrails: unique([...method.guardrails, "回退原因：" + explanation]),
      retiredAt: now,
      updatedAt: now
    };
    this.emit("method.candidate.updated", next);
    if (method.previousVersionId) {
      const previous = this.service.store.getMethodCandidate(method.previousVersionId);
      if (previous && (previous.status === "superseded" || previous.status === "reverted")) {
        this.emit("method.candidate.updated", {
          ...previous,
          status: "adopted",
          guardrails: unique([...previous.guardrails, `因回退第 ${method.generation ?? method.version} 代恢复`]),
          retiredAt: null,
          updatedAt: now
        });
      }
    }
    return next;
  }

  reject(id: string, reason = "评估未通过"): MethodCandidate {
    const method = this.requireMutableMethod(id);
    const next: MethodCandidate = {
      ...method,
      status: "rejected",
      guardrails: unique([...method.guardrails, "拒绝原因：" + reason.trim()]),
      retiredAt: this.nowIso(),
      updatedAt: this.nowIso()
    };
    this.emit("method.candidate.updated", next);
    return next;
  }

  private metrics(taskIds: string[]): MethodMetrics {
    const tasks = taskIds.map((taskId) => this.service.store.getTask(taskId)).filter((task): task is TaskRecord => Boolean(task));
    if (tasks.length === 0) return { ...EMPTY_METRICS };
    let durationTotal = 0;
    let durationCount = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let approvals = 0;
    for (const task of tasks) {
      for (const run of this.service.store.listRuns(task.id)) {
        if (run.startedAt && run.endedAt) {
          durationTotal += Math.max(0, Date.parse(run.endedAt) - Date.parse(run.startedAt));
          durationCount += 1;
        }
        inputTokens += run.usage?.inputTokens ?? 0;
        outputTokens += run.usage?.outputTokens ?? 0;
      }
      approvals += this.service.store.listApprovals(task.id).length;
    }
    const completed = tasks.filter((task) => task.status === "completed").length;
    return {
      tasks: tasks.length,
      completed,
      failed: tasks.length - completed,
      successRate: completed / tasks.length,
      avgDurationMs: durationCount > 0 ? Math.round(durationTotal / durationCount) : null,
      inputTokens,
      outputTokens,
      approvals
    };
  }

  private intersectionCapabilities(taskIds: string[]): string[] {
    const sets = taskIds.map((taskId) => new Set(this.capabilitiesForTask(this.requireTask(taskId))));
    if (sets.length === 0) return [];
    const first = sets[0];
    if (!first) return [];
    const rest = sets.slice(1);
    return [...first].filter((capability) => rest.every((set) => set.has(capability))).sort();
  }

  private capabilitiesForTask(task: TaskRecord): string[] {
    const capabilities = new Set<string>();
    for (const input of task.inputs) capabilities.add("input:" + input.kind);
    for (const host of task.networkHosts) capabilities.add("network:" + host);
    const template = task.templateId ? getTemplate(task.templateId) : undefined;
    if (template?.approvalKind && template.approvalKind !== "none") capabilities.add("approval:" + template.approvalKind);
    if (template?.github) capabilities.add("repo:github");
    return [...capabilities];
  }

  private summaryForTask(task: TaskRecord, outputs: string[]): string {
    const outcome = task.status === "completed" ? "已完成" : "保留失败证据";
    return "从任务「" + task.title + "」提取可复用流程；" + outcome + "；产物：" + (outputs.join("、") || "按任务要求") + "。";
  }

  private requireTrajectoryTask(taskId: string): TaskRecord {
    const task = this.requireTask(taskId);
    if (!TERMINAL_TASK_STATUSES.has(task.status)) {
      throw new MethodError("METHOD_TASK_NOT_TERMINAL", "任务还没有可复盘的终态轨迹", 409);
    }
    return task;
  }

  private requireTask(taskId: string): TaskRecord {
    const task = this.service.store.getTask(taskId);
    if (!task) throw new MethodError("METHOD_TASK_NOT_FOUND", "来源任务不存在", 404);
    return task;
  }

  private requireMethod(id: string): MethodCandidate {
    const method = this.service.store.getMethodCandidate(id);
    if (!method) throw new MethodError("METHOD_NOT_FOUND", "候选方法不存在", 404);
    return method;
  }

  private requireMutableMethod(id: string): MethodCandidate {
    const method = this.requireMethod(id);
    if (["adopted", "reverted", "rejected", "superseded"].includes(method.status)) {
      throw new MethodError("METHOD_READ_ONLY", "当前候选方法状态不允许继续修改", 409);
    }
    return method;
  }

  private emit(type: string, payload: unknown): void {
    const event = this.service.store.appendEvent({ type, payload });
    this.service.bus.publish(event);
  }

  private nowIso(): string {
    return this.clock().toISOString();
  }
}

function decideVerdict(baseline: MethodMetrics, trial: MethodMetrics, permissionExpanded: boolean): MethodVerdict {
  if (permissionExpanded) return "regressed";
  if (baseline.tasks < 2 || trial.tasks < 2 || baseline.successRate === null || trial.successRate === null) return "insufficient";
  if (trial.successRate < baseline.successRate) return "regressed";
  if (trial.successRate > baseline.successRate) return "improved";
  if (baseline.avgDurationMs !== null && trial.avgDurationMs !== null) {
    if (trial.avgDurationMs < baseline.avgDurationMs * 0.9) return "improved";
    if (trial.avgDurationMs > baseline.avgDurationMs * 1.25) return "regressed";
  }
  return "flat";
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
