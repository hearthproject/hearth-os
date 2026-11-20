import type {
  AgentProgress,
  AgentReadFileState,
  AgentSubagentState,
  AgentTodo,
  AgentToolState,
  HarnessMode,
  SerializedAgentToolState
} from "../types.ts";

const EMPTY_PROGRESS: AgentProgress = { filesRead: [], filesModified: [], commands: [], tests: [], diagnostics: [] };

export function serializeAgentState(state: AgentToolState): SerializedAgentToolState {
  return {
    workspaceRoot: state.workspaceRoot,
    readFiles: [...state.readFiles.entries()].map(([path, read]) => ({
      path,
      size: read.size,
      mtimeMs: read.mtimeMs,
      hash: read.hash,
      ...(read.ranges ? { ranges: read.ranges.map((range) => ({ ...range })) } : {})
    })),
    todos: state.todos.map((todo) => ({ ...todo })),
    progress: {
      filesRead: [...state.progress.filesRead],
      filesModified: [...state.progress.filesModified],
      commands: state.progress.commands.map((command) => ({ ...command })),
      tests: state.progress.tests.map((test) => ({ ...test })),
      diagnostics: state.progress.diagnostics.map((diagnostic) => ({ ...diagnostic }))
    },
    startedAt: state.startedAt,
    snapshots: [...state.snapshots.entries()].map(([id, path]) => ({ id, path })),
    snapshotSeq: state.snapshotSeq,
    ...(state.turn !== undefined ? { turn: state.turn } : {}),
    ...(state.planPath ? { planPath: state.planPath } : {}),
    ...(state.mode ? { mode: state.mode } : {}),
    ...(state.activeSkills ? { activeSkills: [...state.activeSkills] } : {}),
    ...(state.subagents ? { subagents: state.subagents.map((subagent) => ({ ...subagent })) } : {}),
    ...(state.activeWork ? { activeWork: state.activeWork.map((work) => ({ ...work })) } : {}),
    ...(state.exposedTools ? { exposedTools: [...state.exposedTools] } : {})
  };
}

export function deserializeAgentState(input: SerializedAgentToolState | undefined | null): AgentToolState | undefined {
  if (!input || typeof input.workspaceRoot !== "string" || !Array.isArray(input.readFiles)) return undefined;
  const readFiles = new Map<string, AgentReadFileState>();
  for (const read of input.readFiles) {
    if (!read || typeof read.path !== "string") continue;
    readFiles.set(read.path, {
      size: Number(read.size) || 0,
      mtimeMs: Number(read.mtimeMs) || 0,
      hash: typeof read.hash === "string" ? read.hash : "",
      ...(Array.isArray(read.ranges) ? { ranges: read.ranges.filter((range) => range && Number.isFinite(range.start) && Number.isFinite(range.end)).map((range) => ({ start: range.start, end: range.end })) } : {})
    });
  }
  const snapshots = new Map<string, string>();
  for (const snapshot of Array.isArray(input.snapshots) ? input.snapshots : []) {
    if (snapshot && typeof snapshot.id === "string" && typeof snapshot.path === "string") snapshots.set(snapshot.id, snapshot.path);
  }
  const progress: AgentProgress = {
    filesRead: Array.isArray(input.progress?.filesRead) ? input.progress.filesRead.filter((path): path is string => typeof path === "string") : [],
    filesModified: Array.isArray(input.progress?.filesModified) ? input.progress.filesModified.filter((path): path is string => typeof path === "string") : [],
    commands: Array.isArray(input.progress?.commands) ? input.progress.commands : [],
    tests: Array.isArray(input.progress?.tests) ? input.progress.tests : [],
    diagnostics: Array.isArray(input.progress?.diagnostics) ? input.progress.diagnostics : []
  };
  const todos: AgentTodo[] = Array.isArray(input.todos)
    ? input.todos.filter((todo) => todo && typeof todo.id === "string" && typeof todo.content === "string")
    : [];
  const subagents: AgentSubagentState[] | undefined = Array.isArray(input.subagents)
    ? input.subagents.filter((subagent) => subagent && typeof subagent.id === "string")
    : undefined;
  const activeWork = Array.isArray(input.activeWork)
    ? input.activeWork.filter((work) => work && typeof work.id === "string" && (work.kind === "shell" || work.kind === "subagent"))
    : undefined;
  return {
    workspaceRoot: input.workspaceRoot,
    readFiles,
    todos,
    progress,
    startedAt: Number(input.startedAt) || Date.now(),
    snapshots,
    snapshotSeq: Number(input.snapshotSeq) || 0,
    ...(Number.isFinite(input.turn) ? { turn: Number(input.turn) } : {}),
    ...(typeof input.planPath === "string" ? { planPath: input.planPath } : {}),
    ...(input.mode === "plan" || input.mode === "build" ? { mode: input.mode as HarnessMode } : {}),
    ...(Array.isArray(input.activeSkills) ? { activeSkills: input.activeSkills.filter((skill): skill is string => typeof skill === "string") } : {}),
    ...(subagents ? { subagents } : {}),
    ...(activeWork ? { activeWork } : {}),
    ...(Array.isArray(input.exposedTools) ? { exposedTools: input.exposedTools.filter((name): name is string => typeof name === "string") } : {})
  };
}

export { EMPTY_PROGRESS };
