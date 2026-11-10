import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HearthStore } from "@hearth/eventlog";
import { ContextBroker } from "./context-broker.ts";
import { ContextService } from "./context.ts";
import { OntologyService } from "./ontology.ts";
import { HearthService } from "./service.ts";

describe("ContextBroker delegation scope", () => {
  let root: string | null = null;
  let store: HearthStore | null = null;

  afterEach(() => {
    store?.close();
    store = null;
    if (root) rmSync(root, { recursive: true, force: true });
    root = null;
  });

  function setup() {
    root = mkdtempSync(join(tmpdir(), "hearth-broker-"));
    store = new HearthStore(":memory:");
    const service = new HearthService(store);
    const context = new ContextService(service, join(root, "blobs"));
    const ontology = new OntologyService(service);
    return { service, ontology, broker: new ContextBroker(service, context, ontology) };
  }

  it("keeps a delegated child pack inside the parent pack", () => {
    const { service, ontology, broker } = setup();
    const parentTask = service.createTask({ title: "parent", goal: "准备客户方案" });
    const childTask = service.createTask({ title: "child", goal: "只检索 Alice 的公司" });

    const alice = ontology.ensureEntity({ kind: "person", name: "Alice", confidence: "confirmed" });
    const aliceState = ontology.recordState({
      entityId: alice.id, key: "company", value: "Acme", confidence: "confirmed",
      sourceRef: "src:alice", evidenceRefs: ["src:alice"]
    });
    const bob = ontology.ensureEntity({ kind: "person", name: "Bob", confidence: "observed" });

    const parentPack = broker.compile({
      scopeKind: "task", scopeId: parentTask.id, taskId: parentTask.id,
      query: "Alice 公司", budgetTokens: 2000, includeRecentContext: false
    });
    expect(parentPack.items.some((item) => item.ref === `ent:${alice.id}`)).toBe(true);
    expect(parentPack.items.some((item) => item.ref === `st:${aliceState.state.id}`)).toBe(true);

    const childPack = broker.compile({
      scopeKind: "task", scopeId: childTask.id, taskId: childTask.id,
      query: "Alice Bob 公司", budgetTokens: 2000, includeRecentContext: false,
      parentPackId: parentPack.id
    });

    expect(childPack.parentPackId).toBe(parentPack.id);
    const injected = childPack.items.filter((item) => item.lane !== "omitted");
    const allowed = new Set(parentPack.items.filter((item) => item.lane !== "omitted").map((item) => item.ref));
    for (const item of injected) {
      expect(item.ref === `task:${childTask.id}` || item.sourceKind === "profile" || allowed.has(item.ref)).toBe(true);
    }
    expect(injected.some((item) => item.ref === `ent:${bob.id}`)).toBe(false);
    const bobOmitted = childPack.items.find((item) => item.ref === `ent:${bob.id}`);
    expect(bobOmitted?.lane).toBe("omitted");
    expect(bobOmitted?.reason).toContain("父委派上下文包");
  });

  it("records the parent pack on persisted packs", () => {
    const { service, broker } = setup();
    const parentTask = service.createTask({ title: "parent", goal: "parent" });
    const childTask = service.createTask({ title: "child", goal: "child" });
    const parentPack = broker.compile({
      scopeKind: "task", scopeId: parentTask.id, taskId: parentTask.id,
      query: "parent", budgetTokens: 1000
    });
    const childPack = broker.compile({
      scopeKind: "task", scopeId: childTask.id, taskId: childTask.id,
      query: "child", budgetTokens: 1000, parentPackId: parentPack.id
    });
    expect(service.store.getContextPack(childPack.id)?.parentPackId).toBe(parentPack.id);
    expect(service.store.findContextPackByHash(childPack.hash)?.parentPackId).toBe(parentPack.id);
  });
});