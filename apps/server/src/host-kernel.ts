import { acquireHostLease, type HostLease } from "./host-lease.ts";

export type HostPhase = "starting" | "recovering" | "ready" | "draining" | "stopped" | "failed";
export type StartupStep = "lease" | "store" | "operations" | "runs" | "tasks" | "background" | "ready";

export interface HostKernelOptions {
  dataDir: string;
  port: number;
  lease?: HostLease;
}

export interface HostSnapshot {
  phase: HostPhase;
  step: StartupStep;
  pid: number;
  startedAt: string;
  readyAt: string | null;
  error: string | null;
  lease: { kind: HostLease["kind"]; path: string } | null;
}

/**
 * Owns the host lifecycle and the single-instance lease. The HTTP listener may
 * come up before recovery finishes, but task writes stay closed until `ready()`.
 */
export class HostKernel {
  private phase: HostPhase = "starting";
  private step: StartupStep = "lease";
  private readonly startedAt = new Date().toISOString();
  private readyAt: string | null = null;
  private error: string | null = null;
  private lease: HostLease | null;
  private stopped = false;

  constructor(private readonly options: HostKernelOptions) {
    this.lease = options.lease ?? null;
  }

  start(): void {
    if (this.phase !== "starting" || this.lease) return;
    this.lease = acquireHostLease(this.options.dataDir, this.options.port);
    this.phase = "recovering";
    this.step = "store";
  }

  recovering(): void {
    if (this.phase !== "starting" && this.phase !== "recovering") return;
    this.phase = "recovering";
  }

  advance(step: StartupStep): void {
    if (this.phase === "draining" || this.phase === "stopped" || this.phase === "failed") return;
    this.step = step;
  }

  ready(): void {
    if (this.phase === "draining" || this.phase === "stopped" || this.phase === "failed") return;
    this.phase = "ready";
    this.step = "ready";
    this.readyAt = new Date().toISOString();
    this.error = null;
  }

  beginDrain(): void {
    if (this.phase === "stopped" || this.phase === "failed") return;
    this.phase = "draining";
    this.step = "background";
  }

  fail(error: unknown): void {
    this.phase = "failed";
    this.error = error instanceof Error ? error.message : String(error);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.beginDrain();
    this.lease?.release();
    this.lease = null;
    this.phase = "stopped";
  }

  canAcceptWrites(): boolean {
    return this.phase === "ready";
  }

  snapshot(): HostSnapshot {
    return {
      phase: this.phase,
      step: this.step,
      pid: process.pid,
      startedAt: this.startedAt,
      readyAt: this.readyAt,
      error: this.error,
      lease: this.lease ? { kind: this.lease.kind, path: this.lease.path } : null
    };
  }
}
