import { isTextDraftTask, DRAFT_INSTRUCTION } from "./draft-intent.ts";
import { nativeTaskInstructions } from "./native-task-instructions.ts";
import type { BudgetDimension, RunBudget, RunUsage, TaskPermissions, TaskProgressDetail, TaskRecord } from "@hearth/core";
import { EXECUTION_PROFILES, NATIVE_TOKEN_CEILING } from "@hearth/core";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import {
  CODING_RUN_BUDGET,
  CODING_REMINDERS,
  codingFinishIssue,
  codingHarnessEnabled,
  codingSystemPrompt,
  createAgentState,
  createBuiltinTools,
  defaultTaskPermissions,
  discoverInstructions,
  instructionsBlock,
  resolveHarnessProfile,
  runAgent,
  zeroUsage,
  type AgentCheckpoint,
  type ContextSummary,
  type AgentMessage,
  type AgentModel,
  type AgentResumeState,
  type AgentRunResult,
  type AgentTool,
  type AgentToolAuthorization,
  type AgentToolAuthorizationRequest,
  type RuntimeEvent
} from "@hearth/agent-runtime";
import { wantsCodeExecution, wantsGithubAccess, wantsScreenshot } from "./task-intent.ts";
import { supportsToolCalling, streamAgentTurn } from "./model-agent.ts";
import { completeChat } from "./model-client.ts";
import type { ModelSettings } from "./model-settings.ts";
import type { PreparedWorkspace } from "./workspace.ts";

export const DEFAULT_RUN_BUDGET: RunBudget = {
  maxTurns: 200,
  maxToolCalls: 4_000,
  maxTokens: NATIVE_TOKEN_CEILING,
  maxDurationMs: 36_000_000
};

export interface NativeRunOptions {
  task: TaskRecord;
  prepared: PreparedWorkspace;
  settings: ModelSettings;
  prompt: string;
  permissions?: TaskPermissions;
  budget?: RunBudget;
  signal: AbortSignal;
  resume?: AgentResumeState;
  expectedOutputs: string[];
  onProgress?: (event: { kind: string; message: string; detail?: TaskProgressDetail }) => void;
  onContextEvent?: (event: RuntimeEvent) => void;
  onCheckpoint?: (checkpoint: AgentCheckpoint) => void | Promise<void>;
  onAuthorizeTool?: (request: AgentToolAuthorizationRequest) => Promise<AgentToolAuthorization>;
  isFullPermission?: () => boolean;
  extraTools?: AgentTool[];
  skillIndex?: string;
  onContextSummary?: (messages: AgentMessage[], signal: AbortSignal) => Promise<ContextSummary>;
}

export interface NativeRunResult {
  status: AgentRunResult["status"];
  finalResponse: string;
  usage: RunUsage;
  turns: number;
  toolCalls: number;
  question: string | null;
  outputs: string[];
  messages?: AgentMessage[];
  budgetExhaustion?: { dimension: BudgetDimension; limit: number };
}

//runNativeTask() 把模型、工具、提示词、预算、权限和回调装配起来
export async function runNativeTask(options: NativeRunOptions): Promise<NativeRunResult> {
  if (!supportsToolCalling(options.settings.protocol)) {
    throw new Error(`当前模型协议不支持工具调用：${options.settings.protocol}`);
  }
  const screenshotTask = wantsScreenshot(`${options.task.title}\n${options.task.goal}`);
  const githubTask = wantsGithubAccess(`${options.task.title}\n${options.task.goal}`);
  const codeTask = wantsCodeExecution(`${options.task.title}\n${options.task.goal}`);
  const profile = codingHarnessEnabled()
    ? resolveHarnessProfile({
        taskKind: options.task.taskKind,
        hasRepository: existsSync(join(options.prepared.root, ".git")),
        codeIntent: codeTask || githubTask
      })
    : "general";
  const coding = profile === "coding";
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
  if (coding) {
    permissions.tools = [
      ...new Set([
        ...permissions.tools,
        "todo_write",
        "todo_read",
        "run_tests",
        "diagnostics",
        "submit_plan",
        "rewind",
        "shell_output",
        "shell_kill"
      ])
    ];
  }

  const drafting = !coding && isTextDraftTask({ ...options.task, expectedOutputs: options.expectedOutputs });
  const systemPrompt = coding
    ? codingSystemPrompt({
        workspaceRoot: options.prepared.root,
        outDir: options.prepared.outDir,
        permissions,
        ...(options.skillIndex ? { skillIndex: options.skillIndex } : {}),
        mode: "build",
        extraInstructions: [
          `Current task: ${options.task.title}`,
          `Expected outputs: ${options.expectedOutputs.join(", ") || "(no explicit file)"}`,
          `Task language: reply in the user's language; keep code, identifiers and commit messages in English.`
        ]
      })
    : nativeSystemPrompt(options.task, options.expectedOutputs, options.skillIndex);
  const resume = options.resume ? refreshNativeResume(options.resume, systemPrompt, options.prompt, options.prepared.outDir) : undefined;
  const draftTools = new Set(["read_file", "write_file", "finish_task", "ask_user"]);
  let budgetExhaustion: NativeRunResult["budgetExhaustion"];
  const state = createAgentState(options.prepared.root);
  //具体实现
  const result = await runAgent({
    model: drafting ? draftModelAdapter(options.settings, resolve(options.prepared.outDir, options.expectedOutputs[0] ?? "result.md")) : modelAdapter(options.settings),
    tools: [...createBuiltinTools(), ...(options.extraTools ?? [])]
      .filter((tool) => !drafting || draftTools.has(tool.definition.name))
      .map((tool) => !drafting || tool.definition.name !== "write_file" ? tool : {
        ...tool,
        execute: async (input, context) => {
          const saved = await tool.execute(input, context);
          if (saved.isError) return saved;
          const content = (input as { content: string }).content;
          return { ...saved, action: "finish" as const, summary: content, outputs: options.expectedOutputs };
        }
      }),
    goal: options.prompt,
    systemPrompt,
    budget: options.budget ?? (coding ? CODING_RUN_BUDGET : DEFAULT_RUN_BUDGET),
    permissions,
    workspaceRoot: options.prepared.root,
    outDir: options.prepared.outDir,
    state,
    profile,
    mode: "build",
    toolTimeoutMs: coding ? 10 * 60_000 : 120_000,
    maxParallelTools: coding ? 4 : 1,
    ...(coding ? { keepRecentToolOutputs: 3 } : {}),
    ...(coding ? { projectInstructions: instructionsBlock(discoverInstructions(options.prepared.root)) } : {}),
    ...(coding ? { reminders: CODING_REMINDERS } : {}),
    signal: options.signal,
    ...(resume ? { resume } : {}),
    contextWindowTokens: options.settings.contextWindowTokens,
    requireFinishTool: true,
    stopOnToolError: drafting,
    validateFinish: (result, context) => {
      const jsonIssue = jsonDeliverableIssue(options.prepared.outDir, options.expectedOutputs);
      if (jsonIssue) return jsonIssue;
      return coding ? codingFinishIssue(context, result) : null;
    },
    summarizeContext: options.onContextSummary ?? ((messages, signal) => summarizeNativeContext(options.settings, messages, signal)),
    onEvent: (event) => {
      options.onContextEvent?.(event);
      if (event.type === "budget.exceeded") {
        budgetExhaustion = { dimension: event.budget, limit: event.limit };
      }
      const progress = nativeProgressForEvent(event);
      if (progress) options.onProgress?.(progress);
    },
    ...(options.onCheckpoint ? { onCheckpoint: options.onCheckpoint } : {}),
    ...(options.onAuthorizeTool ? { authorizeTool: options.onAuthorizeTool } : {}),
    ...(options.isFullPermission ? { isFullPermission: options.isFullPermission } : {})
  });

  normalizeJsonDeliverables(options.prepared.outDir, options.expectedOutputs);

  return {
    status: result.status,
    finalResponse: result.summary,
    usage: result.usage ?? zeroUsage(),
    turns: result.turns,
    toolCalls: result.toolCalls,
    question: result.question,
    outputs: result.outputs,
    messages: result.messages,
    ...(budgetExhaustion ? { budgetExhaustion } : {})
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
  if (event.type === "turn.started") {
    return {
      kind: "turn",
      message: `开始第 ${event.turn} 轮执行`,
      detail: { executorId: "native", eventType: "turn.started", status: "running" }
    };
  }
  if (event.type === "tool.started") {
    return {
      kind: "tool",
      message: describeToolStart(event.call.name, event.call.arguments),
      detail: { executorId: "native", eventType: "tool.started", title: event.call.name, input: event.call.arguments }
    };
  }
  if (event.type === "tool.finished") {
    return {
      kind: "tool",
      message: event.result.isError ? `操作没有完成，正在调整：${event.call.name}` : `完成一步：${event.call.name}`,
      detail: {
        executorId: "native",
        eventType: "tool.finished",
        title: event.call.name,
        output: event.result.content,
        status: event.result.isError ? "failed" : "completed",
        durationMs: event.durationMs
      }
    };
  }
  if (event.type === "compacted") {
    return { kind: "context", message: "整理执行上下文，继续推进", detail: { executorId: "native", eventType: "compacted", status: "completed" } };
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
    const tools = [
      ...task.permissions.tools,
      ...((githubTask || codeTask) && !task.permissions.tools.includes("shell") ? ["shell"] : []),
      ...(screenshotTask && !task.permissions.tools.includes("capture_screen") ? ["capture_screen"] : [])
    ];
    return {
      ...task.permissions,
      readRoots: [prepared.root],
      writeRoots: task.taskKind === "workspace" || githubTask || codeTask ? [prepared.outDir, prepared.root] : [prepared.outDir],
      networkHosts: [...task.networkHosts],
      tools
    };
  }
  return defaultTaskPermissions({
    workspaceRoot: prepared.root,
    outDir: prepared.outDir,
    networkHosts: task.networkHosts,
    ...(task.taskKind === "workspace" || githubTask || codeTask ? { writeRoots: [prepared.outDir, prepared.root] } : {}),
    extraTools: [
      ...(task.taskKind === "workspace" || githubTask || codeTask ? ["shell"] : []),
      ...(screenshotTask ? ["capture_screen"] : [])
    ]
  });
}

function modelAdapter(settings: ModelSettings): AgentModel {
  return async (messages: AgentMessage[], tools, onDelta, signal) => {
    const result = await streamAgentTurn(settings, messages, tools, onDelta, {
      signal,
      temperature: 0.2,
      maxTokens: settings.maxOutputTokens,
      timeoutMs: 180_000
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
      { role: "system", content: "压缩执行上下文。保留目标、已完成工作、关键证据、失败原因、产物路径和剩余事项；不要编造，输出简洁中文摘要。" },
      { role: "user", content: transcript }
    ], { maxTokens: 2_000, temperature: 0.1, timeoutMs: 60_000, signal });
    return { summary: result.content.trim() || null, usage: result.usage };
  } catch {
    return null;
  }
}

export function nativeSystemPrompt(task: TaskRecord, expectedOutputs: string[], skillIndex?: string): string {
  if (isTextDraftTask({ ...task, expectedOutputs })) return [DRAFT_INSTRUCTION, "仅将最终草稿写入本轮输出目录，已有草稿时只应用用户新增信息。写入成功后直接调用 finish_task，不反复润色，不读取无关文件。", `期望产物：${expectedOutputs.join("、")}`].join("\n");
  return [
    "你是 Hearth 的原生 Agent 执行器，在自己的工作区里独立完成用户任务。",
    "你必须通过工具真正完成工作，不能只描述步骤或假装已经完成。",
    "可用的工具遵循最小权限：只能访问任务授权的目录和域名；没有授权就明确说明限制。",
    "先用 list_files、glob、grep、read_file、read_document 了解已有资料，再生成结果。",
    "PDF、Word、Excel、CSV 等文档优先调用 read_document；需要表格或 Word 产物时使用 write_spreadsheet 或 write_document。",
    "边界清晰、可独立完成的子任务可以调用 delegate_task。只读子代理用于调查；隔离写子代理会在独立 Worktree 中工作并返回分支和提交，结果必须由你检查后手动处理，不会自动合并。",
    "用户需要的最终产物必须写入输出目录；不要生成中间 JSON、命令日志或调试文件作为交付物。",
    "小输入任务直接写最终产物，避免把输入全文、长篇推导和多层元数据复制进产物；一般单产物控制在 200 行或 20KB 内，只保留结论、关键证据、风险和待确认项；写入后最多回读一次。",
    "任务完成后必须调用 finish_task，用中文简洁总结完成结果；如果确实缺少关键输入，才调用 ask_user。",
    "不要假设本地已经有仓库，也不要编造 PR 状态、评审意见或 rebase 结果；命令失败时读取错误并说明限制。",
    "回答使用简体中文，不要编造没有依据的事实。",
    ...nativeTaskInstructions(task, expectedOutputs),
    `当前任务：${task.title}`,
    ...(task.executionMode ? [
      `执行模式：${EXECUTION_PROFILES[task.executionMode].label}。${EXECUTION_PROFILES[task.executionMode].instruction}`
    ] : []),
    `期望产物：${expectedOutputs.join("、")}`,
    ...(skillIndex?.trim() ? [skillIndex.trim()] : []),
    ...(expectedOutputs.some((output) => /\.(png|jpe?g|webp)$/i.test(output))
      ? ["这是截图类任务：必须调用 capture_screen 生成真实图片产物，不要用文本或占位文件代替。"]
      : [])
  ].join("\n");
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
