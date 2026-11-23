import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SandboxUnavailableError,
  sandboxTempBase,
  type ConfinedCommand,
  type SandboxProvider,
  type SandboxRequest
} from "@hearth/agent-runtime";

const RUNNER_FAILURE_RULE = {
  allowedExitCodes: [127],
  fatalSignatures: ["sandbox-error: "]
} as const;

export interface WindowsNativeSandboxOptions {
  helperPath?: string;
  probe?: boolean;
}

/**
 * Windows AppContainer sandbox. The helper creates a package SID, grants it
 * access only to the workspace/temp/read roots, starts the child inside an
 * AppContainer with no capabilities, and owns a kill-on-close job object.
 * The Node side only builds the argv contract; all Win32 work stays native.
 */
export class WindowsNativeSandboxProvider implements SandboxProvider {
  readonly id = "windows-native";
  private readonly explicitHelperPath: string | undefined;
  private helperPath: string | null = null;
  private probePromise: Promise<void> | null = null;
  private readonly shouldProbe: boolean;

  constructor(options: WindowsNativeSandboxOptions = {}) {
    this.explicitHelperPath = options.helperPath;
    this.shouldProbe = options.probe ?? true;
  }

  async confine(request: SandboxRequest): Promise<ConfinedCommand> {
    if (process.platform !== "win32") {
      throw new SandboxUnavailableError("Windows native sandbox 只在 Windows 上可用");
    }
    if (this.shouldProbe) await this.probe();
    const helper = this.resolveHelper();
    const policy = request.policy;
    if (policy.networkHosts.length > 0 && policy.networkMode !== "open") {
      throw new SandboxUnavailableError(
        "Windows native sandbox 不支持域级网络白名单；请将任务的 networkMode 设为 open（允许任意出网）或移除 networkHosts"
      );
    }
    const networkArg = policy.networkMode === "open" ? "allow" : "deny";
    const readRoots = new Set<string>(policy.readRoots);
    const writeRoots = policy.writableRoots.filter((root) => root !== policy.workspaceRoot);
    const executableRoot = request.argv[0] ? dirname(request.argv[0]) : null;
    if (executableRoot && !isSystemRoot(executableRoot)) readRoots.add(executableRoot);
    const nodeRoot = dirname(process.execPath);
    if (!isSystemRoot(nodeRoot)) readRoots.add(nodeRoot);
    const args = [
      helper,
      request.pty ? "pty" : "sandbox",
      "--workspace",
      policy.workspaceRoot,
      "--temp",
      policy.tempRoot,
      "--mode",
      policy.mode,
      "--network",
      networkArg,
      "--parent-pid",
      String(process.pid)
    ];
    if (request.pty) {
      args.push("--cols", String(request.pty.cols), "--rows", String(request.pty.rows));
    }
    for (const root of writeRoots) args.push("--write", root);
    for (const root of readRoots) args.push("--read", root);
    args.push("--", ...request.argv);
    return {
      argv: args,
      cwd: request.cwd,
      env: policy.env,
      backend: "windows-acl",
      enforcement: "full",
      networkEnforcement: networkArg === "allow" ? "none" : "full",
      denialSignatures: [
        "Access is denied",
        "拒绝访问",
        "The filename, directory name, or volume label syntax is incorrect",
        "Permission denied",
        "EPERM",
        "EACCES"
      ],
      runnerFailureRules: [RUNNER_FAILURE_RULE]
    };
  }

  async probe(): Promise<void> {
    if (process.platform !== "win32") throw new SandboxUnavailableError("Windows native sandbox 只在 Windows 上可用");
    if (!this.probePromise) {
      this.probePromise = this.runProbe().catch((error: unknown) => {
        this.probePromise = null;
        throw error;
      });
    }
    return this.probePromise;
  }

  private async runProbe(): Promise<void> {
    const helper = this.resolveHelper();
    const root = mkdtempSync(join(sandboxTempBase(), "hearth-native-probe-"));
    const workspace = join(root, "ws");
    const temp = join(root, "tmp");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(temp, { recursive: true });
    try {
      await new Promise<void>((resolvePromise, reject) => {
        const child = spawn(
          helper,
          [
            "sandbox",
            "--workspace",
            workspace,
            "--temp",
            temp,
            "--mode",
            "workspace-write",
            "--network",
            "deny",
            "--parent-pid",
            String(process.pid),
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
          reject(new SandboxUnavailableError("Windows native runner probe 超时"));
        }, 10_000);
        child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(new SandboxUnavailableError(`Windows native runner 启动失败：${error.message}`));
        });
        child.once("close", (code) => {
          clearTimeout(timer);
          if (code === 127 || stderr.includes("sandbox-error: ")) {
            reject(new SandboxUnavailableError(`Windows native runner 不可用：${stderr.trim().slice(-500) || `exit ${code}`}`));
            return;
          }
          if (code !== 0) {
            reject(new SandboxUnavailableError(`Windows native runner probe 失败（exit ${code}）：${stderr.trim().slice(-500)}`));
            return;
          }
          resolvePromise();
        });
      });
    } finally {
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      } catch {
        // AppContainer SID ACEs may survive cleanup; the OS temp cleaner owns it.
      }
    }
  }

  private resolveHelper(): string {
    if (this.helperPath) return this.helperPath;
    this.helperPath = resolveNativeHelperPath(this.explicitHelperPath);
    return this.helperPath;
  }
}

export function resolveNativeHelperPath(explicitHelperPath?: string): string {
    const candidates = [
      explicitHelperPath,
      process.env.HEARTH_NATIVE_HELPER,
      join(dirname(process.execPath), "hearth-native.exe"),
      join(dirname(process.execPath), "native", "hearth-native.exe"),
      join(dirname(process.execPath), "..", "native", "hearth-native.exe"),
      fileURLToPath(new URL("../../../apps/native/bin/hearth-native.exe", import.meta.url)),
      join(process.cwd(), "apps", "native", "bin", "hearth-native.exe")
    ].filter((candidate): candidate is string => Boolean(candidate));
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
    throw new SandboxUnavailableError(
      "找不到 hearth-native.exe。请运行 npm run build:native，或设置 HEARTH_NATIVE_HELPER 指向 helper"
    );
}

export function windowsNativeProviderAvailable(): boolean {
  return process.platform === "win32";
}

function isSystemRoot(path: string): boolean {
  const lower = path.toLowerCase();
  const windows = (process.env.SystemRoot ?? "C:\\Windows").toLowerCase();
  return lower === windows
    || lower.startsWith(`${windows}\\`)
    || lower.startsWith("c:\\program files")
    || lower.startsWith("c:\\program files (x86)");
}
