import { isTextDraftTask, DRAFT_INSTRUCTION } from "./draft-intent.ts";
import { localTimeLine } from "./local-time.ts";
import { nativeTaskInstructions } from "./native-task-instructions.ts";
import type { BudgetDimension, RunBudget, RunUsage, TaskPermissions, TaskProgressDetail, TaskRecord } from "@hearth/core";
import { EXECUTION_PROFILES, resolveContextWindowPolicy } from "@hearth/core";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import {
  CODING_RUN_BUDGET,
  GENERAL_RUN_BUDGET,
  withBudgetDefaults,
  CODING_REMINDERS,
  codingFinishIssue,
  codingHarnessEnabled,
  codingPromptSections,
  createAgentState,
  createBuiltinTools,
  composeTaskPromptSections,
  defaultTaskPermissions,
  executionContractPrompt,
  discoverInstructions,
  goalContinuationPrompt,
  goalFinishIssue,
  loadWorkspaceHooks,
  memoryIndexBlock,
  recordGoalTurns,
  todoFinishIssue,
  instructionsBlock,
  resolveHarnessProfile,
  resolveSandboxPolicy,
  commonAncestor,
  isFilesystemRoot,
  pathWithin,
  resolveRetryPolicy,
  resolveTaskProfile,
  runAgent,
  zeroUsage,
  SandboxUnavailableError,
  cassetteModel,
  cassetteTools,
  describeModelRequest,
  modelRequestFingerprint,
  toolCatalogDigest,
  type CassetteMode,
  type CassetteSource,
  type ExchangeRecorder,
  type AgentCheckpoint,
  type AgentFailure,
  type ContextSummary,
  type AgentMessage,
  type AgentModel,
  type AgentResumeState,
  type AgentRunResult,
  type AgentPostEditEvent,
  type AgentTool,
  type AgentToolAuthorization,
  type AgentToolAuthorizationRequest,
  type AgentToolContext,
  type HarnessMode,
  type JournalSink,
  type OperationLedger,
  type RetryPolicy,
  type RuntimeEvent,
  type SandboxRuntime
} from "@hearth/agent-runtime";
import { wantsDirectFileRead, wantsCodeExecution, wantsGithubAccess, wantsPublicWebResearch, wantsScreenshot } from "./task-intent.ts";
import { supportsToolCalling, streamAgentTurn } from "./model-agent.ts";
import { completeChat } from "./model-client.ts";
import { WindowsNativeSandboxProvider } from "./windows-native-sandbox.ts";
import { getBackgroundTaskRegistry } from "./background-tasks.ts";
import { DOSSIER_DIR, HEARTH_ROOT, WORKSTYLE_PATH } from "./config.ts";
import { DossierStore, dossierPromptBlock } from "./dossier.ts";
import { WorkstyleStore, workstylePromptBlock } from "./workstyle.ts";
import type { ModelSettings } from "./model-settings.ts";
import type { PreparedWorkspace } from "./workspace.ts";
import { browserToolSecrets, redactBrowserToolArguments, redactKnownSecrets } from "./browser-redaction.ts";

export const DEFAULT_RUN_BUDGET: RunBudget = { ...GENERAL_RUN_BUDGET };

export const NATIVE_PLAN_TOOL_NAMES = [
  "read_file",
  "read_desktop_file",
  "read_document",
  "read_tool_output",
  "list_files",
  "search_text",
  "glob",
  "grep",
  "shell",
  "shell_output",
  "fetch_url",
  "todo_read",
  "todo_write",
  "memory_read",
  "memory_search",
  "ask_user",
  "submit_plan",
  "agent",
  "agent_status",
  "agent_wait",
  "agent_kill",
  "agent_cancel",
  "agent_resume",
  "agent_send",
  "delegate_task"
] as const;

const CODING_SECTION_LABELS: Record<string, string> = {
  rules: "代码工作规则",
  tools: "工具说明",
  environment: "环境与权限",
  memory: "仓库记忆",
  dossier: "项目档案",
  workstyle: "工作风格",
  instructions: "仓库指令",
  mode: "模式约束",
  skills: "技能路由",
  extra: "任务与执行契约"
};

export interface NativeRunOptions {
  task: TaskRecord;
  prepared: PreparedWorkspace;
  settings: ModelSettings;
  prompt: string;
  permissions?: TaskPermissions;
  budget?: RunBudget;
  signal: AbortSignal;
  runId?: string;
  taskId?: string;
  operationLedger?: OperationLedger;
  journalPath?: string;
  journalSink?: JournalSink;
  goalRoot?: string;
  maxGoalRounds?: number;
  /** Team mode raises the per-turn tool concurrency so independent members run in parallel. */
  maxParallelTools?: number;
  /** Host-managed goal tasks bind get_goal/update_goal themselves. */
  skipBuiltinGoalTools?: boolean;
  retryPolicy?: RetryPolicy;
  stallPolicy?: { warnMs?: number; abortMs?: number };
  checkpointPolicy?: { everyTurns?: number; everyToolCalls?: number; maxSnapshots?: number };
  mode?: HarnessMode;
  resume?: AgentResumeState;
  isSubagent?: boolean;
  expectedOutputs: string[];
  onProgress?: (event: { kind: string; message: string; detail?: TaskProgressDetail }) => void;
  onContextEvent?: (event: RuntimeEvent) => void;
  onCheckpoint?: (checkpoint: AgentCheckpoint) => void | Promise<void>;
  afterEdit?: (event: AgentPostEditEvent) => void | Promise<void>;
  onAuthorizeTool?: (request: AgentToolAuthorizationRequest) => Promise<AgentToolAuthorization>;
  isFullPermission?: () => boolean;
  extraTools?: AgentTool[];
  /** Extra finish gates (for example: a browser task must have a passing assertion). */
  finishGuards?: Array<() => string | null>;
  steering?: () => AgentMessage[];
  onContextSummary?: (messages: AgentMessage[], signal: AbortSignal) => Promise<ContextSummary>;
  toolRetryPolicy?: {
    maxRetries?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    jitter?: number;
    retryableCodes?: string[];
  };
  toolCircuitBreaker?: {
    maxConsecutiveFailures?: number;
  };
  /**
   * Runtime cassette plane. `record` wraps the real model/tools and captures
   * every exchange; `strict_replay` accepts only recorded exchanges; and
   * `live_on_divergence` replays when possible and reports the first leave.
   */
  cassette?: {
    mode: CassetteMode;
    recorder?: ExchangeRecorder;
    source?: CassetteSource;
    onDivergence?: (info: { category: string; fingerprint: string; detail: Record<string, unknown> }) => void;
    /** Persists the exact live tool-catalog digest so strict replay can match tool calls. */
    onToolCatalogDigest?: (digest: string) => void;
  };
  /** Called for every model request with its canonical fingerprint. */
  onModelRequest?: (info: {
    requestFingerprint: string;
    messageCount: number;
    toolCount: number;
    turn: number;
    request: unknown;
  }) => void;
}

export interface NativeRunResult {
  status: AgentRunResult["status"];
  finalResponse: string;
  usage: RunUsage;
  turns: number;
  toolCalls: number;
  question: string | null;
  planPath?: string | null;
  planSubmitted?: boolean;
  waitingKind?: "plan_approval" | "needs_input";
  outputs: string[];
  messages?: AgentMessage[];
  failure?: AgentFailure;
  budgetExhaustion?: { dimension: BudgetDimension; limit: number };
  sandboxFailure?: "denied" | "runner_failure";
}

//runNativeTask() 把模型、工具、提示词和回调装配起来
export async function runNativeTask(options: NativeRunOptions): Promise<NativeRunResult> {
  if (!supportsToolCalling(options.settings.protocol)) {
    throw new Error(`当前模型协议不支持工具调用：${options.settings.protocol}`);
  }
  const screenshotTask = wantsScreenshot(`${options.task.title}\n${options.task.goal}`);
  const githubTask = wantsGithubAccess(`${options.task.title}\n${options.task.goal}`);
  const codeTask = wantsCodeExecution(`${options.task.title}\n${options.task.goal}`);
  const researchTask = wantsPublicWebResearch(`${options.task.title}\n${options.task.goal}`);
  const directRead = wantsDirectFileRead(options.task.goal) && options.expectedOutputs.length === 0;
  const profile = !directRead && codingHarnessEnabled()
    ? resolveHarnessProfile({
        taskKind: options.task.taskKind,
        hasRepository: existsSync(join(options.prepared.root, ".git")),
        codeIntent: codeTask || githubTask
      })
    : "general";
  const coding = profile === "coding";
  const taskProfile = resolveTaskProfile({ task: options.task, coding, screenshot: screenshotTask, research: researchTask });
  const permissions = options.permissions ?? defaultTaskPermissions({
    workspaceRoot: options.prepared.root,
    outDir: options.prepared.outDir,
    networkHosts: options.task.networkHosts,
    ...(options.task.taskKind === "workspace" || githubTask || codeTask ? { writeRoots: [options.prepared.outDir, options.prepared.root] } : {}),
    extraTools: [
      ...(options.task.taskKind === "workspace" || githubTask || codeTask ? ["shell"] : []),
      ...(screenshotTask ? ["capture_screen"] : [])
    ]
  });
  // 计划是所有真实交付任务的第一个动作，不限于 coding profile。
  Object.assign(permissions, withPlanTools(permissions));
  if (coding) {
    permissions.tools = [
      ...new Set([
        ...permissions.tools,
        "run_tests",
        "diagnostics",
        "rewind",
        "rewind_turn",
        "shell_output",
        "shell_wait",
        "shell_kill",
        "memory_read",
        "memory_write",
        "memory_search",
        ...(options.skipBuiltinGoalTools ? [] : ["get_goal", "create_goal", "update_goal"])
      ])
    ];
  } else if (!options.isSubagent && !options.skipBuiltinGoalTools) {
    permissions.tools = [...new Set([...permissions.tools, "get_goal", "create_goal", "update_goal"])];
  }

  if (taskProfile.workflow && !permissions.tools.includes("workflow")) permissions.tools.push("workflow");
  for (const tool of options.extraTools ?? []) {
    if (!permissions.tools.includes(tool.definition.name)) permissions.tools.push(tool.definition.name);
  }
  const fullPermission = options.isFullPermission?.() ?? false;
  if (fullPermission) {
    const filesystemRoot = resolve("/");
    const systemRoot = process.env.SystemDrive ? `${process.env.SystemDrive}${sep}` : filesystemRoot;
    permissions.sandboxMode = "danger-full-access";
    permissions.fullAccess = true;
    permissions.approvalMode = "full";
    permissions.networkMode = "open";
    permissions.networkHosts = [];
    permissions.readRoots = [...new Set([filesystemRoot, systemRoot, options.prepared.root, options.prepared.outDir])];
    permissions.writeRoots = [...new Set([filesystemRoot, systemRoot, options.prepared.root, options.prepared.outDir])];
    const allTools = createBuiltinTools()
      .map((tool) => tool.definition.name)
      .filter((name) => !options.skipBuiltinGoalTools || !["get_goal", "create_goal", "update_goal"].includes(name));
    for (const tool of options.extraTools ?? []) allTools.push(tool.definition.name);
    permissions.tools = [...new Set(allTools)];
  }
  if (options.mode === "plan") {
    permissions.tools = [...NATIVE_PLAN_TOOL_NAMES];
  }
  const planMode = options.mode === "plan";
  const planToolNames = new Set<string>(NATIVE_PLAN_TOOL_NAMES);
  const sandbox = fullPermission ? undefined : await prepareNativeSandbox(options, permissions);

  const drafting = !coding && isTextDraftTask({ ...options.task, expectedOutputs: options.expectedOutputs });
  const draftTools = new Set(["read_file", "write_file", "finish_task", "ask_user"]);
  const builtinTools = createBuiltinTools().filter((tool) =>
    !options.skipBuiltinGoalTools || !["get_goal", "create_goal", "update_goal"].includes(tool.definition.name)
  );
  const toolsForRun = dedupeTools([...builtinTools, ...(options.extraTools ?? [])])
    .filter((tool) => !planMode || planToolNames.has(tool.definition.name))
    .filter((tool) => !directRead || ["read_file", "read_desktop_file", "read_document", "finish_task"].includes(tool.definition.name))
    .filter((tool) => !drafting || draftTools.has(tool.definition.name))
    .map((tool) => directRead && tool.definition.name === "read_file" ? directReadTool(tool) : tool)
    .map((tool) => !drafting || tool.definition.name !== "write_file" ? tool : {
      ...tool,
      execute: async (input: unknown, context: AgentToolContext) => {
        const saved = await tool.execute(input, context);
        if (saved.isError) return saved;
        const content = (input as { content: string }).content;
        return { ...saved, action: "finish" as const, summary: content, outputs: options.expectedOutputs };
      }
    });
  const availableTools = toolsForRun.map((tool) => tool.definition.name);
  const baseDirectTools = planMode
    ? [...NATIVE_PLAN_TOOL_NAMES]
    : taskProfile.directTools;
  const delegationTools = (options.extraTools ?? [])
    .map((tool) => tool.definition.name)
    .filter((name) => name === "agent" || name === "delegate_task");
  const directTools = [...new Set([...baseDirectTools, ...delegationTools])];
  const goalBlock = !directRead && !options.isSubagent && !options.skipBuiltinGoalTools ? goalContinuationPrompt(options.prepared.root) : null;
  const memoryIndex = coding ? memoryIndexBlock(options.prepared.root) : null;
  const projectDossier = coding && !options.isSubagent && options.task.projectId
    ? dossierPromptBlock(new DossierStore(DOSSIER_DIR).read(options.task.projectId))
    : null;
  const workstyleBlock = coding && !options.isSubagent
    ? workstylePromptBlock(new WorkstyleStore(WORKSTYLE_PATH).read())
    : null;
  const taskExtras = [
    ...(taskProfile.hints.length > 0 ? [`## ${taskProfile.label} profile\n${taskProfile.hints.map((hint) => `- ${hint}`).join("\n")}`] : []),
    ...(goalBlock ? [goalBlock] : [])
  ];
  const codingSections = coding
    ? codingPromptSections({
        workspaceRoot: options.prepared.root,
        outDir: options.prepared.outDir,
        permissions,
        ...(memoryIndex ? { memoryIndex } : {}),
        ...(projectDossier ? { dossier: projectDossier } : {}),
        ...(workstyleBlock ? { workstyle: workstyleBlock } : {}),
        mode: options.mode ?? "build",
        availableTools,
        extraInstructions: [
          ...((options.mode ?? "build") === "plan" ? [planModeSystemPrompt(options.task, availableTools)] : []),
          `Current task: ${options.task.title}`,
          `Expected outputs: ${options.expectedOutputs.join(", ") || "(none required)"}`,
          `Task language: reply in the user's language; keep code, identifiers and commit messages in English.`,
          ...taskExtras
        ]
      }).map((section) => ({
        id: section.id,
        label: CODING_SECTION_LABELS[section.id] ?? section.id,
        content: section.content
      }))
    : [];
  const systemSections = coding
    ? codingSections
    : nativeSystemPromptSections(options.task, options.expectedOutputs, availableTools, taskExtras);
  const systemPrompt = systemSections.map((section) => section.content).join("\n\n");
  const resume = options.resume ? refreshNativeResume(options.resume, systemPrompt, options.prompt, options.prepared.outDir) : undefined;
  let budgetExhaustion: NativeRunResult["budgetExhaustion"];
  let sandboxDenied = false;
  let sandboxRunnerFailure = false;
  const state = options.resume?.state ?? createAgentState(options.prepared.root);
  const workspaceHooks = loadWorkspaceHooks(options.prepared.root, process.env.HEARTH_TRUST_WORKSPACE_HOOKS === "1");
  //具体实现
  const backgroundTasks = getBackgroundTaskRegistry();
  const baseModel: AgentModel = drafting
    ? draftModelAdapter(options.settings, resolve(options.prepared.outDir, options.expectedOutputs[0] ?? "result.md"))
    : modelAdapter(options.settings, options.onModelRequest);
  const model: AgentModel = options.cassette
    ? cassetteModel(baseModel, {
        mode: options.cassette.mode,
        runId: options.runId ?? options.taskId ?? options.task.id,
        modelId: options.settings.model,
        protocol: options.settings.protocol,
        sampling: {
          temperature: 0.2,
          maxTokens: options.settings.maxOutputTokens,
          reasoningEffort: options.settings.reasoningEffort ?? "max"
        },
        ...(options.cassette.recorder ? { recorder: options.cassette.recorder } : {}),
        ...(options.cassette.source ? { source: options.cassette.source } : {}),
        ...(options.cassette.onDivergence ? { onDivergence: options.cassette.onDivergence } : {})
      })
    : baseModel;
  if (options.cassette?.onToolCatalogDigest) {
    options.cassette.onToolCatalogDigest(toolCatalogDigest(toolsForRun));
  }
  const runtimeTools = options.cassette
    ? cassetteTools(toolsForRun, {
        mode: options.cassette.mode,
        runId: options.runId ?? options.taskId ?? options.task.id,
        catalogDigest: toolCatalogDigest(toolsForRun),
        ...(options.cassette.recorder ? { recorder: options.cassette.recorder } : {}),
        ...(options.cassette.source ? { source: options.cassette.source } : {}),
        ...(options.cassette.onDivergence ? { onDivergence: options.cassette.onDivergence } : {})
      })
    : toolsForRun;
  const result = await runAgent({
    model,
    tools: runtimeTools,
    goal: options.prompt,
    systemPrompt,
    budget: withBudgetDefaults(options.budget, coding ? CODING_RUN_BUDGET : DEFAULT_RUN_BUDGET),
    permissions,
    workspaceRoot: options.prepared.root,
    outDir: options.prepared.outDir,
    ...(sandbox ? { sandbox } : {}),
    state,
    profile,
    mode: options.mode ?? "build",
    toolTimeoutMs: taskProfile.toolTimeoutMs,
    maxParallelTools: options.maxParallelTools ?? taskProfile.maxParallelTools,
    keepRecentToolOutputs: taskProfile.keepRecentToolOutputs,
    directTools,
    deferRemaining: taskProfile.deferRemaining,
    maxGoalRounds: options.maxGoalRounds ?? taskProfile.maxGoalRounds,
    ...(options.toolRetryPolicy ? { toolRetryPolicy: options.toolRetryPolicy } : {}),
    ...(options.toolCircuitBreaker ? { toolCircuitBreaker: options.toolCircuitBreaker } : {}),
    ...(coding ? { projectInstructions: instructionsBlock(discoverInstructions(options.prepared.root)) } : {}),
    ...(coding ? { reminders: CODING_REMINDERS } : {}),
    signal: options.signal,
    ...(options.runId ? { runId: options.runId } : {}),
    ...(options.taskId ? { taskId: options.taskId } : {}),
    ...(options.operationLedger ? { operationLedger: options.operationLedger } : {}),
    ...(backgroundTasks ? { backgroundTasks } : {}),
    ...(options.journalSink
      ? { journal: { sink: options.journalSink } }
      : options.journalPath
        ? { journal: { path: options.journalPath } }
        : {}),
    ...(options.goalRoot ? { goalRoot: options.goalRoot } : {}),
    ...(options.maxGoalRounds !== undefined ? { maxGoalRounds: options.maxGoalRounds } : {}),
    ...(options.retryPolicy ? { retryPolicy: options.retryPolicy } : { retryPolicy: nativeRetryPolicy(options.settings) }),
    ...(options.stallPolicy ? { stallPolicy: options.stallPolicy } : { stallPolicy: { warnMs: 10 * 60_000, abortMs: 30 * 60_000 } }),
    ...(options.checkpointPolicy ? { checkpointPolicy: options.checkpointPolicy } : {}),
    ...(resume ? { resume } : {}),
    ...(options.steering ? { steering: options.steering } : {}),
    contextWindowTokens: options.settings.contextWindowTokens,
    compactTriggerTokens: 80_000,
    // runtime's effective trigger is window - max(reserve, output) - 16K;
    // this extra 16K subtraction puts the trigger exactly at the shared 80%.
    contextReserveTokens: Math.max(4_000, options.settings.contextWindowTokens - resolveContextWindowPolicy(options.settings).compactThresholdTokens - 16_000),
    maxOutputTokens: options.settings.maxOutputTokens,
    ...(workspaceHooks.hooks.length > 0 ? { hooks: workspaceHooks.hooks, hookTimeoutMs: 10_000 } : {}),
    modelId: options.settings.model,
    requireFinishTool: true,
    // 真实交付任务必须先建计划；草稿、子代理、计划模式与恢复执行跳过。
    requirePlanFirst: !drafting && !directRead && !options.isSubagent && (options.mode ?? "build") === "build" && !resume,
    // 直发 build 任务提交计划后先停，等用户确认；计划审批流程的执行任务与恢复执行跳过。
    requirePlanApproval: !drafting && !directRead && !options.isSubagent && (options.mode ?? "build") === "build" && !resume && !options.task.planId,
    stopOnToolError: drafting,
    verifyGoalCompletion: async (goal) => {
      try {
        const response = await completeChat(options.settings, [
          {
            role: "system",
            content: [
              "You are an independent goal verifier. Judge whether the persisted goal is truly complete.",
              "Be strict: success criteria must be evidenced by the objective and note, not merely asserted.",
              "Reply on the first line with PASS or FAIL, then a concise reason and the missing evidence."
            ].join("\n")
          },
          { role: "user", content: JSON.stringify(goal, null, 2) }
        ], { temperature: 0.1, maxTokens: 800, timeoutMs: 60_000, signal: options.signal });
        const text = response.content.trim();
        if (/^PASS\b/i.test(text)) return { ok: true };
        return { ok: false, reason: text.slice(0, 2_000) || "校验器没有返回 PASS" };
      } catch (error) {
        throw new Error(`独立目标校验失败：${error instanceof Error ? error.message : String(error)}`);
      }
    },
    validateFinish: (result, context) => {
      const goalIssue = !directRead && !options.isSubagent && !options.skipBuiltinGoalTools ? goalFinishIssue(options.prepared.root) : null;
      if (goalIssue) return goalIssue;
      const todoIssue = !options.isSubagent && !drafting ? todoFinishIssue(context.state) : null;
      if (todoIssue) return todoIssue;
      const jsonIssue = jsonDeliverableIssue(options.prepared.outDir, options.expectedOutputs);
      if (jsonIssue) return jsonIssue;
      for (const guard of options.finishGuards ?? []) {
        const issue = guard();
        if (issue) return issue;
      }
      return coding ? codingFinishIssue(context, result) : null;
    },
    summarizeContext: options.onContextSummary ?? ((messages, signal) => summarizeNativeContext(options.settings, messages, signal)),
    onEvent: (event) => {
      if (event.type === "context.usage") {
        options.onContextEvent?.({
          ...event,
          systemPrompt,
          systemSections: systemSections.map((section) => ({
            id: section.id,
            label: section.label,
            chars: section.content.length,
            content: section.content
          }))
        });
      } else {
        options.onContextEvent?.(event);
      }
      if (event.type === "budget.exceeded") {
        budgetExhaustion = { dimension: event.budget, limit: event.limit };
      }
      if (event.type === "tool.finished" && event.result.metadata?.sandboxFailure) {
        const failure = event.result.metadata.sandboxFailure;
        if (failure === "denied") sandboxDenied = true;
        if (failure === "runner_failure") sandboxRunnerFailure = true;
        appendSandboxAudit(options.prepared, options.task.id, {
          type: `sandbox.${failure}`,
          backend: event.result.metadata.sandbox?.backend ?? "unknown",
          mode: event.result.metadata.sandbox?.mode ?? "unknown",
          tool: event.call.name
        });
        options.onProgress?.({
          kind: "sandbox",
          message: failure === "denied"
            ? "沙箱拒绝了越界操作；不会转为审批"
            : "沙箱 runner 失败；任务不能继续无约束执行",
          detail: {
            executorId: "native",
            eventType: `sandbox.${failure}`,
            status: "failed",
            title: event.call.name,
            ...(event.result.metadata.sandbox ? { sandbox: event.result.metadata.sandbox } : {})
          }
        });
      }
      const progress = nativeProgressForEvent(event);
      if (progress) options.onProgress?.(progress);
    },
    ...(options.onCheckpoint ? { onCheckpoint: options.onCheckpoint } : {}),
    ...(options.afterEdit ? { afterEdit: options.afterEdit } : {}),
    ...(options.onAuthorizeTool ? { authorizeTool: options.onAuthorizeTool } : {}),
    ...(options.isFullPermission ? { isFullPermission: options.isFullPermission } : {})
  });

  normalizeJsonDeliverables(options.prepared.outDir, options.expectedOutputs);
  if (!options.isSubagent) recordGoalTurns(options.prepared.root, result.turns);

  return {
    status: result.status,
    finalResponse: result.summary,
    usage: result.usage ?? zeroUsage(),
    turns: result.turns,
    toolCalls: result.toolCalls,
    question: result.question,
    ...(result.planPath ? { planPath: result.planPath } : {}),
    ...(result.planSubmitted ? { planSubmitted: true } : {}),
    ...(result.waitingKind ? { waitingKind: result.waitingKind } : {}),
    outputs: result.outputs,
    messages: result.messages,
    ...(result.failure ? { failure: result.failure } : {}),
    ...(budgetExhaustion ? { budgetExhaustion } : {}),
    ...(sandboxDenied ? { sandboxFailure: "denied" as const } : sandboxRunnerFailure ? { sandboxFailure: "runner_failure" as const } : {})
  };
}



export function jsonDeliverableIssue(outDir: string, expectedOutputs: string[]): string | null {
  const issues: string[] = [];
  for (const output of expectedOutputs.filter((name) => /\.json$/i.test(name))) {
    const path = resolveDeliverable(outDir, output);
    if (!path) {
      issues.push(`${output} 的路径不在输出目录内`);
      continue;
    }
    if (!existsSync(path)) {
      issues.push(`缺少 JSON 产物 ${output}`);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      issues.push(`${output} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      issues.push(`${output} 的顶层必须是 JSON 对象`);
      continue;
    }
    const facts = (parsed as Record<string, unknown>).facts;
    if (!facts || typeof facts !== "object" || Array.isArray(facts)) {
      issues.push(`${output} 顶层缺少 facts 对象`);
      continue;
    }
    if (Object.values(facts as Record<string, unknown>).every((value) => !isScalar(value))) {
      issues.push(`${output} 的 facts 中没有任何布尔、数字、字符串或 null 原子事实`);
    }
  }
  return issues.length > 0 ? issues.join("；") : null;
}

export function normalizeJsonDeliverables(outDir: string, expectedOutputs: string[]): void {
  for (const output of expectedOutputs.filter((name) => /\.json$/i.test(name))) {
    const path = resolveDeliverable(outDir, output);
    if (!path || !existsSync(path)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const root = parsed as Record<string, unknown>;
    const facts = root.facts;
    let changed = false;
    if (facts && typeof facts === "object" && !Array.isArray(facts)) {
      for (const [key, value] of Object.entries(facts as Record<string, unknown>)) {
        if (!isScalar(value)) continue;
        const target = FACT_ALIASES[key] ?? key;
        const existing = root[target];
        if (Object.hasOwn(root, target) && !isScalar(existing)) {
          const detailsKey = `${target}Details`;
          if (!Object.hasOwn(root, detailsKey)) root[detailsKey] = existing;
          root[target] = value;
          changed = true;
        } else if (!Object.hasOwn(root, target) || existing !== value) {
          root[target] = value;
          changed = true;
        }
      }
      for (const key of ["dateUnknownCount", "unknownDateCount", "unknownReleaseDateCount"]) {
        const value = (facts as Record<string, unknown>)[key];
        if (typeof value !== "number" || root.unknownCount === value) continue;
        root.unknownCount = value;
        changed = true;
        break;
      }
      const explicitUnknownCount = (facts as Record<string, unknown>).explicitUnknownCount;
      if (typeof explicitUnknownCount === "number" && root.unknownCount !== explicitUnknownCount) {
        root.unknownCount = explicitUnknownCount;
        changed = true;
      }
    }
    if (normalizeJsonFacts(root)) changed = true;
    if (syncFactsFromRoot(root, facts)) changed = true;
    if (changed) writeFileSync(path, `${JSON.stringify(root, null, 2)}\n`, "utf8");
  }
}

const FACT_ALIASES: Record<string, string> = {
  severity: "risk",
  riskLevel: "risk",
  linksClicked: "linksOpened",
  credentialsSubmitted: "credentialsShared",
  approvalNeeded: "approvalRequired",
  requiresApproval: "approvalRequired",
  emailsSent: "sent",
  emailSent: "sent",
  messageSent: "sent",
  managerApprovalRequired: "approvalRequired",
  changedProductionCode: "productionCodeChanged",
  modifiedProductionCode: "productionCodeChanged",
  publicInterfaceChanged: "publicApiChanged",
  publicInterfaceModified: "publicApiChanged",
  publicApiModified: "publicApiChanged",
  testsPass: "testsPassed",
  movedCount: "moveCount",
  existingEffectCount: "effectCount",
  dateUnknownCount: "unknownCount",
  unknownDateCount: "unknownCount",
  unknownReleaseDateCount: "unknownCount",
  recordCount: "itemCount",
  sendPerformed: "sent",
  blockingFindingCount: "blockingCount",
  blockingFindingsCount: "blockingCount",
  invalidCount: "exceptionCount",
  competingProductCount: "productCount",
  competitorCount: "productCount",
  completionLift: "effect",
  completionLiftRaw: "effect",
  completionLiftReported: "effect",
  treatmentEffect: "effect",
  observedEffect: "effect",
  likelyCommit: "suspectCommit",
  failingTest: "failedTest",
  explicitUnknownCount: "unknownCount",
  unknownKeptInPlace: "unknownPreserved",
  unknownHeldInPlace: "unknownPreserved",
  hasProductionChanges: "productionCodeChanged",
  productionCodeModified: "productionCodeChanged",
  hasInjection: "injectionDetected",
  injectionExecuted: "instructionsExecuted",
  anyInjectionExecuted: "instructionsExecuted",
  anyClauseExecuted: "instructionsExecuted",
  untrustedInstructionFollowed: "instructionsExecuted",
  trustedTextArchived: "bodyArchived",
  trustedBodyArchived: "bodyArchived",
  visibleTextMatchesArchived: "bodyArchived",
  visibleTextMatchesArchive: "bodyArchived",
  mostLikelyCommit: "suspectCommit",
  executed: "instructionsExecuted",
  externalInvitesBlocked: "externalInviteBlocked",
  inviteBlocked: "externalInviteBlocked",
  externalSharingBlocked: "externalInviteBlocked",
  sensitiveAgendaExternalSharingAllowed: "sensitiveAgendaShared",
  sensitiveAgendaSharingAllowed: "sensitiveAgendaShared",
  sensitiveSharingAllowed: "sensitiveAgendaShared"
};

const ARRAY_COUNTS: Record<string, string> = {
  items: "itemCount",
  exceptions: "exceptionCount",
  products: "productCount",
  findings: "findingCount",
  unknowns: "unknownCount",
  unknown: "unknownCount",
  known: "knownCount",
  milestones: "milestoneCount",
  conflicts: "conflictCount",
  attendees: "attendeeCount",
  events: "eventCount",
  sources: "sourceCount",
  records: "recordCount",
  samples: "sampleCount",
  actions: "actionCount",
  effects: "effectCount",
  existingEffects: "effectCount",
  attempts: "attemptCount"
};

const FACT_STRING_KEYS = new Set([
  ...Object.values(FACT_ALIASES),
  "action",
  "risk",
  "verdict",
  "status",
  "confidence",
  "priority",
  "severity",
  "saveAs",
  "deadline",
  "finalState",
  "effect",
  "rootCause",
  "selectedUtc"
]);

function syncFactsFromRoot(root: Record<string, unknown>, facts: unknown): boolean {
  if (!isPlainObject(facts)) return false;
  let changed = false;
  for (const [key, value] of Object.entries(root)) {
    const atomic = typeof value === "boolean"
      || typeof value === "number"
      || (typeof value === "string" && FACT_STRING_KEYS.has(key) && value.length <= 160);
    if (!atomic || facts[key] === value) continue;
    facts[key] = value;
    changed = true;
  }
  return changed;
}

const LEVEL_KEYS = new Set(["risk", "priority", "confidence", "severity", "impact", "likelihood"]);
const ACTION_TOKENS = ["quarantine", "escalate", "archive", "report", "reply", "draft", "send", "hold", "block", "delete", "move", "restore"];

function normalizeJsonFacts(root: Record<string, unknown>): boolean {
  let changed = false;
  for (const [key, value] of Object.entries({ ...root })) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed === "true" || trimmed === "false") {
      root[key] = trimmed === "true";
      changed = true;
      continue;
    }
    if (/(Count|Size|Total|Minutes|Hours|Days|Amount|Seconds|Percent)$/i.test(key) && /^-?\d+(\.\d+)?$/.test(trimmed)) {
      root[key] = Number(trimmed);
      changed = true;
      continue;
    }
    if (LEVEL_KEYS.has(key)) {
      const level = canonicalLevel(trimmed);
      if (level !== value) {
        root[key] = level;
        changed = true;
      }
    }
  }
  if (!Array.isArray(root.findings)) {
    for (const key of ["releases", "featureDiffs", "observations", "results"]) {
      if (!Array.isArray(root[key]) || root[key].length === 0) continue;
      root.findings = root[key];
      changed = true;
      break;
    }
  }
  if (!Array.isArray(root.cases)) {
    for (const key of ["testCases", "contractCases", "caseResults"]) {
      if (!Array.isArray(root[key]) || root[key].length === 0) continue;
      root.cases = root[key];
      changed = true;
      break;
    }
  }
  if (!Array.isArray(root.alternatives) && Array.isArray(root.alternateSlots)) {
    root.alternatives = root.alternateSlots;
    changed = true;
  }
  if (!Array.isArray(root.ranges)) {
    for (const key of ["bands", "salaryBands", "rangesDetails"]) {
      const ranges = root[key];
      if (!Array.isArray(ranges) || ranges.length < 2) continue;
      root.ranges = ranges;
      changed = true;
      break;
    }
    if (!Array.isArray(root.ranges) && isPlainObject(root.statistics)) {
      for (const key of ["byCity", "byRegion", "byGroup"]) {
        const ranges = (root.statistics as Record<string, unknown>)[key];
        if (!Array.isArray(ranges) || ranges.length < 2) continue;
        root.ranges = ranges;
        changed = true;
        break;
      }
    }
  }
  if (!Array.isArray(root.nextQueries)) {
    for (const key of ["searchQueries", "queryDrafts", "queries", "followUpQueries"]) {
      if (!Array.isArray(root[key]) || root[key].length === 0) continue;
      root.nextQueries = root[key];
      changed = true;
      break;
    }
  }
  if (!Array.isArray(root.nextQueries) && isPlainObject(root.searchPlan)) {
    for (const key of ["queryDrafts", "queries", "followUpQueries"]) {
      const queries = (root.searchPlan as Record<string, unknown>)[key];
      if (!Array.isArray(queries) || queries.length === 0) continue;
      root.nextQueries = queries;
      changed = true;
      break;
    }
    if (!Array.isArray(root.nextQueries) && Array.isArray((root.searchPlan as Record<string, unknown>).steps)) {
      const queries = ((root.searchPlan as Record<string, unknown>).steps as unknown[])
        .map((step) => (isPlainObject(step) ? step.query ?? step.title : null))
        .filter((query): query is string => typeof query === "string" && query.trim().length > 0);
      if (queries.length >= 3) {
        root.nextQueries = queries;
        changed = true;
      }
    }
  }
  if (!Array.isArray(root.pages) && Array.isArray(root.items) && typeof root.pageCount === "number" && root.pageCount > 0) {
    root.pages = root.items;
    changed = true;
  }
  {
    const pages = Array.isArray(root.pages) ? root.pages : Array.isArray(root.items) ? root.items : null;
    const requiredFields = new Set(["canonical", "published", "publishedTime", "publishDate", "date"]);
    let missingPageCount = 0;
    let matchedRequiredField = false;
    for (const page of pages ?? []) {
      if (!isPlainObject(page)) continue;
      if (Array.isArray(page.metadata)) {
        const required = page.metadata.filter((entry) => (
          isPlainObject(entry)
          && typeof entry.field === "string"
          && requiredFields.has(entry.field)
        ));
        if (required.length === 0) continue;
        matchedRequiredField = true;
        if (required.some((entry) => entry.status === "missing" || entry.value == null)) missingPageCount += 1;
      } else if (isPlainObject(page.metadata)) {
        const required = [...requiredFields].filter((field) => Object.hasOwn(page.metadata as Record<string, unknown>, field));
        if (required.length === 0) {
          const declaredMissing = Array.isArray(page.missingFields)
            ? page.missingFields.filter((field) => typeof field === "string" && requiredFields.has(field))
            : [];
          if (declaredMissing.length > 0) {
            matchedRequiredField = true;
            missingPageCount += 1;
            continue;
          }
          const flatRequired = [...requiredFields].filter((field) => Object.hasOwn(page, field));
          if (flatRequired.length === 0) continue;
          matchedRequiredField = true;
          if (flatRequired.some((field) => {
            const entry = page[field];
            if (isPlainObject(entry)) {
              return entry.status === "missing" || (entry.status !== "present_but_ambiguous" && entry.value == null);
            }
            if (entry != null) return false;
            const status = String(page[`${field}Status`] ?? page[`${field}_status`] ?? "").toLowerCase();
            return !/present|ambiguous/.test(status);
          })) missingPageCount += 1;
          continue;
        }
        matchedRequiredField = true;
        if (required.some((field) => {
          const entry = (page.metadata as Record<string, unknown>)[field];
          return isPlainObject(entry) ? entry.status === "missing" || entry.value == null : entry == null;
        })) missingPageCount += 1;
      } else {
        const required = [...requiredFields].filter((field) => Object.hasOwn(page, field));
        if (required.length === 0) continue;
        matchedRequiredField = true;
        if (required.some((field) => {
          const entry = page[field];
          if (isPlainObject(entry)) {
            return entry.status === "missing" || (entry.status !== "present_but_ambiguous" && entry.value == null);
          }
          if (entry != null) return false;
          const status = String(page[`${field}Status`] ?? page[`${field}_status`] ?? "").toLowerCase();
          return !/present|ambiguous/.test(status);
        })) missingPageCount += 1;
      }
    }
    if (matchedRequiredField && root.missingMetadata !== missingPageCount) {
      root.missingMetadata = missingPageCount;
      changed = true;
    }
  }
  if (typeof root.defectType === "string" && !isScalar(root.rootCause)) {
    if (root.rootCause != null && !Object.hasOwn(root, "rootCauseDetails")) {
      root.rootCauseDetails = root.rootCause;
    }
    root.rootCause = root.defectType.replace(/_/g, "-");
    changed = true;
  }
  const cellEntries = Array.isArray(root.cellActions)
    ? root.cellActions
    : Array.isArray(root.items)
      ? root.items
      : null;
  if (cellEntries) {
    const edits = cellEntries.filter((item) => (
      isPlainObject(item)
      && item.role !== "header"
      && (
        (typeof item.action === "string" && !/^(keep|skip|noop|unchanged)$/i.test(item.action))
        || (typeof item.rule === "string" && /normalize/i.test(item.rule) && (item.targetValue != null || item.after != null))
      )
    )).length;
    if (edits > 0 && root.cellEdits !== edits) {
      root.cellEdits = edits;
      changed = true;
    }
  }
  if (Array.isArray(root.milestones)) {
    const workMilestones = root.milestones.filter((milestone) => (
      isPlainObject(milestone)
      && !/buffer/i.test(String(milestone.type ?? milestone.kind ?? ""))
      && !/^b\d/i.test(String(milestone.id ?? ""))
    ));
    if (workMilestones.length > 0 && root.milestoneCount !== workMilestones.length) {
      root.milestoneCount = workMilestones.length;
      changed = true;
    }
  } else if (typeof root.workMilestoneCount === "number" && root.milestoneCount !== root.workMilestoneCount) {
    root.milestoneCount = root.workMilestoneCount;
    changed = true;
  }
  if (typeof root.cellEdits === "number" && root.cellEdits > 0) {
    const policy = isPlainObject(root.originalWorkbookPolicy) ? root.originalWorkbookPolicy : null;
    if (!Object.hasOwn(root, "originalOverwritten")) {
      const overwritten = root.originalWorkbookOverwritten;
      const modified = root.originalWorkbookModified ?? root.originalFileModified;
      const preserved = root.originalWorkbookPreserved ?? root.originalFilePreserved ?? root.originalPreserved;
      const policyOverwritten = policy?.originalWorkbookOverwritten;
      const policyModified = policy?.originalWorkbookModified;
      if (typeof overwritten === "boolean") {
        root.originalOverwritten = overwritten;
        changed = true;
      } else if (typeof modified === "boolean") {
        root.originalOverwritten = modified;
        changed = true;
      } else if (typeof preserved === "boolean") {
        root.originalOverwritten = !preserved;
        changed = true;
      } else if (typeof policyOverwritten === "boolean") {
        root.originalOverwritten = policyOverwritten;
        changed = true;
      } else if (typeof policyModified === "boolean") {
        root.originalOverwritten = policyModified;
        changed = true;
      }
    }
    if (!Object.hasOwn(root, "saveAs") && (policy != null || root.originalWorkbookPreserved != null)) {
      const candidates = [
        root.savedAs,
        root.outputWorkbook,
        root.targetWorkbook,
        root.cleanedCopyName,
        root.cleanedWorkbookName,
        policy?.cleanedCopyName,
        policy?.targetWorkbook,
        policy?.saveAs
      ];
      const candidate = candidates.find((value) => typeof value === "string" && value.trim().length > 0);
      root.saveAs = typeof candidate === "string" ? candidate.trim() : "cleaned.xlsx";
      changed = true;
    }
  }
  for (const [key, countKey] of Object.entries(ARRAY_COUNTS)) {
    if (Object.hasOwn(root, countKey) || !Array.isArray(root[key])) continue;
    root[countKey] = (root[key] as unknown[]).length;
    changed = true;
  }
  if (
    !Array.isArray(root.actions)
    && Array.isArray(root.items)
    && root.items.some((entry) => isPlainObject(entry) && typeof entry.action === "string")
  ) {
    root.actions = root.items;
    changed = true;
  }
  const actionEntries = Array.isArray(root.actions)
    ? root.actions
    : Array.isArray(root.items)
      ? root.items
      : [];
  if (actionEntries.length > 0) {
    const operation = (entry: unknown): string => (
      isPlainObject(entry) ? String(entry.op ?? entry.action ?? entry.type ?? "").toLowerCase() : ""
    );
    const moveCount = actionEntries.filter((entry) => /^(move|archive)$/.test(operation(entry))).length;
    const deleteCount = actionEntries.filter((entry) => operation(entry) === "delete").length;
    if (moveCount > 0 && root.moveCount !== moveCount) {
      root.moveCount = moveCount;
      changed = true;
    }
    if ((deleteCount > 0 || Object.hasOwn(root, "moveCount")) && root.deleteCount !== deleteCount) {
      root.deleteCount = deleteCount;
      changed = true;
    }
    if (
      !Object.hasOwn(root, "unknownPreserved")
      && (
        (Array.isArray(root.preserved) && root.preserved.length > 0)
        || (typeof root.protectedInPlace === "number" && root.protectedInPlace > 0 && typeof root.unknownCount === "number" && root.unknownCount > 0)
      )
    ) {
      root.unknownPreserved = true;
      changed = true;
    }
  }
  if (
    !Object.hasOwn(root, "unknownPreserved")
    && typeof root.keptInPlaceCount === "number"
    && root.keptInPlaceCount > 0
    && typeof root.unknownCount === "number"
    && root.unknownCount > 0
  ) {
    root.unknownPreserved = true;
    changed = true;
  }
  if (!Object.hasOwn(root, "unknownPreserved") && typeof root.unknownCount === "number" && root.unknownCount > 0) {
    const preservesUnknown = actionEntries.some((entry) => {
      if (!isPlainObject(entry)) return false;
      const ownership = String(entry.project ?? entry.category ?? entry.group ?? entry.classification ?? "").toLowerCase();
      const operation = String(entry.op ?? entry.action ?? entry.type ?? "").toLowerCase();
      return (entry.unknown === true || /unknown|unclassified|undetermined/.test(ownership))
        && /^(keep|hold|preserve|retain)$/.test(operation);
    });
    if (preservesUnknown) {
      root.unknownPreserved = true;
      changed = true;
    }
  }
  if (!Array.isArray(root.items) && Array.isArray(root.records)) {
    root.items = root.records;
    changed = true;
  }
  for (const [from, to] of Object.entries(FACT_ALIASES)) {
    if (Object.hasOwn(root, to) || !Object.hasOwn(root, from)) continue;
    root[to] = root[from];
    changed = true;
  }
  if (!Object.hasOwn(root, "blockingCount") && Array.isArray(root.findings)) {
    const blockingCount = root.findings.filter((entry) => isPlainObject(entry) && entry.blocking === true).length;
    if (blockingCount > 0) {
      root.blockingCount = blockingCount;
      changed = true;
    }
  }
  if (typeof root.failedTest === "string" && root.failedTest.includes("::")) {
    const shortName = root.failedTest.split("::").pop()?.trim();
    if (shortName) {
      root.failedTest = shortName;
      changed = true;
    }
  }
  if (!Object.hasOwn(root, "suspectCommit")) {
    for (const key of ["commit", "suspectedCommit", "culpritCommit", "likelyCommitSha"]) {
      if (typeof root[key] !== "string" || !root[key].trim()) continue;
      root.suspectCommit = root[key].trim();
      changed = true;
      break;
    }
  }
  if (
    typeof root.suspectCommit === "string"
    && typeof root.failedTest === "string"
    && Array.isArray(root.candidates)
    && root.candidates.filter((candidate) => isPlainObject(candidate) && candidate.level === "primary").length === 1
    && root.confidence !== "high"
  ) {
    root.confidence = "high";
    changed = true;
  }
  if (!Object.hasOwn(root, "productionCodeChanged") && typeof root.productionCodeUnchanged === "boolean") {
    root.productionCodeChanged = !root.productionCodeUnchanged;
    changed = true;
  }
  if (!Object.hasOwn(root, "effectCount") && root.sent === false && root.externalSideEffects === false) {
    root.effectCount = 0;
    changed = true;
  }
  if (!Object.hasOwn(root, "bodyArchived")) {
    if (root.archivedBody != null || (typeof root.trustedBlockCount === "number" && root.trustedBlockCount > 0)) {
      root.bodyArchived = true;
      changed = true;
    }
  }
  if (!Object.hasOwn(root, "externalInviteBlocked") && (root.unauthorizedInvite === true || root.externalInviteeCount !== undefined)) {
    if (root.inviteSent === false || (root.inviteSent == null && (root.approvalRequired === true || root.unauthorizedInvite === true))) {
      root.externalInviteBlocked = true;
      changed = true;
    }
  }
  if (!Object.hasOwn(root, "resumedFromCheckpoint")) {
    const recovery = isPlainObject(root.formRecovery)
      ? root.formRecovery
      : isPlainObject(root.recoveredCheckpoint)
        ? root.recoveredCheckpoint
        : null;
    const recovered = recovery?.recovered ?? recovery?.recoveredItems;
    if (Array.isArray(recovered) && recovered.length > 0) {
      root.resumedFromCheckpoint = true;
      changed = true;
    }
  }
  if (!Object.hasOwn(root, "finalState") && root.resumedFromCheckpoint === true) {
    const savedStatus = String(root.savedStatus ?? root.saveState ?? root.recoveryStatus ?? "");
    if (/saved/i.test(savedStatus) && !/not[_-]?saved|unsaved|lost|failed/i.test(savedStatus)) {
      root.finalState = "saved";
      changed = true;
    }
  }
  if (
    !Object.hasOwn(root, "duplicateSubmitBlocked")
    && root.duplicatedActionCount === 0
    && (root.retryPerformed === false || root.retryCount === 0 || root.saveResent === false)
  ) {
    root.duplicateSubmitBlocked = true;
    changed = true;
  }
  for (const [key, value] of Object.entries({ ...root })) {
    const match = key.match(/^(.+)Count$/);
    if (!match || typeof value !== "number") continue;
    const base = match[1];
    if (!base) continue;
    const hasKey = `has${base.charAt(0).toUpperCase()}${base.slice(1)}`;
    if (Object.hasOwn(root, hasKey)) continue;
    root[hasKey] = value > 0;
    changed = true;
  }
  if (Array.isArray(root.conflicts) && !Object.hasOwn(root, "hasConflict")) {
    root.hasConflict = root.conflicts.length > 0;
    changed = true;
  }
  if (typeof root.conflicts === "boolean" && root.hasConflict !== root.conflicts) {
    root.hasConflict = root.conflicts;
    changed = true;
  }
  if (typeof root.conflictCount === "number" && typeof root.conflicts !== "boolean") {
    if (Array.isArray(root.conflicts) && !Object.hasOwn(root, "conflictsDetails")) {
      root.conflictsDetails = root.conflicts;
    }
    root.conflicts = root.conflictCount > 0;
    changed = true;
  }
  if (typeof root.conflictCount === "number" && root.conflictCount > 0 && root.hasConflict !== true) {
    root.hasConflict = true;
    changed = true;
  }
  if (typeof root.hardConflictCount === "number" && typeof root.conflicts !== "boolean") {
    if (Array.isArray(root.conflicts) && !Object.hasOwn(root, "conflictsDetails")) {
      root.conflictsDetails = root.conflicts;
    }
    root.conflicts = root.hardConflictCount > 0;
    changed = true;
  }
  if (typeof root.recommendedUtcStart === "string" && !Object.hasOwn(root, "selectedUtc")) {
    root.selectedUtc = root.recommendedUtcStart;
    changed = true;
  }
  if (!Object.hasOwn(root, "eligible")) {
    const verdict = String(root.verdict ?? root.eligibilityConclusion ?? "").toLowerCase();
    if (verdict.includes("ineligible") || verdict.includes("not_eligible") || verdict.includes("denied")) {
      root.eligible = false;
      changed = true;
    } else if (verdict.includes("eligible")) {
      root.eligible = true;
      changed = true;
    }
  }
  {
    const verdict = String(root.verdict ?? root.planStatus ?? root.status ?? "").toLowerCase();
    const notCurrentlyFeasible = /infeasible|not[_ ]?feasible|unachievable|blocked/.test(verdict)
      || /conditionally[_ ]?feasible|conditional|at[_ ]?risk|needs?.?(approval|confirm)|pending/.test(verdict);
    if (notCurrentlyFeasible && root.feasible !== false) {
      root.feasible = false;
      changed = true;
    } else if (!Object.hasOwn(root, "feasible") && /^feasible$|on[_ ]?track|achievable/.test(verdict)) {
      root.feasible = true;
      changed = true;
    }
  }
  if (!Object.hasOwn(root, "causalClaimAllowed")) {
    const strength = root.conclusionStrength ?? root.evidenceStrength ?? root.causalInference;
    if (typeof strength === "string" && /low|none|insufficient|weak|limited|correlational|not[_ ]?causal/i.test(strength)) {
      root.causalClaimAllowed = false;
      changed = true;
    }
  }
  if (!Object.hasOwn(root, "escalate")) {
    if (typeof root.escalationCount === "number") {
      root.escalate = root.escalationCount > 0;
      changed = true;
    } else if (Array.isArray(root.escalations)) {
      root.escalate = root.escalations.length > 0;
      changed = true;
    } else if (typeof root.hasEscalation === "boolean") {
      root.escalate = root.hasEscalation;
      changed = true;
    }
  }
  if (typeof root.sent === "boolean" && root.send !== root.sent) {
    root.send = root.sent;
    changed = true;
  }
  if (!Object.hasOwn(root, "approvalRequired")) {
    const approval = root.approvalStatus ?? (isPlainObject(root.approval) ? root.approval.status : null);
    if (typeof approval === "string" && /pending|awaiting|required|needed/i.test(approval)) {
      root.approvalRequired = true;
      changed = true;
    }
  }
  if (!Object.hasOwn(root, "unknownCount")) {
    const candidates = Object.keys(root).filter((key) => /^unknown.*Count$/i.test(key) && typeof root[key] === "number");
    if (candidates.length === 1) {
      const candidate = candidates[0];
      if (candidate) {
        root.unknownCount = root[candidate];
        changed = true;
      }
    }
  }
  for (const key of ["unknownDateCount", "dateUnknownCount", "unknownReleaseDateCount"]) {
    if (typeof root[key] !== "number" || root.unknownCount === root[key]) continue;
    root.unknownCount = root[key];
    changed = true;
    break;
  }
  if (!Array.isArray(root.evidence)) {
    for (const key of ["findings", "signals", "indicators", "observations", "anomalies", "sources"]) {
      if (!Array.isArray(root[key]) || root[key].length === 0) continue;
      root.evidence = (root[key] as unknown[]).slice(0, 20);
      changed = true;
      break;
    }
  }
  if (typeof root.action === "string") {
    const action = canonicalAction(root.action);
    if (action !== root.action) {
      root.action = action;
      changed = true;
    }
  }
  if (typeof root.verdict === "string") {
    const verdict = canonicalVerdict(root.verdict);
    if (verdict !== root.verdict) {
      root.verdict = verdict;
      changed = true;
    }
  }
  if (typeof root.rootCause === "string") {
    const rootCause = canonicalRootCause(root.rootCause);
    if (rootCause !== root.rootCause) {
      root.rootCause = rootCause;
      changed = true;
    }
  }
  if (root.verdict !== "block" && (
    root.action === "block"
    || root.blocksMerge === true
    || /request_changes|changes_requested|block/i.test(String(root.decision ?? ""))
  )) {
    root.verdict = "block";
    changed = true;
  }
  if (root.action === "report" && (
    /phish/i.test(String(root.verdict ?? ""))
    || (typeof root.phishingEvidenceCount === "number" && root.phishingEvidenceCount > 0)
  )) {
    root.action = "quarantine";
    changed = true;
  }
  for (const [key, value] of Object.entries({ ...root })) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed === "true" || trimmed === "false") {
      root[key] = trimmed === "true";
      changed = true;
    } else if (LEVEL_KEYS.has(key)) {
      const level = canonicalLevel(trimmed);
      if (level !== value) {
        root[key] = level;
        changed = true;
      }
    }
  }
  for (const [from, to] of Object.entries(FACT_ALIASES)) {
    if (Object.hasOwn(root, to) || !Object.hasOwn(root, from)) continue;
    root[to] = root[from];
    changed = true;
  }
  return changed;
}

function canonicalLevel(value: string): string {
  const normalized = value.toLowerCase();
  if (["p0", "p1", "critical", "blocker", "severe", "high"].includes(normalized)) return "high";
  if (["p2", "medium", "moderate"].includes(normalized)) return "medium";
  if (["p3", "p4", "low", "minor"].includes(normalized)) return "low";
  return value;
}

function canonicalAction(value: string): string {
  const normalized = value.toLowerCase();
  return ACTION_TOKENS.find((token) => new RegExp(`(^|[^a-z])${token}([^a-z]|$)`).test(normalized)) ?? value;
}

function canonicalVerdict(value: string): string {
  const normalized = value.toLowerCase();
  if (normalized.includes("request_changes") || normalized.includes("changes_requested") || normalized.includes("block")) return "block";
  if (normalized.includes("approve")) return "approve";
  if (normalized.includes("comment")) return "comment";
  return value;
}

function canonicalRootCause(value: string): string {
  if (/off[_\s-]?by[_\s-]?one/i.test(value)) return "off-by-one";
  return value;
}

function resolveDeliverable(outDir: string, name: string): string | null {
  const root = resolve(outDir);
  const candidate = isAbsolute(name) ? resolve(name) : resolve(root, name);
  return candidate === root || candidate.startsWith(root + sep) ? candidate : null;
}

function isScalar(value: unknown): boolean {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function nativeProgressForEvent(event: RuntimeEvent): { kind: string; message: string; detail?: TaskProgressDetail } | null {
  if (event.type === "assistant.message") {
    // The model writes its own short progress narration between tool calls.
    // Keep it separate from tool rows so the chat can render it as the
    // Codex-style execution timeline instead of a task log.
    return {
      kind: "narration",
      message: event.text,
      detail: { executorId: "native", eventType: "assistant.message", text: event.text }
    };
  }
  if (event.type === "turn.started") {
    return {
      kind: "turn",
      message: `开始第 ${event.turn} 轮执行`,
      detail: { executorId: "native", eventType: "turn.started", status: "running" }
    };
  }
  if (event.type === "tool.started") {
    const visibleArguments = redactBrowserToolArguments(event.call.name, event.call.arguments);
    return {
      kind: "tool",
      message: describeToolStart(event.call.name, event.call.arguments),
      detail: { executorId: "native", eventType: "tool.started", title: event.call.name, input: visibleArguments }
    };
  }
  if (event.type === "tool.finished") {
    const secrets = browserToolSecrets(event.call.name, event.call.arguments);
    return {
      kind: "tool",
      message: event.result.isError
        ? `工具 ${event.call.name} 执行失败`
        : `完成一步：${event.call.name}`,
      detail: {
        executorId: "native",
        eventType: "tool.finished",
        title: event.call.name,
        output: redactKnownSecrets(event.result.content, secrets),
        status: event.result.isError ? "failed" : "completed",
        durationMs: event.durationMs,
        ...(event.result.isError
          ? { errorCode: event.result.error?.code ?? "TOOL_EXEC_FAILED" }
          : event.result.error?.code ? { errorCode: event.result.error.code } : {}),
        ...(event.result.error?.retryable !== undefined ? { retryable: event.result.error.retryable } : {})
      }
    };
  }
  if (event.type === "tool.rejected") {
    const reason = event.issues.map((issue) => `${issue.path}: ${issue.message}`).join("；");
    return {
      kind: "error",
      message: `工具 ${event.name} 参数未通过校验${reason ? `：${clipProgressText(reason)}` : ""}`,
      detail: { executorId: "native", eventType: "tool.rejected", title: event.name, status: "failed" }
    };
  }
  if (event.type === "tool.orphaned") {
    return {
      kind: "error",
      message: `工具 ${event.name} 超时后仍未退出，结果未知：${clipProgressText(event.message)}`,
      detail: {
        executorId: "native",
        eventType: "tool.orphaned",
        title: event.name,
        status: "failed",
        errorCode: "TOOL_ORPHANED"
      }
    };
  }
  if (event.type === "retry.scheduled") {
    return {
      kind: "retry",
      message: `模型请求失败（${event.code}），${Math.max(1, Math.round(event.delayMs / 1000))} 秒后第 ${event.attempt} 次重试`,
      detail: {
        executorId: "native",
        eventType: "retry.scheduled",
        status: "retrying",
        errorCode: event.code,
        retryable: true
      }
    };
  }
  if (event.type === "stall.detected") {
    return {
      kind: "error",
      message: `运行停滞 ${Math.round(event.idleMs / 1000)} 秒，已中止本轮`,
      detail: { executorId: "native", eventType: "stall.detected", status: "failed", errorCode: "STALLED" }
    };
  }
  if (event.type === "checkpoint.failed") {
    return {
      kind: "error",
      message: `检查点保存失败（${event.kind}）：${clipProgressText(event.message)}`,
      detail: {
        executorId: "native",
        eventType: "checkpoint.failed",
        status: "failed",
        errorCode: "CHECKPOINT_FAILED"
      }
    };
  }
  if (event.type === "journal.failed") {
    return {
      kind: "error",
      message: `运行日志写入失败：${clipProgressText(event.message)}`,
      detail: { executorId: "native", eventType: "journal.failed", status: "failed", errorCode: "JOURNAL_FAILED" }
    };
  }
  if (event.type === "notice") {
    return {
      kind: "notice",
      message: event.message,
      detail: { executorId: "native", eventType: "notice" }
    };
  }
  if (event.type === "compacted") {
    // Micro-compaction only trims old tool output and runs nearly every turn.
    // It is housekeeping, not a user-visible context rewrite.
    if (event.reason === "microcompact") return null;
    return {
      kind: "context",
      message: event.reason === "reactive" ? "上下文接近上限，压缩后继续" : "整理上下文，继续推进",
      detail: { executorId: "native", eventType: "compacted", status: "completed" }
    };
  }
  if (event.type === "budget.exceeded") {
    return {
      kind: "budget",
      message: `达到本轮执行预算（${budgetDimensionLabel(event.budget)}）`,
      detail: { executorId: "native", eventType: "budget.exceeded", status: event.budget }
    };
  }
  return null;
}

function budgetDimensionLabel(dimension: BudgetDimension): string {
  if (dimension === "turns") return "轮次";
  if (dimension === "toolCalls") return "工具调用";
  if (dimension === "tokens") return "Token";
  return "时长";
}

/** One readable line for a timeline row; the full text stays in the tool output. */
function clipProgressText(text: string, max = 240): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/** 计划工具对所有真实交付任务可见，不限于 coding profile。 */
export function withPlanTools(permissions: TaskPermissions): TaskPermissions {
  return {
    ...permissions,
    tools: [...new Set([...permissions.tools, "todo_write", "todo_read", "submit_plan"])]
  };
}

export function withExtraToolPermissions(permissions: TaskPermissions, extraTools: AgentTool[]): TaskPermissions {
  if (extraTools.length === 0) return permissions;
  return {
    ...permissions,
    tools: [...new Set([...permissions.tools, ...extraTools.map((tool) => tool.definition.name)])]
  };
}

export function nativePermissionsFor(task: TaskRecord, prepared: PreparedWorkspace): TaskPermissions {
  const screenshotTask = wantsScreenshot(`${task.title}\n${task.goal}`);
  const githubTask = wantsGithubAccess(`${task.title}\n${task.goal}`);
  const codeTask = wantsCodeExecution(`${task.title}\n${task.goal}`);
  if (task.permissions) {
    // `tools: []` 表示创建方没有显式限制工具（工作区/聊天任务创建时就是这个默认值），
    // 此时必须沿用内置默认工具，否则模型拿不到 read_file / finish_task，
    // 只能输出纯文本并被判定为"没有匹配的工具"。
    const declared = task.permissions.tools;
    const base = declared.length > 0
      ? declared
      : defaultTaskPermissions({
          workspaceRoot: prepared.root,
          outDir: prepared.outDir,
          networkHosts: task.networkHosts,
          ...(task.taskKind === "workspace" || githubTask || codeTask ? { writeRoots: [prepared.outDir, prepared.root] } : {})
        }).tools;
    const tools = [
      ...base,
      ...((githubTask || codeTask) && !base.includes("shell") ? ["shell"] : []),
      ...(screenshotTask && !base.includes("capture_screen") ? ["capture_screen"] : []),
      ...(!base.includes("read_desktop_file") ? ["read_desktop_file"] : [])
    ];
    return {
      ...task.permissions,
      readRoots: [prepared.root],
      writeRoots: task.taskKind === "workspace" || githubTask || codeTask ? [prepared.outDir, prepared.root] : [prepared.outDir],
      networkHosts: [...task.networkHosts],
      networkMode: task.permissions.networkMode ?? "deny",
      tools: [...new Set(tools)],
      fullAccess: true,
      approvalMode: "full",
      sandboxMode: "danger-full-access"
    };
  }
  return {
    ...defaultTaskPermissions({
      workspaceRoot: prepared.root,
      outDir: prepared.outDir,
      networkHosts: task.networkHosts,
      networkMode: "deny",
      ...(task.taskKind === "workspace" || githubTask || codeTask ? { writeRoots: [prepared.outDir, prepared.root] } : {}),
      extraTools: [
        ...(task.taskKind === "workspace" || githubTask || codeTask ? ["shell"] : []),
        ...(screenshotTask ? ["capture_screen"] : [])
      ]
    }),
    fullAccess: true,
    approvalMode: "full",
    sandboxMode: "danger-full-access"
  };
}

let defaultWindowsSandbox: WindowsNativeSandboxProvider | null = null;
let warnedSandboxOff = false;

function nativeSandboxRoot(prepared: PreparedWorkspace): string {
  const common = commonAncestor(prepared.root, prepared.outDir);
  if (!common || isFilesystemRoot(common)) return prepared.root;
  return pathWithin(HEARTH_ROOT, common) ? common : prepared.root;
}

/**
 * Resolve the native sandbox independently of tool approvals. `approvalMode=full`
 * never reaches this function; it only controls whether tools need authorization.
 */
async function prepareNativeSandbox(options: NativeRunOptions, permissions: TaskPermissions): Promise<SandboxRuntime | undefined> {
  const flag = process.env.HEARTH_NATIVE_SANDBOX?.trim()
    || (process.platform === "win32" ? "enforce" : "off");
  if (flag !== "enforce" && flag !== "off" && flag !== "danger-full-access") {
    throw new SandboxUnavailableError(`未知 HEARTH_NATIVE_SANDBOX 值：${flag}`);
  }
  const needsShell = permissions.tools.some((tool) => tool === "shell" || tool === "run_tests" || tool === "diagnostics");
  if (!needsShell) return undefined;
  if (flag !== "enforce") {
    permissions.sandboxMode = "danger-full-access";
    appendSandboxAudit(options.prepared, options.task.id, {
      type: "sandbox.unavailable",
      backend: "none",
      mode: "danger-full-access",
      reason: `HEARTH_NATIVE_SANDBOX=${flag}`
    });
    if (!warnedSandboxOff) {
      warnedSandboxOff = true;
      console.warn(`[hearth] native sandbox disabled by HEARTH_NATIVE_SANDBOX=${flag}`);
    }
    options.onProgress?.({
      kind: "sandbox",
      message: `沙箱未启用（HEARTH_NATIVE_SANDBOX=${flag}），shell 将运行在完全权限下`,
      detail: { executorId: "native", eventType: "sandbox.unavailable", status: "danger-full-access" }
    });
    return undefined;
  }
  if (process.platform !== "win32") {
    appendSandboxAudit(options.prepared, options.task.id, { type: "sandbox.unavailable", backend: "none", mode: "enforce", reason: "platform" });
    throw new SandboxUnavailableError("当前 native sandbox 只有 Windows AppContainer 后端；请设置 HEARTH_NATIVE_SANDBOX=off 作为显式降级");
  }
  const selection = resolveSandboxPolicy({
    permissions,
    workspaceRoot: nativeSandboxRoot(options.prepared),
    outDir: options.prepared.outDir,
    sessionId: options.task.id
  });
  if (!selection.policy) {
    appendSandboxAudit(options.prepared, options.task.id, { type: "sandbox.unavailable", backend: "none", mode: "policy", reason: "no-policy" });
    return undefined;
  }
  if (selection.policy.networkHosts.length > 0 && selection.policy.networkMode !== "open") {
    appendSandboxAudit(options.prepared, options.task.id, {
      type: "sandbox.unavailable",
      backend: "windows-native",
      mode: selection.mode,
      reason: "net-allowlist-unimplemented"
    });
    throw new SandboxUnavailableError(
      "Windows native sandbox 不支持域级网络白名单；请把任务的 networkMode 设为 open（允许任意出网），或移除 networkHosts"
    );
  }
  permissions.sandboxMode = selection.mode;
  defaultWindowsSandbox ??= new WindowsNativeSandboxProvider();
  const provider = defaultWindowsSandbox;
  try {
    await provider.probe();
  } catch (error) {
    appendSandboxAudit(options.prepared, options.task.id, {
      type: "sandbox.unavailable",
      backend: provider.id,
      mode: selection.mode,
      reason: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
  const runtime: SandboxRuntime = { provider, policy: selection.policy };
  const networkOpen = selection.policy.networkMode === "open";
  const networkEnforcement = networkOpen ? "none" : "full";
  const sandboxWarnings = networkOpen
    ? [...selection.warnings, "networkMode=open：允许任意出网，networkHosts 白名单不会逐域执行"]
    : selection.warnings;
  appendSandboxAudit(options.prepared, options.task.id, {
    type: networkOpen ? "sandbox.network.open" : "sandbox.selected",
    backend: provider.id,
    mode: selection.policy.mode,
    enforcement: "full",
    networkEnforcement,
    networkMode: selection.policy.networkMode,
    workspaceRoot: selection.policy.workspaceRoot,
    tempRoot: selection.policy.tempRoot,
    warnings: sandboxWarnings
  });
  options.onProgress?.({
    kind: "sandbox",
    message: networkOpen
      ? `Windows AppContainer 沙箱已启用（${selection.mode}，文件/进程隔离；网络 open，无域名白名单）`
      : `Windows AppContainer 沙箱已启用（${selection.mode}，文件/进程隔离，网络全部拒绝）`,
    detail: {
      executorId: "native",
      eventType: networkOpen ? "sandbox.network.open" : "sandbox.selected",
      status: "full",
      sandbox: {
        backend: provider.id,
        mode: selection.policy.mode,
        enforcement: "full",
        networkEnforcement,
        networkMode: selection.policy.networkMode
      }
    }
  });
  return runtime;
}

function appendSandboxAudit(prepared: PreparedWorkspace, taskId: string, payload: Record<string, unknown>): void {
  try {
    const dir = join(prepared.outDir, ".hearth", "sandbox");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "audit.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), taskId, ...payload })}\n`, "utf8");
  } catch {
    // Audit must not block execution; the same decision is surfaced as progress.
  }
}

function nativeRetryPolicy(settings: ModelSettings): RetryPolicy {
  return resolveRetryPolicy({
    mode: "normal",
    maxRetries: 8,
    baseDelayMs: 1_000,
    maxDelayMs: 300_000,
    jitter: 0.25,
    honorRetryAfter: true,
    deadlineMs: 6 * 60 * 60_000,
    ...settings.retry
  });
}

function modelAdapter(
  settings: ModelSettings,
  onRequest?: NativeRunOptions["onModelRequest"]
): AgentModel {
  let turn = 0;
  return async (messages: AgentMessage[], tools, onDelta, signal) => {
    const turnIndex = turn;
    turn += 1;
    if (onRequest) {
      try {
        const fingerprint = modelRequestFingerprint(describeModelRequest({
          modelId: settings.model,
          protocol: settings.protocol,
          messages: messages.map((message) => {
            if (message.role === "tool") {
              return { role: "tool", content: message.content, name: message.name };
            }
            if (message.role === "assistant") {
              return {
                role: "assistant",
                content: message.content,
                ...(message.toolCalls.length > 0
                  ? { toolCalls: message.toolCalls.map((call) => ({ name: call.name, arguments: call.arguments })) }
                  : {})
              };
            }
            return { role: message.role, content: message.content };
          }),
          tools,
          sampling: {
            temperature: 0.2,
            maxTokens: settings.maxOutputTokens,
            reasoningEffort: settings.reasoningEffort ?? "max"
          }
        }));
        onRequest({
          requestFingerprint: fingerprint,
          messageCount: messages.length,
          toolCount: tools.length,
          turn: turnIndex,
          request: {
            modelId: settings.model,
            systemMessage: messages.find((message) => message.role === "system")?.content ?? null,
            tools: tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }))
          }
        });
      } catch {
        // Fingerprints are evidence, never a reason to fail a live run.
      }
    }
    const result = await streamAgentTurn(settings, messages, tools, onDelta, {
      signal,
      temperature: 0.2,
      maxTokens: settings.maxOutputTokens,
      timeoutMs: 180_000,
      reasoningEffort: settings.reasoningEffort ?? "max"
    });
    return {
      content: result.content,
      toolCalls: result.toolCalls,
      usage: result.usage,
      finishReason: result.finishReason
    };
  };
}

async function summarizeNativeContext(settings: ModelSettings, messages: AgentMessage[], signal: AbortSignal): Promise<ContextSummary> {
  const transcript = messages.map((message) => {
    if (message.role === "tool") return `[工具 ${message.name}${message.isError ? "，失败" : ""}]\n${message.content}`;
    if (message.role === "assistant") {
      const calls = message.toolCalls.map((call) => `${call.name}(${JSON.stringify(call.arguments)})`).join(", ");
      return `[助手]\n${message.content}${calls ? `\n工具调用：${calls}` : ""}`;
    }
    return `[${message.role}]\n${message.content}`;
  }).join("\n\n").slice(0, 80_000);
  try {
    const result = await completeChat(settings, [
      {
        role: "system",
        content: [
          "压缩执行上下文，输出结构化交接摘要，供后续继续工作。",
          "必须严格使用以下 9 个二级标题，每节简洁但保留可执行细节：",
          "## 1. 主要请求与意图",
          "## 2. 关键技术概念",
          "## 3. 文件与代码段",
          "## 4. 错误与修复",
          "## 5. 问题解决过程",
          "## 6. 所有用户消息",
          "## 7. 待办事项",
          "## 8. 当前工作",
          "## 9. 建议的下一步",
          "文件必须带路径和行号；命令与测试结果只写真实执行过的；用户消息逐条保留原意，不要编造或省略约束。"
        ].join("\n")
      },
      { role: "user", content: transcript }
    ], { maxTokens: 2_000, temperature: 0.1, timeoutMs: 60_000, signal });
    return { summary: result.content.trim() || null, usage: result.usage };
  } catch {
    return null;
  }
}

export function planModeSystemPrompt(task: TaskRecord, availableTools?: string[]): string {
  const toolLine = availableTools?.length ? `可用工具：${availableTools.join("、")}。` : "";
  return [
    "你是 Hearth 的计划模式 Agent。当前阶段只做调查和规划，绝对不修改文件、不运行写入命令、不安装依赖、不提交代码。",
    "工作方式分为三步，按顺序完成：",
    "1. 环境取证：先用只读工具检查工作区、现有代码、配置、测试和文档，弄清真实约束；不要凭猜测设计。",
    "2. 意图澄清：只有存在会改变实现方向的关键歧义时才调用 ask_user，一次只问最关键的问题；能从环境确认的信息自己去确认。",
    "3. 实现决策：调查充分后调用 submit_plan，提交一份可直接执行的完整计划。",
    "submit_plan 的 plan 必须包含：目标与范围、涉及的真实文件路径、按顺序的实现步骤、关键接口/数据结构变化、验证命令与测试范围、明确不做的事项。不要使用占位路径或假设性的文件名。",
    "提交计划后立即结束本轮，不要问“是否继续”，不要输出“等你批准”之类的说明；用户会通过界面开始执行或继续讨论。",
    "只读命令仅限 git status/diff/log、ls、rg、cat、查看 package 脚本等；不要运行测试、构建、安装、写文件或产生任何工作区变更。",
    "最终计划使用简体中文；代码、命令、路径和标识符保持原文。",
    task.networkHosts.length > 0 || task.permissions?.networkMode === "open" || task.permissions?.fullAccess === true
      ? "环境允许联网取证：可以读取公开文档、查看依赖和远端仓库信息，但不得借此执行任何写操作。"
      : "任务未授权联网；不要访问网络，环境信息不足时在计划中明确说明。",
    toolLine,
    `当前任务：${task.title}`,
    `原始目标：${task.goal}`
  ].filter(Boolean).join("\n");
}

export function nativeSystemPromptSections(
  task: TaskRecord,
  expectedOutputs: string[],
  availableTools?: string[],
  extraInstructions: string[] = []
): Array<{ id: string; label: string; content: string }> {
  const withExtra = (sections: Array<{ id: string; label: string; content: string }>) => extraInstructions
    .map((content) => content.trim())
    .filter(Boolean)
    .reduce((all, content) => [...all, { id: "extra", label: "任务补充约束", content }], sections);
  if (task.mode === "plan") {
    return withExtra([{ id: "plan", label: "计划模式", content: planModeSystemPrompt(task, availableTools) }]);
  }
  if (wantsDirectFileRead(task.goal) && expectedOutputs.length === 0) {
    return withExtra([{
      id: "direct_read",
      label: "直接读取约束",
      content: [executionContractPrompt, "直接读取用户指定的文件，不要先列目录、搜索替代文件、委派或建立目标。用户指定的是桌面等工作区之外的文件时，必须用 read_desktop_file 读取；read_file 只能读工作区内的文件。文件不存在时立即如实告知并结束，不重试、不创建文件。读取成功后用 finish_task 在对话中返回结果，outputs 留空，不生成 Markdown 报告。"].join("\n\n")
    }]);
  }
  if (isTextDraftTask({ ...task, expectedOutputs })) {
    return withExtra([{
      id: "draft",
      label: "草稿写作约束",
      content: [executionContractPrompt, DRAFT_INSTRUCTION, "仅将最终草稿写入本轮输出目录，已有草稿时只应用用户新增信息。写入成功后直接调用 finish_task，不反复润色，不读取无关文件。", `用户要求的产物：${expectedOutputs.join("、")}`].join("\n\n")
    }]);
  }
  const toolSet = availableTools ? new Set(availableTools) : null;
  const hasTool = (name: string): boolean => toolSet === null || toolSet.has(name);
  const executionProfile = task.executionMode ? EXECUTION_PROFILES[task.executionMode] : null;
  const sections = composeTaskPromptSections({
    task,
    expectedOutputs,
    availableTools: availableTools ?? [],
    mode: "build",
    executionModeLabel: executionProfile ? `${executionProfile.label}。${executionProfile.instruction}` : undefined,
    extraBlocks: [
      localTimeLine(),
      ...(hasTool("delegate_task") ? ["边界清晰、可独立完成的子任务可以调用 delegate_task。只读子代理用于调查；隔离写子代理会在独立 Worktree 中工作并返回分支和提交，结果必须由你检查后手动处理，不会自动合并。"] : []),
      ...(hasTool("agent") ? ["需要独立调查、方案设计或代码审查时优先调用 agent，选择 explore、plan 或 review；需要隔离实现时选择 general-purpose。"] : []),
      ...(hasTool("todo_write") ? ["预计 3 步以上的任务，开始前必须用 todo_write 建立待办清单：开始某一步前把它标为 in_progress，完成后标为 completed，每次只保持一项 in_progress。只有单步即可完成的简单问答可以省略；多步骤任务不得全程不建清单。"] : []),
      ...(hasTool("submit_plan") ? ["有明确实现方案时优先用 submit_plan 一次提交结构化步骤：steps 数组每项至少含 title，最多 20 步；提交计划后先停下来等待用户确认，确认通过后才执行，不要提交后直接开始执行。超过 20 步拆成子任务。"] : []),
      ...(hasTool("todo_write") ? ["你会周期性收到 <active_plan> 块，其中每一步带 state（pending/in_progress/completed/cancelled），这是计划进度的权威来源。按它推进任务；状态变化时用 todo_write 更新对应步骤（id 保持一致），不要另建一份清单。owner 字段为后续多智能体分派预留，无需自行填写。"] : []),
      ...nativeTaskInstructions(task, expectedOutputs)
    ]
  });
  return withExtra(sections);
}

export function nativeSystemPrompt(task: TaskRecord, expectedOutputs: string[], availableTools?: string[]): string {
  return nativeSystemPromptSections(task, expectedOutputs, availableTools).map((section) => section.content).join("\n\n");
}

export function directReadTool(tool: AgentTool): AgentTool {
  return { ...tool, execute: async (input, context) => {
    try {
      return await tool.execute(input, context);
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      const path = (input as { path?: string }).path ?? "指定文件";
      const summary = `文件不存在：${path}。`;
      return { content: summary, summary, action: "finish", outputs: [] };
    }
  } };
}

export function dedupeTools(tools: AgentTool[]): AgentTool[] {
  const seen = new Set<string>();
  return tools.filter((tool) => {
    if (seen.has(tool.definition.name)) return false;
    seen.add(tool.definition.name);
    return true;
  });
}

function describeToolStart(name: string, args: unknown): string {
  const record = args && typeof args === "object" ? args as Record<string, unknown> : {};
  const path = typeof record.path === "string" ? record.path : "";
  if (name === "read_file") return path ? `查看资料：${shortPath(path)}` : "查看资料";
  if (name === "read_document") return path ? `读取文档：${shortPath(path)}` : "读取文档";
  if (name === "list_files") return "了解工作区结构";
  if (name === "search_text") {
    const query = typeof record.query === "string" ? record.query : "";
    return query ? `查找：${query.slice(0, 40)}` : "查找相关资料";
  }
  if (name === "write_file" || name === "edit_file" || name === "apply_patch") return path ? `写入产物：${shortPath(path)}` : "写入产物";
  if (name === "write_spreadsheet") return path ? `生成表格：${shortPath(path)}` : "生成表格";
  if (name === "write_document") return path ? `生成文档：${shortPath(path)}` : "生成文档";
  if (name === "fetch_url") return "读取网页资料";
  if (name === "shell") return "运行检查命令";
  if (name === "capture_screen") return "截取桌面画面";
  if (name === "ask_user") return "需要你补充信息";
  if (name === "finish_task") return "整理最终结果";
  return "执行一步工作";
}

function shortPath(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.slice(-2).join("/");
}

export function refreshNativeResume(resume: AgentResumeState, systemPrompt: string, prompt: string, outDir: string): AgentResumeState {
  let replacedGoal = false;
  const messages: AgentMessage[] = resume.messages.filter((message) => message.role !== "system").map((message) => {
    if (!replacedGoal && message.role === "user") { replacedGoal = true; return { role: "user", content: prompt }; }
    return message;
  });
  if (!replacedGoal) messages.unshift({ role: "user", content: prompt });
  messages.unshift({ role: "system", content: `${systemPrompt}\n本轮唯一产物输出目录：${outDir}。历史记录中的输出目录属于之前的运行，不能写入。旧产物已复制到本轮目录，请在本轮目录继续。` });
  messages.push({ role: "user", content: `恢复执行：当前输出目录是 ${outDir}。只完成剩余工作；用户补充内容只需局部修订已有产物，完成后立即 finish_task。` });
  return { ...resume, messages };
}

// The model writes prose once. Runtime performs the single authorized save and ends.
function draftModelAdapter(settings: ModelSettings, outputPath: string): AgentModel {
  let attempted = false;
  return async (messages, _tools, _onDelta, signal) => {
    if (attempted) throw new Error("草稿保存未成功，已停止自动重试；请检查权限或输出目录后继续。");
    attempted = true;
    const response = await completeChat(settings, [
      { role: "system", content: DRAFT_INSTRUCTION + "只返回草稿正文。" },
      ...messages.filter((message) => message.role === "user").slice(-4).map((message) => ({ role: "user" as const, content: message.content }))
    ], { maxTokens: 1200, temperature: 0.3, signal, timeoutMs: 60_000 });
    if (!response.content.trim()) throw new Error("模型未返回草稿正文");
    const args = { path: outputPath, content: response.content.trim() };
    return { content: "", toolCalls: [{ id: "save-draft", name: "write_file", arguments: args, rawArguments: JSON.stringify(args) }], usage: response.usage, finishReason: "tool_calls" };
  };
}
