import type { TaskEdge, TaskEdgeKind, TaskJoinPolicy, TaskRecord } from "@hearth/core";
import type { HearthService } from "./service.ts";

export interface TaskGraphLimits {
  maxDepth: number;
  maxChildren: number;
  maxParallel: number;
}

export interface AddTaskEdgeInput {
  parentTaskId: string;
  childTaskId: string;
  kind?: TaskEdgeKind;
  joinPolicy?: TaskJoinPolicy;
  requiredCount?: number;
}

export class TaskGraphError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "TaskGraphError";
    this.code = code;
  }
}

const DEFAULT_LIMITS: TaskGraphLimits = { maxDepth: 3, maxChildren: 5, maxParallel: 3 };
const ACTIVE = new Set(["queued", "running", "waiting_input", "waiting_approval", "recoverable"]);

export class TaskGraphService {
  private readonly limits: TaskGraphLimits;

  constructor(
    private readonly service: HearthService,
    limits: Partial<TaskGraphLimits> = {}
  ) {
    this.limits = {
      maxDepth: Math.max(1, Math.min(4, limits.maxDepth ?? DEFAULT_LIMITS.maxDepth)),
      maxChildren: Math.max(1, Math.min(10, limits.maxChildren ?? DEFAULT_LIMITS.maxChildren)),
      maxParallel: Math.max(1, Math.min(5, limits.maxParallel ?? DEFAULT_LIMITS.maxParallel))
    };
  }

  get maxParallel(): number {
    return this.limits.maxParallel;
  }

  depthOf(taskId: string): number {
    let depth = 0;
    let current = taskId;
    const seen = new Set<string>();
    while (true) {
      if (seen.has(current)) throw new TaskGraphError("TASK_GRAPH_CYCLE", "任务图出现环");
      seen.add(current);
      const edge = this.service.store.listTaskEdges({ childTaskId: current })[0];
      if (!edge) return depth;
      depth += 1;
      if (depth > this.limits.maxDepth + 1) throw new TaskGraphError("TASK_GRAPH_TOO_DEEP", "任务图深度异常");
      current = edge.parentTaskId;
    }
  }

  children(taskId: string): TaskRecord[] {
    return this.service.store.listTaskEdges({ parentTaskId: taskId })
      .map((edge) => this.service.store.getTask(edge.childTaskId))
      .filter((task): task is TaskRecord => Boolean(task));
  }

  descendants(taskId: string): TaskRecord[] {
    const result: TaskRecord[] = [];
    const queue = this.children(taskId);
    const seen = new Set<string>();
    while (queue.length > 0) {
      const task = queue.shift()!;
      if (seen.has(task.id)) continue;
      seen.add(task.id);
      result.push(task);
      queue.push(...this.children(task.id));
    }
    return result;
  }

  assertCanAddChild(parentTaskId: string): { depth: number } {
    const parent = this.service.store.getTask(parentTaskId);
    if (!parent) throw new TaskGraphError("TASK_GRAPH_PARENT_NOT_FOUND", "父任务不存在");
    const depth = this.depthOf(parentTaskId) + 1;
    if (depth > this.limits.maxDepth) {
      throw new TaskGraphError("TASK_GRAPH_MAX_DEPTH", `子任务深度不能超过 ${this.limits.maxDepth} 层`);
    }
    const children = this.children(parentTaskId);
    if (children.length >= this.limits.maxChildren) {
      throw new TaskGraphError("TASK_GRAPH_MAX_CHILDREN", `同一父任务最多 ${this.limits.maxChildren} 个子任务`);
    }
    return { depth };
  }

  addEdge(input: AddTaskEdgeInput): TaskEdge {
    if (input.parentTaskId === input.childTaskId) {
      throw new TaskGraphError("TASK_GRAPH_SELF_REFERENCE", "任务不能依赖自身");
    }
    if (this.wouldCreateCycle(input.parentTaskId, input.childTaskId)) {
      throw new TaskGraphError("TASK_GRAPH_CYCLE", "任务图不能包含环");
    }
    const edge: TaskEdge = {
      parentTaskId: input.parentTaskId,
      childTaskId: input.childTaskId,
      kind: input.kind ?? "subtask",
      joinPolicy: input.joinPolicy ?? "all",
      requiredCount: Math.max(1, input.requiredCount ?? 1),
      createdAt: new Date().toISOString()
    };
    const event = this.service.store.appendEvent({ type: "task.edge.upserted", taskId: input.parentTaskId, payload: edge });
    this.service.bus.publish(event);
    return edge;
  }

  joinSatisfied(parentTaskId: string): boolean {
    const edges = this.service.store.listTaskEdges({ parentTaskId });
    if (edges.length === 0) return true;
    for (const edge of edges) {
      const child = this.service.store.getTask(edge.childTaskId);
      const completed = child?.status === "completed";
      if (edge.joinPolicy === "any" && completed) return true;
      if (edge.joinPolicy === "n_of_m") {
        const completedCount = edges.filter((candidate) => this.service.store.getTask(candidate.childTaskId)?.status === "completed").length;
        if (completedCount >= edge.requiredCount) return true;
      }
    }
    return edges.every((edge) => this.service.store.getTask(edge.childTaskId)?.status === "completed");
  }

  cancelDescendants(taskId: string, reason = "父任务已取消"): TaskRecord[] {
    const cancelled: TaskRecord[] = [];
    for (const task of this.descendants(taskId)) {
      if (!ACTIVE.has(task.status)) continue;
      try {
        const updated = this.service.updateTask(task.id, { status: 'cancelled', nextAction: null, error: null });
        cancelled.push(updated);
      } catch {
        // Cancellation propagation is best effort; effects remain fenced by the parent.
      }
    }
    return cancelled;
  }

  private wouldCreateCycle(parentTaskId: string, childTaskId: string): boolean {
    let current: string | null = parentTaskId;
    const seen = new Set<string>();
    while (current) {
      if (current === childTaskId) return true;
      if (seen.has(current)) return true;
      seen.add(current);
      current = this.service.store.listTaskEdges({ childTaskId: current })[0]?.parentTaskId ?? null;
    }
    return false;
  }
}
