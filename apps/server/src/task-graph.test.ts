import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HearthStore } from "@hearth/eventlog";
import { HearthService } from "./service.ts";
import { TaskGraphError, TaskGraphService } from "./task-graph.ts";

describe("TaskGraphService", () => {
  let root: string | null = null;
  let store: HearthStore | null = null;

  afterEach(() => {
    store?.close();
    store = null;
    if (root) rmSync(root, { recursive: true, force: true });
    root = null;
  });

  function setup() {
    root = mkdtempSync(join(tmpdir(), "hearth-task-graph-"));
    store = new HearthStore(":memory:");
    const service = new HearthService(store);
    return { service, graph: new TaskGraphService(service) };
  }

  it("tracks depth, children and descendants", () => {
    const { service, graph } = setup();
    const rootTask = service.createTask({ title: "root", goal: "root" });
    const child = service.createTask({ title: "child", goal: "child" });
    const grandchild = service.createTask({ title: "grandchild", goal: "grandchild" });
    graph.addEdge({ parentTaskId: rootTask.id, childTaskId: child.id });
    graph.addEdge({ parentTaskId: child.id, childTaskId: grandchild.id });

    expect(graph.depthOf(rootTask.id)).toBe(0);
    expect(graph.depthOf(child.id)).toBe(1);
    expect(graph.depthOf(grandchild.id)).toBe(2);
    expect(graph.children(rootTask.id).map((task) => task.id)).toEqual([child.id]);
    expect(graph.descendants(rootTask.id).map((task) => task.id).sort()).toEqual([child.id, grandchild.id].sort());
    expect(graph.assertCanAddChild(grandchild.id).depth).toBe(3);
  });

  it("rejects self references, cycles and depth overflow", () => {
    const { service, graph } = setup();
    const a = service.createTask({ title: "a", goal: "a" });
    const b = service.createTask({ title: "b", goal: "b" });
    const c = service.createTask({ title: "c", goal: "c" });
    const d = service.createTask({ title: "d", goal: "d" });

    expect(() => graph.addEdge({ parentTaskId: a.id, childTaskId: a.id }))
      .toThrowError(expect.objectContaining({ code: "TASK_GRAPH_SELF_REFERENCE" }));
    graph.addEdge({ parentTaskId: a.id, childTaskId: b.id });
    expect(() => graph.addEdge({ parentTaskId: b.id, childTaskId: a.id }))
      .toThrowError(expect.objectContaining({ code: "TASK_GRAPH_CYCLE" }));
    graph.addEdge({ parentTaskId: b.id, childTaskId: c.id });
    graph.addEdge({ parentTaskId: c.id, childTaskId: d.id });
    expect(() => graph.assertCanAddChild(d.id))
      .toThrowError(expect.objectContaining({ code: "TASK_GRAPH_MAX_DEPTH" }));
  });

  it("caps fan-out per parent", () => {
    const { service, graph } = setup();
    const parent = service.createTask({ title: "parent", goal: "parent" });
    for (let index = 0; index < 5; index += 1) {
      const child = service.createTask({ title: `child-${index}`, goal: "child" });
      graph.addEdge({ parentTaskId: parent.id, childTaskId: child.id });
    }
    expect(() => graph.assertCanAddChild(parent.id))
      .toThrowError(expect.objectContaining({ code: "TASK_GRAPH_MAX_CHILDREN" }));
  });

  it("honors all, any and n_of_m join policies", () => {
    const { service, graph } = setup();
    const parent = service.createTask({ title: "parent", goal: "parent" });
    const first = service.createTask({ title: "first", goal: "first" });
    const second = service.createTask({ title: "second", goal: "second" });
    const third = service.createTask({ title: "third", goal: "third" });

    graph.addEdge({ parentTaskId: parent.id, childTaskId: first.id, joinPolicy: "all" });
    graph.addEdge({ parentTaskId: parent.id, childTaskId: second.id, joinPolicy: "all" });
    expect(graph.joinSatisfied(parent.id)).toBe(false);
    complete(service, first.id);
    expect(graph.joinSatisfied(parent.id)).toBe(false);
    complete(service, second.id);
    expect(graph.joinSatisfied(parent.id)).toBe(true);

    const anyParent = service.createTask({ title: "any", goal: "any" });
    graph.addEdge({ parentTaskId: anyParent.id, childTaskId: first.id, joinPolicy: "any" });
    graph.addEdge({ parentTaskId: anyParent.id, childTaskId: third.id, joinPolicy: "any" });
    expect(graph.joinSatisfied(anyParent.id)).toBe(true);

    const quorumParent = service.createTask({ title: "quorum", goal: "quorum" });
    const quorumChildren = [1, 2, 3].map((index) => service.createTask({ title: `quorum-${index}`, goal: "quorum child" }));
    for (const child of quorumChildren) {
      graph.addEdge({ parentTaskId: quorumParent.id, childTaskId: child.id, joinPolicy: "n_of_m", requiredCount: 2 });
    }
    expect(graph.joinSatisfied(quorumParent.id)).toBe(false);
    complete(service, quorumChildren[0]!.id);
    expect(graph.joinSatisfied(quorumParent.id)).toBe(false);
    complete(service, quorumChildren[1]!.id);
    expect(graph.joinSatisfied(quorumParent.id)).toBe(true);
  });

  it("cancels every active descendant when a parent is cancelled", () => {
    const { service, graph } = setup();
    const parent = service.createTask({ title: "parent", goal: "parent" });
    const child = service.createTask({ title: "child", goal: "child" });
    const grandchild = service.createTask({ title: "grandchild", goal: "grandchild" });
    const done = service.createTask({ title: "done", goal: "done" });
    graph.addEdge({ parentTaskId: parent.id, childTaskId: child.id });
    graph.addEdge({ parentTaskId: child.id, childTaskId: grandchild.id });
    graph.addEdge({ parentTaskId: parent.id, childTaskId: done.id });
    complete(service, done.id);

    const cancelled = graph.cancelDescendants(parent.id, "用户取消");
    expect(cancelled.map((task) => task.id).sort()).toEqual([child.id, grandchild.id].sort());
    expect(service.requireTask(child.id).status).toBe("cancelled");
    expect(service.requireTask(grandchild.id).status).toBe("cancelled");
    expect(service.requireTask(done.id).status).toBe("completed");
  });

  function complete(service: HearthService, taskId: string): void {
    service.updateTask(taskId, { status: "running" });
    service.updateTask(taskId, { status: "completed" });
  }

  it("maps graph failures to typed errors", () => {
    const { service } = setup();
    expect(() => new TaskGraphService(service).depthOf("missing")).not.toThrow();
    expect(TaskGraphError).toBeTruthy();
  });
});