import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentTool, AgentToolContext } from "@hearth/agent-runtime";
import { HearthStore } from "@hearth/eventlog";
import { withExtraToolPermissions } from "./native-executor.ts";
import { OntologyService } from "./ontology.ts";
import { createPersonalReadTools, PERSONAL_READ_TOOL_NAMES } from "./personal-tools.ts";
import { HearthService } from "./service.ts";

describe("personal read tools", () => {
  let root: string | null = null;
  let store: HearthStore | null = null;

  afterEach(() => {
    store?.close();
    store = null;
    if (root) rmSync(root, { recursive: true, force: true });
    root = null;
  });

  function setup() {
    root = mkdtempSync(join(tmpdir(), "hearth-personal-tools-"));
    store = new HearthStore(":memory:");
    const service = new HearthService(store);
    const ontology = new OntologyService(service);
    const tools = new Map(createPersonalReadTools({ service, ontology }).map((tool) => [tool.definition.name, tool]));
    return { service, ontology, tools };
  }

  async function run(tool: AgentTool, args: Record<string, unknown>) {
    const result = await tool.execute(args, {
      workspaceRoot: root ?? tmpdir(),
      outDir: root ?? tmpdir(),
      permissions: { readRoots: [], writeRoots: [], networkHosts: [], tools: [...PERSONAL_READ_TOOL_NAMES] },
      signal: new AbortController().signal
    } satisfies AgentToolContext);
    return { result, body: JSON.parse(result.content) as Record<string, any> };
  }

  it("exposes stable references for entities, states, relations, decisions and commitments", async () => {
    const { service, ontology, tools } = setup();
    const alice = ontology.ensureEntity({ kind: "person", name: "Alice Chen", aliases: ["小艾"], confidence: "confirmed" });
    const project = ontology.ensureEntity({ kind: "project", name: "Apollo", confidence: "confirmed" });
    const state = ontology.recordState({
      entityId: alice.id,
      key: "company",
      value: "Acme",
      confidence: "confirmed",
      sourceRef: "src:profile",
      evidenceRefs: ["src:profile"]
    }).state;
    const relation = ontology.recordRelation({
      fromEntityId: alice.id,
      predicate: "works_on",
      toEntityId: project.id,
      confidence: "confirmed",
      evidenceRefs: ["src:profile"]
    });
    const decision = ontology.recordDecision({
      title: "Apollo 发布策略",
      decision: "先灰度发布",
      decidedBy: "user",
      subjectEntityId: project.id,
      evidenceRefs: ["chat:decision"]
    });
    const commitment = ontology.recordCommitment({
      description: "周五前给 Alice 发送发布计划",
      dueAt: "2026-11-13T10:00:00.000Z",
      confidence: "confirmed",
      evidenceRefs: ["chat:promise"],
      entityId: alice.id
    });
    const task = service.createTask({ title: "发布准备", goal: "准备发布" });

    const entity = await run(tools.get("get_entity")!, { entity: "Alice Chen" });
    expect(entity.result.isError).toBeUndefined();
    expect(entity.body.entity).toMatchObject({ id: alice.id, canonicalName: "Alice Chen", kind: "person" });
    expect(entity.body.aliases.some((alias: { alias: string }) => alias.alias === "小艾")).toBe(true);

    const states = await run(tools.get("get_entity_state")!, { id: alice.id, key: "company" });
    expect(states.body.states[0]).toMatchObject({ id: state.id, key: "company", value: "Acme", confidence: "confirmed" });

    const relations = await run(tools.get("get_relations")!, { entity: "Alice Chen" });
    expect(relations.body.relations[0]).toMatchObject({
      id: relation.id,
      predicate: "works_on",
      direction: "outgoing",
      otherEntity: { id: project.id, canonicalName: "Apollo" }
    });

    const decisions = await run(tools.get("get_decision")!, { entity: "Apollo", title: "发布" });
    expect(decisions.body.decisions[0]).toMatchObject({ id: decision.id, decision: "先灰度发布" });

    const commitments = await run(tools.get("list_commitments")!, { entity: "Alice Chen" });
    expect(commitments.body.commitments[0]).toMatchObject({
      id: commitment.id,
      status: "open",
      entity: { id: alice.id },
      taskId: null
    });
    expect(commitments.body.commitments[0].taskId).toBeNull();
    expect(task.id).toBeTruthy();
  });

  it("redacts secret state values and asks for disambiguation instead of guessing", async () => {
    const { ontology, tools } = setup();
    ontology.ensureEntity({ kind: "person", name: "Alice Chen", aliases: ["小艾"], confidence: "confirmed" });
    ontology.ensureEntity({ kind: "person", name: "Alice Wang", aliases: ["小艾"], confidence: "confirmed" });
    const secret = ontology.ensureEntity({ kind: "account", name: "主邮箱", sensitivity: "secret", confidence: "confirmed" });
    ontology.recordState({
      entityId: secret.id,
      key: "password_hint",
      value: "correct horse battery staple",
      confidence: "confirmed",
      sourceRef: "src:secret",
      evidenceRefs: ["src:secret"]
    });

    const ambiguous = await run(tools.get("get_entity")!, { entity: "小艾" });
    expect(ambiguous.result.isError).toBe(true);
    expect(ambiguous.body.error).toBe("ENTITY_AMBIGUOUS");
    expect(ambiguous.body.candidates).toHaveLength(2);

    const states = await run(tools.get("get_entity_state")!, { id: secret.id });
    expect(states.body.states[0]).toMatchObject({ key: "password_hint", value: null, redacted: "secret" });
  });

  it("adds only registered extra tool names to an existing permission set", () => {
    const extra: AgentTool[] = [{
      definition: { name: "get_entity", description: "read", parameters: { type: "object" } },
      execute: async () => ({ content: "ok" })
    }];
    const merged = withExtraToolPermissions({
      readRoots: ["/workspace"],
      writeRoots: ["/out"],
      networkHosts: [],
      tools: ["read_file"]
    }, extra);
    expect(merged.tools).toEqual(["read_file", "get_entity"]);
    expect(merged.writeRoots).toEqual(["/out"]);
  });
});