import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CODING_REMINDERS, CODING_RUN_BUDGET, codingFinishIssue, codingSystemPrompt, createAgentState, createBuiltinTools, defaultTaskPermissions, runAgent } from "../../packages/agent-runtime/src/index.ts";
import type { AgentModel } from "../../packages/agent-runtime/src/types.ts";
import { streamAgentTurn } from "../../apps/server/src/model-agent.ts";
import type { ModelSettings } from "../../apps/server/src/model-settings.ts";
import type { ModelProtocol } from "../../packages/core/src/index.ts";

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

function required(name: string, fallback?: string): string {
  const value = arg(name, process.env[`HEARTH_${name.toUpperCase().replace(/-/g, "_")}`] ?? fallback);
  if (!value) throw new Error(`Missing --${name} (or HEARTH_${name.toUpperCase().replace(/-/g, "_")})`);
  return value;
}

async function main(): Promise<void> {
  const workspaceRoot = resolve(required("workspace", process.cwd()));
  const goal = arg("goal") ?? (arg("goal-file") ? readFileSync(resolve(required("goal-file")), "utf8") : undefined);
  if (!goal) throw new Error("Missing --goal or --goal-file");
  const outDir = resolve(required("out", join(workspaceRoot, ".hearth", "run")));
  mkdirSync(outDir, { recursive: true });

  const settings: ModelSettings = {
    providerId: "bench",
    providerName: "Benchmark",
    protocol: (arg("protocol", "openai-chat") as ModelProtocol),
    baseUrl: required("base-url", process.env.OPENAI_BASE_URL),
    model: required("model"),
    contextWindowTokens: Number(arg("context-window", "128000")),
    maxOutputTokens: Number(arg("max-output", "8000")),
    apiKey: required("api-key", process.env.HEARTH_MODEL_API_KEY ?? process.env.OPENAI_API_KEY),
    updatedAt: null
  };

  const permissions = defaultTaskPermissions({
    workspaceRoot,
    outDir,
    networkHosts: [],
    extraTools: ["shell", "shell_output", "shell_kill", "todo_write", "todo_read", "run_tests", "diagnostics", "submit_plan", "rewind"],
    writeRoots: [workspaceRoot, outDir]
  });
  const state = createAgentState(workspaceRoot);
  const model: AgentModel = (messages, tools, onDelta, signal) => streamAgentTurn(settings, messages, tools, onDelta, { signal });
  const systemPrompt = codingSystemPrompt({
    workspaceRoot,
    outDir,
    permissions,
    mode: "build",
    extraInstructions: [`Goal file/workspace: ${workspaceRoot}`, `Expected outputs: ${outDir}`]
  });

  const result = await runAgent({
    model,
    tools: createBuiltinTools(),
    goal,
    systemPrompt,
    budget: CODING_RUN_BUDGET,
    permissions,
    workspaceRoot,
    outDir,
    state,
    profile: "coding",
    mode: "build",
    toolTimeoutMs: 10 * 60_000,
    maxParallelTools: 4,
    keepRecentToolOutputs: 3,
    reminders: CODING_REMINDERS,
    contextWindowTokens: settings.contextWindowTokens,
    requireFinishTool: true,
    isFullPermission: () => false,
    validateFinish: (result, context) => codingFinishIssue(context, result),
    onEvent: (event) => {
      if (event.type === "tool.started") console.error(`[tool] ${event.call.name}`);
      if (event.type === "tool.finished") console.error(`[tool] ${event.call.name} ${event.result.isError ? "error" : "ok"} ${event.durationMs}ms`);
      if (event.type === "notice") console.error(`[notice] ${event.message}`);
    }
  });

  console.log(JSON.stringify({
    status: result.status,
    summary: result.summary,
    turns: result.turns,
    toolCalls: result.toolCalls,
    usage: result.usage,
    outputs: result.outputs,
    messages: result.messages
  }, null, 2));
  if (result.status !== "completed") process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
});
