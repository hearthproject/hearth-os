import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  SandboxUnavailableError,
  sandboxTempBase,
  type ConfinedCommand,
  type SandboxProvider,
  type SandboxRequest
} from "@hearth/agent-runtime";

const RUNNER_FAILURE_RULE = {
  allowedExitCodes: [127],
  fatalSignatures: ["windows-acl-run: "]
} as const;

export interface WindowsAclSandboxOptions {
  runnerPath?: string;
  nodePath?: string;
  probe?: boolean;
}

/**
 * Thin adapter over the DeepSeek Harness Windows ACL runner. The runner owns
 * the restricted token, capability SIDs, Low-integrity label and job object;
 * Hearth only builds its documented argv contract and classifies its failure
 * dialect. No Win32 FFI code is duplicated here.
 */
export class WindowsAclSandboxProvider implements SandboxProvider {
  readonly id = "windows-acl";
  private readonly explicitRunnerPath: string | undefined;
  private readonly nodePath: string;
  private runnerPath: string | null = null;
  private probePromise: Promise<void> | null = null;
  private readonly shouldProbe: boolean;

  constructor(options: WindowsAclSandboxOptions = {}) {
    this.explicitRunnerPath = options.runnerPath;
    this.nodePath = options.nodePath ?? process.execPath;
    this.shouldProbe = options.probe ?? true;
  }

  async confine(request: SandboxRequest): Promise<ConfinedCommand> {
    if (process.platform !== "win32") {
      throw new SandboxUnavailableError("Windows ACL 沙箱只在 Windows 上可用");
    }
    if (this.shouldProbe) await this.probe();
    const runner = this.resolveRunner();
    const policy = request.policy;
    return {
      argv: [
        this.nodePath,
        runner,
        "--workspace",
        policy.workspaceRoot,
        "--temp",
        policy.tempRoot,
        "--mode",
        policy.mode,
        "--",
        ...request.argv
      ],
      cwd: request.cwd,
      env: policy.env,
      backend: "windows-acl",
      enforcement: "partial",
      networkEnforcement: "none",
      denialSignatures: ["Access is denied", "Permission denied", "拒绝访问", "EPERM", "EACCES"],
      runnerFailureRules: [RUNNER_FAILURE_RULE]
    };
  }

  async probe(): Promise<void> {
    if (process.platform !== "win32") throw new SandboxUnavailableError("Windows ACL 沙箱只在 Windows 上可用");
    if (!this.probePromise) {
      this.probePromise = this.runProbe().catch((error: unknown) => {
        this.probePromise = null;
        throw error;
      });
    }
    return this.probePromise;
  }

  private async runProbe(): Promise<void> {
    const runner = this.resolveRunner();
    const root = mkdtempSync(join(sandboxTempBase(), "hearth-sandbox-probe-"));
    const workspace = join(root, "ws");
    const temp = join(root, "tmp");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(temp, { recursive: true });
    try {
      await new Promise<void>((resolvePromise, reject) => {
        const child = spawn(
          this.nodePath,
          [
            runner,
            "--workspace",
            workspace,
            "--temp",
            temp,
            "--mode",
            "workspace-write",
            "--",
            process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe",
            "/c",
            "exit",
            "/b",
            "0"
          ],
          { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
        );
        let stderr = "";
        const timer = setTimeout(() => {
          child.kill();
          reject(new SandboxUnavailableError("Windows ACL runner probe 超时"));
        }, 10_000);
        child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(new SandboxUnavailableError(`Windows ACL runner 启动失败：${error.message}`));
        });
        child.once("close", (code) => {
          clearTimeout(timer);
          if (code === 127 || stderr.includes("windows-acl-run: ")) {
            reject(new SandboxUnavailableError(`Windows ACL runner 不可用：${stderr.trim().slice(-500) || `exit ${code}`}`));
            return;
          }
          if (code !== 0) {
            reject(new SandboxUnavailableError(`Windows ACL runner probe 失败（exit ${code}）：${stderr.trim().slice(-500)}`));
            return;
          }
          resolvePromise();
        });
      });
    } finally {
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      } catch {
        // The probe workspace may carry ACL grants; leave it for OS cleanup.
      }
    }
  }

  private resolveRunner(): string {
    if (this.runnerPath) return this.runnerPath;
    const candidates = [
      this.explicitRunnerPath,
      process.env.HEARTH_SANDBOX_RUNNER,
      join(dirname(process.execPath), "sandbox", "windows-acl", "runner.mjs"),
      join(dirname(process.execPath), "sandbox", "windows-acl", "runner.js"),
      join(dirname(process.execPath), "sandbox", "windows-acl", "lib", "runner.mjs"),
      join(dirname(process.execPath), "sandbox", "windows-acl", "lib", "runner.js")
    ].filter((candidate): candidate is string => Boolean(candidate));
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        this.runnerPath = candidate;
        return candidate;
      }
    }
    try {
      const resolved = createRequire(import.meta.url).resolve("@deepseek-ai/dsh-sandbox-windows-acl/runner");
      this.runnerPath = resolved;
      return resolved;
    } catch {
      throw new SandboxUnavailableError(
        "找不到 Windows ACL runner。请安装 @deepseek-ai/dsh-sandbox-windows-acl，或在打包资源中放入 sandbox/windows-acl/runner.mjs"
      );
    }
  }
}

export function windowsAclProviderAvailable(): boolean {
  return process.platform === "win32";
}
