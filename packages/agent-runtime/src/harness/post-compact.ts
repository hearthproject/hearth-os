import { relative } from "node:path";
import type { AgentToolState, HarnessMode } from "../types.ts";

export interface PostCompactOptions {
  mode?: HarnessMode;
  maxChars?: number;
}

const MAX_FILES = 20;
const MAX_TODOS = 20;

/**
 * Build the durable state block injected after compaction. It deliberately
 * records references rather than file bodies: the model can re-read any file
 * whose hash or mtime changed.
 */
export function buildPostCompactContext(state: AgentToolState, options: PostCompactOptions = {}): string {
  const maxChars = options.maxChars ?? 8_192;
  const display = (path: string): string => {
    const rel = relative(state.workspaceRoot, path).replace(/\\/g, "/");
    return rel && !rel.startsWith("..") ? rel : path.replace(/\\/g, "/");
  };

  const files = [...state.readFiles.entries()]
    .sort((left, right) => right[1].mtimeMs - left[1].mtimeMs)
    .slice(0, MAX_FILES)
    .map(([path, file]) => {
      const ranges = file.ranges?.length
        ? `, lines=${file.ranges.map((range) => `${range.start}-${range.end}`).join(",")}`
        : "";
      return `- ${display(path)} (hash=${file.hash.slice(0, 12)}, mtime=${Math.round(file.mtimeMs)}${ranges})`;
    });

  if (files.length === 0 && state.progress.filesRead.length > 0) {
    for (const path of state.progress.filesRead.slice(-MAX_FILES)) files.push(`- ${display(path)} (read earlier; re-read before editing)`);
  }

  const todos = state.todos
    .filter((todo) => todo.status !== "completed")
    .slice(0, MAX_TODOS)
    .map((todo) => `- [${todo.status}] ${todo.content}`);

  const parts = [
    "<post_compact_context>",
    `mode: ${options.mode ?? state.mode ?? "build"}`,
    "files_in_context:",
    ...(files.length > 0 ? files : ["- none recorded"]),
    "open_todos:",
    ...(todos.length > 0 ? todos : ["- none"]),
    ...(state.planPath ? [`active_plan: ${display(state.planPath)}`] : ["active_plan: none"]),
    `active_skills: ${state.activeSkills?.length ? state.activeSkills.join(", ") : "none"}`,
    "subagents:",
    ...(state.subagents?.length
      ? state.subagents.slice(0, 10).map((agent) => `- ${agent.id} ${agent.type} ${agent.status}${agent.transcriptPath ? ` (${display(agent.transcriptPath)})` : ""}`)
      : ["- none"]),
    "note: File contents were compacted. Re-read any file before editing if its hash or mtime changed.",
    "</post_compact_context>"
  ];

  let text = parts.join("\n");
  if (text.length > maxChars) text = `${text.slice(0, Math.max(0, maxChars - 18))}\n[truncated]`;
  return text;
}
