import type { RunBudget } from "@hearth/core";
import type { HarnessMode } from "../types.ts";

export type SubagentType = "explore" | "plan" | "review" | "general-purpose";

export interface AgentProfile {
  type: SubagentType;
  description: string;
  tools: string[];
  mode: HarnessMode;
  isolation: "readonly" | "worktree";
  budget: RunBudget;
  outputContract: string;
}

const READ_TOOLS = [
  "read_file",
  "read_document",
  "list_files",
  "search_text",
  "glob",
  "grep",
  "todo_read",
  "shell",
  "shell_output",
  "shell_wait",
  "memory_read",
  "memory_search",
  "finish_task"
];

const EXPLORE_TOOLS = [...READ_TOOLS];
const PLAN_TOOLS = [...READ_TOOLS, "todo_write"];
const REVIEW_TOOLS = [...READ_TOOLS];

export const AGENT_PROFILES: Record<SubagentType, AgentProfile> = {
  explore: {
    type: "explore",
    description: "Locate files, symbols and call chains quickly. Read-only; return evidence with file:line.",
    tools: EXPLORE_TOOLS,
    mode: "plan",
    isolation: "readonly",
    budget: {},
    outputContract: "Return a compact file list, key line numbers, conclusions and open questions. Do not edit."
  },
  plan: {
    type: "plan",
    description: "Analyze architecture and produce an implementation plan with risks. Read-only.",
    tools: PLAN_TOOLS,
    mode: "plan",
    isolation: "readonly",
    budget: {},
    outputContract: "Return ordered steps, 3-5 key files and concrete risks. Do not edit."
  },
  review: {
    type: "review",
    description: "Review the current diff for bugs, security and test gaps. Read-only.",
    tools: REVIEW_TOOLS,
    mode: "plan",
    isolation: "readonly",
    budget: {},
    outputContract: "Return findings sorted by severity, each with file:line and a suggested fix. Do not edit."
  },
  "general-purpose": {
    type: "general-purpose",
    description: "Implement an isolated task in a worktree, run tests and commit.",
    tools: [],
    mode: "build",
    isolation: "worktree",
    budget: {},
    outputContract: "Return a summary, changed files, test results and the commit SHA. Do not merge or push."
  }
};

export function agentProfile(type: string): AgentProfile | null {
  return type in AGENT_PROFILES ? AGENT_PROFILES[type as SubagentType] : null;
}

export function subagentTypes(): SubagentType[] {
  return Object.keys(AGENT_PROFILES) as SubagentType[];
}
