import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "Stop",
  "PreCompact",
  "PostCompact"
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

export interface AgentHookDefinition {
  event: HookEvent;
  /** Optional regular expression matched against toolName. */
  matcher?: string;
  command: string;
  timeoutMs?: number;
}

export interface HookRunResult {
  blocked: boolean;
  reason: string | null;
  contexts: string[];
  failures: string[];
  executed: number;
}

interface HookResponse {
  decision?: "allow" | "deny" | "block";
  reason?: string;
  additionalContext?: string;
}

const BLOCKING_EVENTS = new Set<HookEvent>(["SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "Stop", "PreCompact"]);
const MAX_OUTPUT = 64_000;

export class HookRunner {
  readonly hooks: AgentHookDefinition[];
  private readonly workspaceRoot: string;
  private readonly defaultTimeoutMs: number;

  constructor(hooks: AgentHookDefinition[], options: { workspaceRoot: string; timeoutMs?: number }) {
    this.hooks = hooks;
    this.workspaceRoot = options.workspaceRoot;
    this.defaultTimeoutMs = options.timeoutMs ?? 10_000;
  }

  get size(): number {
    return this.hooks.length;
  }

  async run(event: HookEvent, payload: Record<string, unknown>): Promise<HookRunResult> {
    const result: HookRunResult = { blocked: false, reason: null, contexts: [], failures: [], executed: 0 };
    const toolName = typeof payload.toolName === "string" ? payload.toolName : null;
    for (const hook of this.hooks) {
      if (hook.event !== event) continue;
      if (hook.matcher && toolName && !safeMatches(hook.matcher, toolName)) continue;
      result.executed += 1;
      const response = await executeHook(hook, this.workspaceRoot, { ...payload, event }, hook.timeoutMs ?? this.defaultTimeoutMs);
      if (!response.ok) {
        result.failures.push(`${hook.command}: ${response.error}`);
        if (BLOCKING_EVENTS.has(event)) {
          result.blocked = true;
          result.reason = `Hook ${event} 执行失败，已按失败关闭处理：${response.error}`;
          return result;
        }
        continue;
      }
      if (response.context) result.contexts.push(response.context);
      if (response.decision === "deny" || response.decision === "block") {
        result.blocked = true;
        result.reason = response.reason ?? `Hook 拒绝了 ${event}`;
        return result;
      }
    }
    return result;
  }
}

export interface WorkspaceHooks {
  hooks: AgentHookDefinition[];
  path: string;
  trusted: boolean;
  skipped: number;
}

export function loadWorkspaceHooks(workspaceRoot: string, trusted: boolean, relativePath = join(".hearth", "hooks.json")): WorkspaceHooks {
  const path = join(workspaceRoot, relativePath);
  if (!existsSync(path)) return { hooks: [], path, trusted, skipped: 0 };
  const parsed = parseHooksFile(path);
  if (!trusted) return { hooks: [], path, trusted, skipped: parsed.length };
  return { hooks: parsed, path, trusted, skipped: 0 };
}

function parseHooksFile(path: string): AgentHookDefinition[] {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { hooks?: unknown };
    if (!Array.isArray(raw.hooks)) return [];
    return raw.hooks.flatMap((entry): AgentHookDefinition[] => {
      if (!entry || typeof entry !== "object") return [];
      const candidate = entry as Record<string, unknown>;
      if (typeof candidate.event !== "string" || !HOOK_EVENTS.includes(candidate.event as HookEvent)) return [];
      if (typeof candidate.command !== "string" || !candidate.command.trim()) return [];
      return [{
        event: candidate.event as HookEvent,
        command: candidate.command,
        ...(typeof candidate.matcher === "string" ? { matcher: candidate.matcher } : {}),
        ...(typeof candidate.timeoutMs === "number" && Number.isFinite(candidate.timeoutMs) ? { timeoutMs: candidate.timeoutMs } : {})
      }];
    });
  } catch {
    return [];
  }
}

function safeMatches(pattern: string, value: string): boolean {
  try {
    return new RegExp(pattern).test(value);
  } catch {
    return false;
  }
}

function executeHook(
  hook: AgentHookDefinition,
  cwd: string,
  payload: Record<string, unknown>,
  timeoutMs: number
): Promise<{ ok: true; decision: HookResponse["decision"]; reason?: string; context?: string } | { ok: false; error: string }> {
  return new Promise((resolvePromise) => {
    let stdout = "";
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    let child: ReturnType<typeof spawn> | undefined;
    const finish = (value: { ok: true; decision: HookResponse["decision"]; reason?: string; context?: string } | { ok: false; error: string }): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolvePromise(value);
    };
    try {
      child = spawn(hook.command, {
        cwd,
        shell: true,
        windowsHide: true,
        env: { ...process.env, HEARTH_HOOK_EVENT: hook.event, HEARTH_HOOK_CWD: cwd },
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch (error) {
      finish({ ok: false, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    timer = setTimeout(() => {
      child?.kill("SIGKILL");
      finish({ ok: false, error: `超时（${timeoutMs}ms）` });
    }, Math.max(1, timeoutMs));
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > MAX_OUTPUT) stdout = stdout.slice(-MAX_OUTPUT);
    });
    child.on("error", (error) => finish({ ok: false, error: error.message }));
    child.on("close", (code) => {
      if (code !== 0) {
        finish({ ok: false, error: `退出码 ${code ?? "unknown"}` });
        return;
      }
      const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
      if (!line) {
        finish({ ok: true, decision: "allow" });
        return;
      }
      try {
        const parsed = JSON.parse(line) as HookResponse;
        finish({
          ok: true,
          decision: parsed.decision,
          ...(typeof parsed.reason === "string" ? { reason: parsed.reason } : {}),
          ...(typeof parsed.additionalContext === "string" ? { context: parsed.additionalContext } : {})
        });
      } catch {
        finish({ ok: false, error: "stdout 不是 JSON 协议" });
      }
    });
    child.stdin?.end(`${JSON.stringify(payload)}\n`);
  });
}
