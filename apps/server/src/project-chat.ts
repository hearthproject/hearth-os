import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { LocalProject, RunUsage, TaskRecord } from "@hearth/core";
import { supportsToolCalling } from "./model-agent.ts";
import type { ModelSettings } from "./model-settings.ts";
import { runNativeTask } from "./native-executor.ts";
import { prepareWorkspace } from "./workspace.ts";

export interface ProjectChatResult {
  content: string;
  usage: RunUsage;
  turns: number;
  toolCalls: number;
}

export function projectChatSupportsTools(settings: ModelSettings): boolean {
  return supportsToolCalling(settings.protocol ?? "openai-chat");
}

/**
 * Project conversations are not plain text chat: they run through the native
 * agent with the real project as the workspace, the normal tool set and full
 * permission. This keeps the chat surface while giving project sessions the
 * same ability to inspect and change files as a task.
 */
export async function runProjectChat(options: {
  project: LocalProject;
  title: string;
  prompt: string;
  settings: ModelSettings;
  signal: AbortSignal;
  onProgress?: (message: string) => void;
}): Promise<ProjectChatResult> {
  const workspaceDir = mkdtempSync(join(tmpdir(), "hearth-project-chat-"));
  const createdAt = new Date().toISOString();
  const task: TaskRecord = {
    id: `CHAT-${randomUUID()}`,
    templateId: null,
    title: options.title,
    goal: options.prompt,
    status: "running",
    createdAt,
    updatedAt: createdAt,
    deadline: null,
    inputs: [],
    networkHosts: [],
    outputDir: join(workspaceDir, "out"),
    currentRunId: null,
    nextAction: null,
    error: null,
    conversationId: null,
    executorId: "native",
    taskKind: "workspace",
    expectedOutputs: [],
    projectId: options.project.id
  };
  try {
    const prepared = await prepareWorkspace({
      repoRoot: options.project.path,
      workspaceDir,
      executionRoot: options.project.path,
      task
    });
    const result = await runNativeTask({
      task,
      prepared,
      settings: options.settings,
      prompt: options.prompt,
      expectedOutputs: [],
      signal: options.signal,
      budget: { maxTurns: 24, maxToolCalls: 48, maxDurationMs: 600_000 },
      isFullPermission: () => true,
      onAuthorizeTool: async () => ({ allowed: true }),
      onProgress: (event) => {
        if (event.kind === "tool" || event.kind === "narration") options.onProgress?.(event.message);
      }
    });
    return {
      content: result.finalResponse.trim(),
      usage: result.usage,
      turns: result.turns,
      toolCalls: result.toolCalls
    };
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
}
