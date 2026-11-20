import type { HearthStore } from "@hearth/eventlog";
import type { TaskRecord } from "@hearth/core";

export interface DogfoodTaskRow {
  id: string;
  title: string;
  status: string;
  attempts: number;
  firstPass: boolean;
  updatedAt: string;
}

export interface DogfoodReport {
  generatedAt: string;
  windowDays: number;
  projectId: string | null;
  totals: {
    tasks: number;
    completed: number;
    failed: number;
    active: number;
    successRate: number | null;
    firstPassRate: number | null;
    attempts: number;
    turns: number;
    toolCalls: number;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    approvals: number;
    approved: number;
    rejected: number;
  };
  friction: {
    topErrors: Array<{ message: string; count: number }>;
    retriedTasks: DogfoodTaskRow[];
  };
  rows: DogfoodTaskRow[];
}

export function computeDogfood(
  store: HearthStore,
  options: { days?: number; projectId?: string | null; now?: Date } = {}
): DogfoodReport {
  const now = options.now ?? new Date();
  const days = Math.max(1, Math.min(90, options.days ?? 7));
  const since = now.getTime() - days * 24 * 60 * 60_000;
  const projectId = options.projectId ?? null;
  const tasks = store.listTasks().filter((task) => {
    if (projectId && task.projectId !== projectId) return false;
    return new Date(task.createdAt).getTime() >= since;
  });

  let completed = 0;
  let failed = 0;
  let active = 0;
  let attempts = 0;
  let firstPass = 0;
  let turns = 0;
  let toolCalls = 0;
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;
  let approvals = 0;
  let approved = 0;
  let rejected = 0;
  const errors = new Map<string, number>();
  const rows: DogfoodTaskRow[] = [];
  const retriedTasks: DogfoodTaskRow[] = [];

  for (const task of tasks) {
    const runs = store.listRuns(task.id);
    const taskAttempts = runs.length;
    attempts += taskAttempts;
    for (const run of runs) {
      turns += run.usage?.turns ?? 0;
      toolCalls += run.usage?.toolCalls ?? 0;
      inputTokens += run.usage?.inputTokens ?? 0;
      cachedInputTokens += run.usage?.cachedInputTokens ?? 0;
      outputTokens += run.usage?.outputTokens ?? 0;
    }
    for (const approval of store.listApprovals(task.id)) {
      approvals += 1;
      if (approval.status === "approved") approved += 1;
      if (approval.status === "rejected") rejected += 1;
    }
    if (task.status === "completed") {
      completed += 1;
      const first = runs.find((run) => run.attempt === 1);
      const isFirstPass = Boolean(first && first.status === "completed");
      if (isFirstPass) firstPass += 1;
      const row = toRow(task, taskAttempts, isFirstPass);
      rows.push(row);
      if (taskAttempts > 1) retriedTasks.push(row);
    } else if (task.status === "failed" || task.status === "recoverable") {
      failed += 1;
      const message = task.error?.message ?? "任务失败，但没有记录原因";
      errors.set(message, (errors.get(message) ?? 0) + 1);
      const row = toRow(task, taskAttempts, false);
      rows.push(row);
      if (taskAttempts > 1) retriedTasks.push(row);
    } else {
      active += 1;
      rows.push(toRow(task, taskAttempts, false));
    }
  }

  const concluded = completed + failed;
  return {
    generatedAt: now.toISOString(),
    windowDays: days,
    projectId,
    totals: {
      tasks: tasks.length,
      completed,
      failed,
      active,
      successRate: concluded > 0 ? round(completed / concluded) : null,
      firstPassRate: completed > 0 ? round(firstPass / completed) : null,
      attempts,
      turns,
      toolCalls,
      inputTokens,
      cachedInputTokens,
      outputTokens,
      approvals,
      approved,
      rejected
    },
    friction: {
      topErrors: [...errors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([message, count]) => ({ message, count })),
      retriedTasks: retriedTasks.slice(0, 10)
    },
    rows: rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  };
}

export function renderDogfoodMarkdown(report: DogfoodReport): string {
  const { totals } = report;
  const lines: string[] = [
    `# Hearth dogfood report`,
    "",
    `- Window: last ${report.windowDays} days`,
    `- Generated: ${report.generatedAt}`,
    `- Scope: ${report.projectId ? `project ${report.projectId}` : "all projects"}`,
    "",
    "## Headline",
    "",
    `- Tasks created: ${totals.tasks} (${totals.active} still active)`,
    `- Completed: ${totals.completed}; failed or recoverable: ${totals.failed}`,
    `- Success rate: ${percent(totals.successRate)}; first-attempt success: ${percent(totals.firstPassRate)}`,
    `- Attempts: ${totals.attempts}; turns: ${totals.turns}; tool calls: ${totals.toolCalls}`,
    `- Tokens: ${totals.inputTokens} input (${totals.cachedInputTokens} cached), ${totals.outputTokens} output`,
    `- Human approvals: ${totals.approvals} (${totals.approved} approved, ${totals.rejected} rejected)`,
    "",
    "## Friction",
    ""
  ];
  if (report.friction.topErrors.length === 0) lines.push("- No recorded task failures in this window.");
  for (const error of report.friction.topErrors) lines.push(`- ${error.count}× ${error.message}`);
  const retried = report.friction.retriedTasks;
  lines.push("", "## Tasks that needed more than one attempt", "");
  if (retried.length === 0) lines.push("- None.");
  for (const task of retried) lines.push(`- ${task.title} — ${task.attempts} attempts, ended ${task.status}`);
  lines.push("", "## Task table", "", "| Task | Status | Attempts | First pass | Updated |", "| --- | --- | --- | --- | --- |");
  for (const row of report.rows.slice(0, 40)) {
    lines.push(`| ${escapeCell(row.title)} | ${row.status} | ${row.attempts} | ${row.firstPass ? "yes" : "no"} | ${row.updatedAt} |`);
  }
  if (report.rows.length === 0) lines.push("| — | — | — | — | — |");
  lines.push("", "Metrics are read from the local event log; they describe this machine's dogfood usage, not a public benchmark.", "");
  return lines.join("\n");
}

function toRow(task: TaskRecord, attempts: number, firstPass: boolean): DogfoodTaskRow {
  return { id: task.id, title: task.title, status: task.status, attempts, firstPass, updatedAt: task.updatedAt };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function percent(value: number | null): string {
  return value === null ? "n/a" : `${Math.round(value * 100)}%`;
}

function escapeCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}
