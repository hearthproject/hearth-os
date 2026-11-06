import type { TaskLease } from "@hearth/core";
import type { HearthService } from "./service.ts";

export class LeaseError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 409) {
    super(message);
    this.name = "LeaseError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface TaskLeaseOptions {
  ownerInstanceId?: string;
  ownerDeviceId?: string | null;
  ttlMs?: number;
  clock?: () => Date;
}

export const DEFAULT_TASK_LEASE_TTL_MS = 60_000;
export const DEFAULT_LEASE_HEARTBEAT_MS = 15_000;

export class TaskLeaseService {
  private readonly service: HearthService;
  private readonly ownerInstanceId: string;
  private readonly ownerDeviceId: string | null;
  private readonly ttlMs: number;
  private readonly clock: () => Date;

  constructor(service: HearthService, options: TaskLeaseOptions = {}) {
    this.service = service;
    this.ownerInstanceId = options.ownerInstanceId ?? service.store.instanceId;
    this.ownerDeviceId = options.ownerDeviceId ?? null;
    this.ttlMs = Math.max(1_000, Math.floor(options.ttlMs ?? DEFAULT_TASK_LEASE_TTL_MS));
    this.clock = options.clock ?? (() => new Date());
  }

  get ownerId(): string {
    return this.ownerInstanceId;
  }

  acquire(taskId: string): TaskLease {
    this.service.requireTask(taskId);
    const now = this.clock();
    const current = this.service.store.getTaskLease(taskId);
    if (current && this.isActive(current, now)) {
      if (current.ownerInstanceId !== this.ownerInstanceId) {
        throw new LeaseError("LEASE_HELD", "任务正由另一个实例执行", 409);
      }
      return current;
    }
    const nowIso = now.toISOString();
    const lease: TaskLease = {
      taskId,
      ownerInstanceId: this.ownerInstanceId,
      ownerDeviceId: this.ownerDeviceId,
      epoch: (current?.epoch ?? 0) + 1,
      expiresAt: new Date(now.getTime() + this.ttlMs).toISOString(),
      heartbeatAt: nowIso,
      createdAt: current?.createdAt ?? nowIso,
      updatedAt: nowIso
    };
    this.emit(lease);
    return lease;
  }

  heartbeat(taskId: string, epoch: number): TaskLease {
    const current = this.requireOwned(taskId, epoch);
    const now = this.clock();
    if (!this.isActive(current, now)) {
      throw new LeaseError("LEASE_EXPIRED", "任务租约已过期，不能再提交结果", 409);
    }
    const updated: TaskLease = {
      ...current,
      expiresAt: new Date(now.getTime() + this.ttlMs).toISOString(),
      heartbeatAt: now.toISOString(),
      updatedAt: now.toISOString()
    };
    this.emit(updated);
    return updated;
  }

  release(taskId: string, epoch: number): TaskLease | null {
    const current = this.service.store.getTaskLease(taskId);
    if (!current || current.ownerInstanceId !== this.ownerInstanceId || current.epoch !== epoch) return null;
    const now = this.clock();
    const released: TaskLease = {
      ...current,
      expiresAt: now.toISOString(),
      updatedAt: now.toISOString()
    };
    this.emit(released);
    return released;
  }

  assertHeld(taskId: string, epoch: number): TaskLease {
    const current = this.requireOwned(taskId, epoch);
    if (!this.isActive(current, this.clock())) {
      throw new LeaseError("LEASE_EXPIRED", "任务租约已过期，旧执行结果已拒绝", 409);
    }
    return current;
  }

  assertOwned(taskId: string): TaskLease {
    const current = this.service.store.getTaskLease(taskId);
    if (!current || current.ownerInstanceId !== this.ownerInstanceId || !this.isActive(current, this.clock())) {
      throw new LeaseError("LEASE_FENCED", "任务已不由当前实例执行，操作已拒绝", 409);
    }
    return current;
  }

  assertOwnedIfLeased(taskId: string): TaskLease | null {
    if (!this.service.store.getTaskLease(taskId)) return null;
    return this.assertOwned(taskId);
  }

  isHeldByOther(taskId: string): boolean {
    const current = this.service.store.getTaskLease(taskId);
    return Boolean(current && current.ownerInstanceId !== this.ownerInstanceId && this.isActive(current, this.clock()));
  }

  activeLeases(): TaskLease[] {
    const now = this.clock();
    return this.service.store.listTaskLeases().filter((lease) => this.isActive(lease, now));
  }

  private requireOwned(taskId: string, epoch: number): TaskLease {
    const current = this.service.store.getTaskLease(taskId);
    if (!current || current.ownerInstanceId !== this.ownerInstanceId || current.epoch !== epoch) {
      throw new LeaseError("LEASE_FENCED", "任务租约已由其他执行者接管，旧结果已拒绝", 409);
    }
    return current;
  }

  private isActive(lease: TaskLease, now: Date): boolean {
    return Date.parse(lease.expiresAt) > now.getTime();
  }

  private emit(lease: TaskLease): void {
    const event = this.service.store.appendEvent({ type: "task.lease.updated", taskId: lease.taskId, payload: lease });
    this.service.bus.publish(event);
  }
}
