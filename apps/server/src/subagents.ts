import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { Ajv } from "ajv";
import type { AgentMode, RunBudget, RunUsage, TaskPermissions, TaskRecord, TaskWorktree } from "@hearth/core";
import {
  zeroUsage,
  agentProfile,
  finishActiveWork,
  startActiveWork,
  deserializeAgentState,
  completePlanStep,
  notePlanStep,
  startPlanStep,
  type AgentCheckpoint,
  type AgentResumeState,
  type AgentTool,
  type AgentToolAuthorization,
  type AgentToolAuthorizationRequest,
  type AgentToolResult,
  type HarnessMode,
  type OperationLedger,
  type SubagentType
} from "@hearth/agent-runtime";
import { runNativeTask, type NativeRunOptions, type NativeRunResult } from "./native-executor.ts";
import type { ModelSettings } from "./model-settings.ts";
import type { PreparedWorkspace } from "./workspace.ts";
import type { TaskWorktreeService } from "./worktrees.ts";
import type { ManagedAgent, ManagedAgentSession, SubagentTaskManager } from "./subagent-manager.ts";

const MAX_SUBAGENTS = 4;
const MAX_AGENT_DEPTH = 2;
export const MAX_TOTAL_SUBAGENTS = 8;
export { MAX_SUBAGENTS };

export interface SubagentFinishedInfo {
  childId: string;
  type: SubagentType;
  title: string;
  status: "completed" | "failed" | "cancelled" | "blocked";
  durationMs: number;
  usage?: RunUsage | undefined;
  summary?: string | undefined;
  structured?: unknown;
  reportPath?: string | undefined;
  transcriptPath: string;
  error?: string | undefined;
  branch?: string | undefined;
  commit?: string | undefined;
}

export type SubagentRunner = (options: NativeRunOptions) => Promise<NativeRunResult>;

export interface SubagentToolOptions {
  task: TaskRecord;
  prepared: PreparedWorkspace;
  settings: ModelSettings;
  permissions: TaskPermissions;
  signal: AbortSignal;
  worktrees: TaskWorktreeService;
  parentWorktree?: TaskWorktree | null;
  runner?: SubagentRunner | undefined;
  budget?: RunBudget | undefined;
  maxSubagents?: number | undefined;
  depth?: number | undefined;
  compatibility?: boolean | undefined;
  manager?: SubagentTaskManager | undefined;
  agentMode?: AgentMode | undefined;
  allowedTypes?: SubagentType[] | undefined;
  defaultOutputSchema?: Record<string, unknown> | undefined;
  evidenceRoot?: string | undefined;
  runId?: string | undefined;
  taskId?: string | undefined;
  operationLedger?: OperationLedger | undefined;
  onAuthorizeTool?: ((request: AgentToolAuthorizationRequest) => Promise<AgentToolAuthorization>) | undefined;
  onStarted?: ((info: { childId: string; mode: "read-only" | "isolated-write"; title: string; type: SubagentType; parentId?: string; depth?: number }) => void) | undefined;
  onFinished?: ((info: SubagentFinishedInfo) => void) | undefined;
}

export function createAgentTool(options: SubagentToolOptions): AgentTool {
  return createDispatchTool({ ...options, compatibility: false }, false);
}

export function createSubagentTool(options: SubagentToolOptions): AgentTool {
  return createDispatchTool({ ...options, compatibility: true }, true);
}

export function createSubagentResumeHandler(options: SubagentToolOptions) {
  const runner = options.runner ?? runNativeTask;
  return async (job: ManagedAgent, message: string, signal: AbortSignal): Promise<AgentToolResult> => {
    if (!job.session) throw new Error(`子代理没有可恢复的持久会话：${job.id}`);
    return executeAgentJob({ runner, options, session: job.session, signal, extra: message });
  };
}

function createDispatchTool(options: SubagentToolOptions, compatibility: boolean): AgentTool {
  const runner = options.runner ?? runNativeTask;
  const maxSubagents = Math.max(1, Math.min(MAX_SUBAGENTS, options.maxSubagents ?? MAX_SUBAGENTS));
  const depth = options.depth ?? 0;
  const allowedTypes: SubagentType[] = options.allowedTypes?.length
    ? [...options.allowedTypes]
    : ["explore", "plan", "review", "general-purpose"];
  let started = 0;

  return {
    definition: compatibility ? delegationDefinition() : agentDefinition(allowedTypes),
    async execute(input, context): Promise<AgentToolResult> {
      if (depth > MAX_AGENT_DEPTH) throw new Error(`子代理最多委派 ${MAX_AGENT_DEPTH} 层`);
      const args = input && typeof input === "object" ? input as Record<string, unknown> : {};
      const parsed = compatibility ? parseDelegationArgs(args) : parseAgentArgs(args);
      if (!parsed.objective) throw new Error(compatibility ? "请提供子任务目标" : "请提供 prompt");
      if (parsed.objective.length > 20_000) throw new Error("子任务目标过长");
      if (!allowedTypes.includes(parsed.type as SubagentType)) {
        throw new Error(`当前 Agent 模式不支持子代理类型：${parsed.type || "未指定"}`);
      }
      const profile = agentProfile(parsed.type);
      if (!profile) throw new Error(`未知子代理类型：${parsed.type}`);
      if (started >= maxSubagents) throw new Error(`每个任务最多启动 ${maxSubagents} 个子代理`);
      if (options.signal.aborted) throw new Error("任务已取消");

      started += 1;
      const childId = subagentTaskId(options.task.id, profile.type);
      const childTitle = parsed.title || `${profile.type} ${started}`;
      if (profile.isolation === "worktree" && !options.task.projectId) throw new Error("general-purpose 子代理只能用于本地项目任务");

      const safeParent = options.task.id.replace(/[^A-Za-z0-9._-]/g, "-") || "task";
      const evidenceRoot = options.evidenceRoot ?? join(tmpdir(), "hearth-subagents", safeParent);
      const evidenceDir = join(evidenceRoot, childId);
      const transcriptPath = join(evidenceDir, "transcript.jsonl");
      const checkpointPath = join(evidenceDir, "checkpoint.json");
      const journalPath = join(evidenceDir, "journal.jsonl");
      const childOutDir = join(evidenceDir, "out");
      mkdirSync(childOutDir, { recursive: true });
      appendTranscript(transcriptPath, {
        at: new Date().toISOString(),
        event: "started",
        agentId: childId,
        type: profile.type,
        title: childTitle,
        prompt: parsed.objective
      });

      const buildSession = (): ManagedAgentSession => {
        const worktree = profile.isolation === "worktree" ? createChildWorktree(childId, options) : null;
        const childRoot = worktree?.path ?? options.prepared.root;
        const outDir = worktree ? join(worktree.path, ".hearth", "subagent-out") : childOutDir;
        if (worktree) mkdirSync(outDir, { recursive: true });
        const childTask = childTaskRecord({
          id: childId,
          title: childTitle,
          objective: parsed.objective,
          task: options.task,
          root: childRoot,
          outDir,
          permissions: profile.isolation === "worktree" ? isolatedWritePermissions(options, childRoot, outDir) : readOnlyPermissions(options, profile.tools)
        });
        const narrow = (base: number | undefined, cap: number | undefined): number | undefined =>
          base === undefined ? cap : cap === undefined ? base : Math.min(base, cap);
        const budget = {
          ...profile.budget,
          ...(parsed.maxTurns ? { maxTurns: narrow(profile.budget.maxTurns, parsed.maxTurns) } : {}),
          ...(options.budget?.maxTokens !== undefined
            ? { maxTokens: narrow(profile.budget.maxTokens, options.budget.maxTokens) }
            : {})
        };
        const outputSchema = parsed.outputSchema ?? options.defaultOutputSchema;
        const canDelegate = depth < MAX_AGENT_DEPTH && profile.isolation !== "worktree";
        const prompt = agentPrompt(profile.type, parsed.objective, options.task, profile.outputContract, outputSchema, canDelegate);
        const permissions = childTask.permissions ?? readOnlyPermissions(options, profile.tools);
        const delegationTool = compatibility ? "delegate_task" : "agent";
        if (canDelegate && !permissions.tools.includes(delegationTool)) {
          permissions.tools = [...permissions.tools, delegationTool];
        }
        return {
          childId,
          parentTaskId: options.task.id,
          childTitle,
          type: profile.type,
          objective: parsed.objective,
          childTask,
          prepared: { root: childRoot, outDir },
          permissions,
          budget,
          mode: profile.mode,
          prompt,
          checkpointPath,
          journalPath,
          transcriptPath,
          ...(outputSchema ? { outputSchema } : {}),
          ...(worktree ? { worktree } : {})
        };
      };

      const session = buildSession();
      if (parsed.stepId) startPlanStep(context.state, parsed.stepId, childId);
      options.onStarted?.({
        childId,
        mode: profile.isolation === "worktree" ? "isolated-write" : "read-only",
        title: childTitle,
        type: profile.type,
        parentId: options.task.id,
        depth
      });

      const runStartedAt = Date.now();
      const runAgentJob = async (signal: AbortSignal, extra?: string): Promise<AgentToolResult> =>
        executeAgentJob({ runner, options, session, signal, ...(extra ? { extra } : {}) });

      const launch = async (signal: AbortSignal, extra?: string): Promise<AgentToolResult> => {
        startActiveWork(context.state, { id: childId, kind: "subagent", label: childTitle });
        try {
          const result = await runAgentJob(signal, extra);
          const metadata = (result.metadata ?? {}) as Record<string, unknown>;
          const agentStatus = metadata.agentStatus === "blocked"
            ? "blocked"
            : metadata.agentStatus === "failed"
              ? "failed"
              : "completed";
          finishActiveWork(context.state, childId, agentStatus === "completed" ? "completed" : agentStatus === "blocked" ? "blocked" : "failed");
          if (parsed.stepId) {
            if (agentStatus === "completed") completePlanStep(context.state, parsed.stepId, `${childTitle} 已完成`);
            else notePlanStep(context.state, parsed.stepId, `${childTitle} 回执状态为 ${agentStatus}`);
          }
          options.onFinished?.({
            childId,
            type: profile.type as SubagentType,
            title: childTitle,
            status: agentStatus,
            durationMs: Date.now() - runStartedAt,
            usage: result.usage,
            summary: result.summary ?? summarizeToolResult(result.content),
            ...(metadata.structured === undefined ? {} : { structured: metadata.structured }),
            ...(typeof metadata.reportPath === "string" ? { reportPath: metadata.reportPath } : {}),
            transcriptPath,
            ...(session.worktree ? { branch: session.worktree.branch } : {}),
            ...(typeof metadata.commitSha === "string" ? { commit: metadata.commitSha } : {})
          });
          return result;
        } catch (error) {
          const cancelled = signal.aborted;
          finishActiveWork(context.state, childId, cancelled ? "cancelled" : "failed");
          const failureMessage = errorMessage(error);
          if (parsed.stepId && !cancelled) notePlanStep(context.state, parsed.stepId, failureMessage);
          const reportPath = writeAgentFailureReport(session, error, runStartedAt, cancelled ? "cancelled" : "failed");
          options.onFinished?.({
            childId,
            type: profile.type as SubagentType,
            title: childTitle,
            status: cancelled ? "cancelled" : "failed",
            durationMs: Date.now() - runStartedAt,
            reportPath,
            transcriptPath,
            error: failureMessage
          });
          throw error;
        }
      };

      if (options.manager) {
        const job = options.manager.start(
          { id: childId, type: profile.type, title: childTitle, transcriptPath, session, checkpointPath, journalPath },
          launch,
          (message, signal) => launch(signal, message)
        );
        if (parsed.runInBackground) {
          return {
            content: `agentId: ${job.id}\nstatus: running\ntype: ${profile.type}\ntranscript: ${transcriptPath}\n请用 agent_wait 等待结果，或继续其他工作；agent_status 可查看状态，agent_kill 可取消。`,
            metadata: { agentId: job.id, subagentType: profile.type, agentStatus: "running", transcriptPath }
          };
        }
        return job.promise ?? launch(options.signal);
      }
      if (parsed.runInBackground) throw new Error("后台子代理需要 manager 支持");
      return launch(options.signal);
    }
  };
}

function summarizeToolResult(content: string): string {
  return content.split("\n").filter(Boolean).slice(0, 6).join("\n").slice(0, 800);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function executeAgentJob(input: {
  runner: SubagentRunner;
  options: SubagentToolOptions;
  session: ManagedAgentSession;
  signal: AbortSignal;
  extra?: string;
}): Promise<AgentToolResult> {
  const { runner, options, session, signal, extra } = input;
  const objective = extra ? `${session.objective}\n\n## Follow-up instruction\n${extra}` : session.objective;
  const profile = agentProfile(session.type);
  if (!profile) throw new Error(`未知子代理类型：${session.type}`);
  const prompt = agentPrompt(session.type, objective, options.task, profile.outputContract, session.outputSchema, (options.depth ?? 0) < MAX_AGENT_DEPTH && profile.isolation !== "worktree");
  const resume = loadAgentResume(session);
  const childDepth = options.depth ?? 0;
  const childDelegation = childDepth < MAX_AGENT_DEPTH && profile.isolation !== "worktree"
    ? [createDispatchTool({
        ...options,
        depth: childDepth + 1,
        maxSubagents: MAX_SUBAGENTS,
        ...(session.worktree ? { parentWorktree: session.worktree } : {})
      }, options.compatibility ?? false)]
    : [];
  const result = await runner({
    task: { ...session.childTask, goal: objective, updatedAt: new Date().toISOString() },
    prepared: { root: session.prepared.root, outDir: session.prepared.outDir, inputs: [] },
    settings: options.settings,
    prompt,
    permissions: session.permissions,
    budget: session.budget,
    mode: session.mode,
    isSubagent: true,
    signal: AbortSignal.any([options.signal, signal]),
    expectedOutputs: [],
    journalPath: session.journalPath,
    ...(options.runId ? { runId: options.runId } : {}),
    ...(options.taskId ? { taskId: options.taskId } : {}),
    ...(options.operationLedger ? { operationLedger: options.operationLedger } : {}),
    ...(options.onAuthorizeTool ? { onAuthorizeTool: options.onAuthorizeTool } : {}),
    ...(childDelegation.length > 0 || options.agentMode === "team" ? { maxParallelTools: 4 } : {}),
    ...(childDelegation.length > 0 ? { extraTools: childDelegation } : {}),
    ...(resume ? { resume } : {}),
    ...(options.manager ? { onProgress: () => options.manager!.progress(session.childId) } : {}),
    onCheckpoint: (checkpoint) => saveAgentCheckpoint(session.checkpointPath, checkpoint)
  });
  if (result.status !== "completed") {
    const details = result.status === "waiting_input"
      ? `需要补充信息：${result.question ?? result.finalResponse}`
      : result.finalResponse || result.status;
    throw new Error(`子代理未完成（${result.status}）：${details}${session.worktree ? `；已保留 Worktree ${session.worktree.path}（${session.worktree.branch}）` : ""}`);
  }

  const usage = result.usage ?? zeroUsage();
  const summary = result.finalResponse || "未返回总结";
  const structured = session.outputSchema ? parseStructuredOutput(session.outputSchema, summary) : undefined;
  const agentStatus = receiptStatus(structured);
  const structuredLine = structured === undefined ? [] : [`structured_output: ${JSON.stringify(structured)}`];

  if (!session.worktree) {
    const reportPath = writeAgentReport(session, {
      status: agentStatus,
      summary,
      usage,
      ...(structured === undefined ? {} : { structured })
    });
    appendTranscript(session.transcriptPath, {
      at: new Date().toISOString(),
      event: agentStatus,
      agentId: session.childId,
      type: session.type,
      summary,
      usage,
      ...(structured === undefined ? {} : { structured }),
      reportPath,
      messages: result.messages ?? []
    });
    return {
      content: [
        `agentId: ${session.childId}`,
        `status: ${agentStatus}`,
        `type: ${session.type}`,
        `summary: ${summary}`,
        ...structuredLine,
        `transcript: ${session.transcriptPath}`,
        `report: ${reportPath}`,
        `checkpoint: ${session.checkpointPath}`
      ].join("\n"),
      usage,
      metadata: {
        agentId: session.childId,
        subagentType: session.type,
        agentStatus,
        transcriptPath: session.transcriptPath,
        reportPath,
        ...(structured === undefined ? {} : { structured })
      }
    };
  }

  if (agentStatus !== "completed") {
    const reportPath = writeAgentReport(session, {
      status: agentStatus,
      summary,
      usage,
      ...(structured === undefined ? {} : { structured }),
      branch: session.worktree.branch
    });
    appendTranscript(session.transcriptPath, {
      at: new Date().toISOString(),
      event: agentStatus,
      agentId: session.childId,
      type: session.type,
      summary,
      usage,
      ...(structured === undefined ? {} : { structured }),
      branch: session.worktree.branch,
      reportPath,
      messages: result.messages ?? []
    });
    return {
      content: [
        `agentId: ${session.childId}`,
        `status: ${agentStatus}`,
        `type: ${session.type}`,
        `summary: ${summary}`,
        ...structuredLine,
        `branch: ${session.worktree.branch}`,
        `transcript: ${session.transcriptPath}`,
        `report: ${reportPath}`,
        "成员未完成，工作树未提交；请由父任务判断是否需要保留或清理。"
      ].join("\n"),
      usage,
      metadata: {
        agentId: session.childId,
        subagentType: session.type,
        agentStatus,
        branch: session.worktree.branch,
        transcriptPath: session.transcriptPath,
        reportPath,
        ...(structured === undefined ? {} : { structured })
      }
    };
  }

  const commit = commitChildWorktree(session.worktree.path, options.task.id, session.childTitle);
  const reportPath = writeAgentReport(session, {
    status: "completed",
    summary,
    usage,
    ...(structured === undefined ? {} : { structured }),
    branch: session.worktree.branch,
    commit
  });
  appendTranscript(session.transcriptPath, {
    at: new Date().toISOString(),
    event: "completed",
    agentId: session.childId,
    type: session.type,
    summary,
    usage,
    ...(structured === undefined ? {} : { structured }),
    branch: session.worktree.branch,
    commit,
    reportPath,
    messages: result.messages ?? []
  });
  return {
    content: [
      `agentId: ${session.childId}`,
      "status: completed",
      `type: ${session.type}`,
      `summary: ${summary}`,
      ...structuredLine,
      `branch: ${session.worktree.branch}`,
      `commit: ${commit}`,
      `transcript: ${session.transcriptPath}`,
      `report: ${reportPath}`,
      "结果尚未合并。请检查该分支和提交后，由父任务手动 cherry-pick。"
    ].join("\n"),
    usage,
    metadata: {
      agentId: session.childId,
      subagentType: session.type,
      agentStatus: "completed",
      branch: session.worktree.branch,
      commitSha: commit,
      transcriptPath: session.transcriptPath,
      reportPath,
      ...(structured === undefined ? {} : { structured })
    }
  };
}

/** Reads the member's own receipt status; defaults to completed only on a valid receipt. */
function receiptStatus(structured: unknown): "completed" | "blocked" | "failed" {
  if (!structured || typeof structured !== "object" || Array.isArray(structured)) return "completed";
  const status = (structured as Record<string, unknown>).status;
  return status === "blocked" || status === "failed" ? status : "completed";
}

/** Stable, task-scoped receipt used by the Lead and by post-run auditing. */
function writeAgentReport(session: ManagedAgentSession, report: {
  status: "completed" | "failed" | "cancelled" | "blocked";
  summary?: string;
  error?: string;
  usage?: RunUsage;
  structured?: unknown;
  branch?: string;
  commit?: string;
}): string {
  const path = join(dirname(session.transcriptPath), "report.json");
  const startedAt = session.childTask.createdAt;
  const endedAt = new Date().toISOString();
  const body = {
    version: 1,
    agentId: session.childId,
    parentTaskId: session.parentTaskId ?? null,
    type: session.type,
    title: session.childTitle,
    objective: session.objective,
    status: report.status,
    startedAt,
    endedAt,
    durationMs: Math.max(0, Date.now() - new Date(startedAt).getTime()),
    ...(report.usage ? { usage: report.usage } : {}),
    ...(report.summary ? { summary: report.summary } : {}),
    ...(report.structured === undefined ? {} : { structured: report.structured }),
    ...(report.error ? { error: report.error } : {}),
    ...(report.branch ? { branch: report.branch } : {}),
    ...(report.commit ? { commit: report.commit } : {}),
    transcript: session.transcriptPath,
    checkpoint: session.checkpointPath
  };
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  } catch {
    // Evidence is best-effort; a failed write must not change the child result.
  }
  return path;
}

function writeAgentFailureReport(
  session: ManagedAgentSession,
  error: unknown,
  startedAtMs: number,
  status: "failed" | "cancelled" = "failed"
): string {
  const path = join(dirname(session.transcriptPath), "report.json");
  const message = errorMessage(error);
  const body = {
    version: 1,
    agentId: session.childId,
    parentTaskId: session.parentTaskId ?? null,
    type: session.type,
    title: session.childTitle,
    objective: session.objective,
    status,
    startedAt: new Date(startedAtMs).toISOString(),
    endedAt: new Date().toISOString(),
    durationMs: Math.max(0, Date.now() - startedAtMs),
    error: message,
    transcript: session.transcriptPath,
    checkpoint: session.checkpointPath
  };
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  } catch {
    // Best-effort.
  }
  appendTranscript(session.transcriptPath, { at: new Date().toISOString(), event: "failed", agentId: session.childId, error: message });
  return path;
}

function loadAgentResume(session: ManagedAgentSession): AgentResumeState | undefined {
  if (!existsSync(session.checkpointPath)) return undefined;
  try {
    const checkpoint = JSON.parse(readFileSync(session.checkpointPath, "utf8")) as Partial<AgentCheckpoint>;
    if (!Array.isArray(checkpoint.messages)) return undefined;
    const state = checkpoint.state ? deserializeAgentState(checkpoint.state) : undefined;
    return {
      messages: checkpoint.messages,
      usage: checkpoint.usage ?? zeroUsage(),
      turns: Number(checkpoint.turns) || 0,
      toolCalls: Number(checkpoint.toolCalls) || 0,
      ...(state ? { state } : {}),
      ...(checkpoint.promptHash ? { promptHash: checkpoint.promptHash } : {}),
      ...(Number.isFinite(checkpoint.journalSeq) ? { journal: { path: session.journalPath, seq: Number(checkpoint.journalSeq) } } : {})
    };
  } catch {
    return undefined;
  }
}

function saveAgentCheckpoint(path: string, checkpoint: AgentCheckpoint): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.tmp`;
    writeFileSync(temp, `${JSON.stringify(checkpoint)}\n`, "utf8");
    renameSync(temp, path);
  } catch {
    // Checkpoints are best-effort; the child can still finish in this process.
  }
}

function parseStructuredOutput(schema: Record<string, unknown>, summary: string): unknown {
  const candidate = extractJson(summary);
  let value: unknown;
  try {
    value = JSON.parse(candidate);
  } catch {
    throw schemaFailure("子代理输出不是合法 JSON");
  }
  const ajv = new Ajv({ allErrors: true, strict: false });
  let validate;
  try {
    validate = ajv.compile(schema);
  } catch (error) {
    throw schemaFailure(`输出 Schema 无法编译：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!validate(value)) {
    const detail = validate.errors?.map((item) => `${item.instancePath || "/"} ${item.message ?? ""}`.trim()).join("; ") || "不符合 Schema";
    throw schemaFailure(detail);
  }
  return value;
}

function schemaFailure(message: string): Error {
  return Object.assign(new Error(`SUBAGENT_SCHEMA_FAILED: ${message}`), { code: "SUBAGENT_SCHEMA_FAILED", retryable: false });
}

function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced?.[1] ?? text).trim();
  const start = body.search(/[[{]/);
  const end = Math.max(body.lastIndexOf("}"), body.lastIndexOf("]"));
  return start >= 0 && end > start ? body.slice(start, end + 1) : body;
}


function createChildWorktree(childId: string, options: SubagentToolOptions): TaskWorktree {
  if (!options.task.projectId) throw new Error("隔离写子代理只能用于本地项目任务");
  const parent = options.parentWorktree ?? options.worktrees.ensure(options.task);
  const baseSha = gitStdout(parent.path, ["rev-parse", "HEAD"]);
  return options.worktrees.ensure(
    { id: childId, projectId: parent.projectId },
    { baseBranch: parent.branch, baseSha }
  );
}

function childTaskRecord(input: {
  id: string;
  title: string;
  objective: string;
  task: TaskRecord;
  root: string;
  outDir: string;
  permissions: TaskPermissions;
}): TaskRecord {
  const now = new Date().toISOString();
  return {
    id: input.id,
    templateId: null,
    title: input.title,
    goal: input.objective,
    status: "running",
    createdAt: now,
    updatedAt: now,
    deadline: null,
    inputs: [],
    networkHosts: [...input.permissions.networkHosts],
    outputDir: ".hearth/subagent-out",
    currentRunId: null,
    nextAction: null,
    error: null,
    executorId: "native",
    taskKind: "general",
    expectedOutputs: [],
    permissions: input.permissions,
    projectId: input.task.projectId ?? null
  };
}

function agentDefinition(allowedTypes: SubagentType[]): AgentTool["definition"] {
  return {
    name: "agent",
    description: "Start a typed subagent with its own context. Team v1 exposes read-only types (explore/plan/review); the Lead is the only writer. A subagent may delegate one more level when capacity allows. The final answer must be a JSON receipt when a schema is supplied.",
    parameters: {
      type: "object",
      properties: {
        subagent_type: { type: "string", enum: allowedTypes, description: "explore locates code, plan designs steps, review checks a diff; all members are read-only in Team v1" },
        description: { type: "string", description: "3-8 word label shown to the parent and UI" },
        prompt: { type: "string", description: "Self-contained task; the child cannot see the parent conversation. Include boundaries, deliverables and evidence requirements." },
        stepId: { type: "string", description: "Optional plan step id this member owns; completing the member marks the step completed" },
        run_in_background: { type: "boolean", description: "Return immediately and continue in the background" },
        maxTurns: { type: "number", description: "Optional turn cap for this child, bounded by the profile default" },
        output_schema: { type: "object", description: "Optional JSON Schema the child's final answer must satisfy; validated before the child is marked completed" }
      },
      required: ["subagent_type", "description", "prompt"],
      additionalProperties: false
    }
  };
}

function delegationDefinition(): AgentTool["definition"] {
  return {
    name: "delegate_task",
    description: "Compatibility alias for agent. read-only maps to explore; isolated-write maps to general-purpose in a worktree.",
    parameters: {
      type: "object",
      properties: {
        objective: { type: "string", description: "子任务目标、边界和期望输出" },
        mode: { type: "string", enum: ["read-only", "isolated-write"], description: "只读，或从父任务当前提交创建独立 Worktree 写入" },
        title: { type: "string", description: "便于识别的子任务名称" }
      },
      required: ["objective", "mode"],
      additionalProperties: false
    }
  };
}

function parseAgentArgs(args: Record<string, unknown>): { type: string; objective: string; title: string; stepId?: string; maxTurns?: number; runInBackground?: boolean; outputSchema?: Record<string, unknown> } {
  const type = typeof args.subagent_type === "string" ? args.subagent_type : "";
  const objective = typeof args.prompt === "string" ? args.prompt.trim() : "";
  const title = typeof args.description === "string" ? args.description.trim().slice(0, 120) : "";
  const stepId = typeof args.stepId === "string" ? args.stepId.trim().slice(0, 80) : "";
  const maxTurns = Number.isFinite(args.maxTurns) ? Math.max(1, Math.floor(Number(args.maxTurns))) : undefined;
  const runInBackground = args.run_in_background === true;
  const outputSchema = args.output_schema && typeof args.output_schema === "object" && !Array.isArray(args.output_schema)
    ? args.output_schema as Record<string, unknown>
    : undefined;
  return {
    type,
    objective,
    title,
    ...(stepId ? { stepId } : {}),
    ...(maxTurns ? { maxTurns } : {}),
    ...(runInBackground ? { runInBackground: true } : {}),
    ...(outputSchema ? { outputSchema } : {})
  };
}

function parseDelegationArgs(args: Record<string, unknown>): { type: string; objective: string; title: string; stepId?: string; maxTurns?: number; runInBackground?: boolean; outputSchema?: Record<string, unknown> } {
  const objective = typeof args.objective === "string" ? args.objective.trim() : "";
  const title = typeof args.title === "string" ? args.title.trim().slice(0, 120) : "";
  const mode = args.mode === "isolated-write" ? "general-purpose" : args.mode === "read-only" ? "explore" : "";
  if (!mode) throw new Error("mode 必须是 read-only 或 isolated-write");
  return { type: mode, objective, title };
}

function readOnlyPermissions(options: SubagentToolOptions, allowed: readonly string[]): TaskPermissions {
  const allow = new Set(allowed);
  return {
    readRoots: [options.prepared.root],
    writeRoots: [],
    networkHosts: [...options.permissions.networkHosts],
    tools: [...new Set(["finish_task", ...options.permissions.tools.filter((tool) => allow.has(tool))])]
  };
}

function isolatedWritePermissions(options: SubagentToolOptions, root: string, outDir: string): TaskPermissions {
  const blocked = new Set(["delegate_task", "agent", "agent_wait", "agent_status", "agent_kill"]);
  const tools = options.permissions.tools.filter((tool) => !blocked.has(tool) && !tool.startsWith("mcp__"));
  if (!tools.includes("finish_task")) tools.push("finish_task");
  if (!tools.some((tool) => ["write_file", "write_spreadsheet", "write_document", "edit_file", "apply_patch", "shell"].includes(tool))) {
    throw new Error("父任务没有授予任何写入能力，不能启动隔离写子代理");
  }
  return {
    readRoots: [root],
    writeRoots: [root, outDir],
    networkHosts: [...options.permissions.networkHosts],
    tools: [...new Set(tools)]
  };
}

function agentPrompt(type: string, objective: string, parent: TaskRecord, outputContract: string, outputSchema: Record<string, unknown> | undefined, canDelegate: boolean): string {
  return [
    `你是一个 ${type} 子代理，只负责下面这段子任务。父任务：${parent.title}`,
    `目标：${objective}`,
    `输出契约：${outputContract}`,
    ...(outputSchema ? [`最终回答必须是一个 JSON 值，严格满足以下 JSON Schema，不要包裹额外说明：\n${JSON.stringify(outputSchema)}`] : []),
    "上下文是隔离的：不要假设父代理知道你的中间过程，结论必须自带文件路径、行号和证据。",
    canDelegate
      ? "如果确实需要拆分，还可以再委派一层只读子代理；不要超过深度上限，也不要为了凑人数而拆分。"
      : "不要委派其他子代理。",
    "不要做超出目标的扩展，不要请求用户确认。"
  ].join("\n");
}

function appendTranscript(path: string, record: Record<string, unknown>): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
  } catch {
    // Transcripts are diagnostic; a read-only outDir must not fail the child.
  }
}

function subagentTaskId(parentId: string, type: string): string {
  const safeParent = parentId.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 80) || "task";
  const safeType = type.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 16) || "agent";
  return `${safeParent}-${safeType}-${randomUUID().slice(0, 8)}`;
}

function commitChildWorktree(path: string, parentId: string, title: string): string {
  const status = git(path, ["status", "--porcelain"]);
  if (!status.ok) throw new Error(status.stderr.trim() || "无法读取子代理 Worktree 状态");
  if (status.stdout.trim()) {
    const added = git(path, ["add", "-A"]);
    if (!added.ok) throw new Error(added.stderr.trim() || "无法暂存子代理改动");
    const message = `hearth subagent: ${title}\n\nparent: ${parentId}`;
    const committed = git(path, ["-c", "user.name=Hearth Subagent", "-c", "user.email=hearth-subagent@localhost", "commit", "-m", message]);
    if (!committed.ok) throw new Error(committed.stderr.trim() || "无法提交子代理改动");
  }
  return gitStdout(path, ["rev-parse", "HEAD"]);
}

function gitStdout(cwd: string, args: string[]): string {
  const result = git(cwd, args);
  if (!result.ok || !result.stdout.trim()) throw new Error(result.stderr.trim() || `git ${args.join(" ")} 没有返回结果`);
  return result.stdout.trim();
}

function git(cwd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024
  });
  if (result.error) return { ok: false, stdout: "", stderr: result.error.message };
  return { ok: result.status === 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}
