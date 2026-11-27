import { describe, expect, it, vi } from "vitest";
import type { AgentTool, AgentToolContext, AgentToolDefinition } from "../types.ts";
import { createFakeModel, fakeUsage } from "../test-support/fake-model.ts";
import {
  ExchangeRecorder,
  MemoryCassetteSource,
  applyCounterfactualOverride,
  cassetteModel,
  cassetteTools,
  describeModelRequest,
  modelRequestFingerprint,
  toolCallFingerprint,
  toolCatalogDigest,
  type CassetteMetadata,
  type CassetteSink,
  type ExchangeDraft
} from "./cassette.ts";

const environmentDigest = "sha256:env";
const systemPrompt = "你是测试执行器。";

const catalog: AgentToolDefinition[] = [
  {
    name: "read_file",
    description: "读取文件",
    parameters: { type: "object", properties: { path: { type: "string" } } }
  }
];

function metadata(overrides: Partial<CassetteMetadata> = {}): CassetteMetadata {
  return {
    cassetteId: "cassette-1",
    runId: "run-1",
    taskId: "task-1",
    createdAt: "2026-11-27T00:00:00.000Z",
    modelId: "deepseek-v3",
    protocol: "openai-chat",
    sampling: {},
    environmentDigest,
    toolCatalog: catalog,
    toolCatalogDigest: null,
    systemPrompt,
    goal: "写一个结果文件",
    exchangeCount: 0,
    kinds: {},
    manifestFingerprint: null,
    termination: null,
    ...overrides
  };
}

function fakeSink(): { sink: CassetteSink; drafts: ExchangeDraft[] } {
  const drafts: ExchangeDraft[] = [];
  const sink: CassetteSink = {
    runId: "run-1",
    record(draft) {
      drafts.push(draft);
    }
  };
  return { sink, drafts };
}

const toolContext: AgentToolContext = {
  workspaceRoot: "/tmp/work",
  outDir: "/tmp/work/out",
  permissions: { readRoots: ["/tmp/work"], writeRoots: ["/tmp/work/out"], networkHosts: [], tools: [] },
  signal: new AbortController().signal
};

describe("cassette fingerprints", () => {
  it("changes when the system prompt changes but stays stable for identical requests", () => {
    const base = {
      modelId: "m",
      protocol: "openai-chat",
      messages: [{ role: "system", content: systemPrompt }, { role: "user", content: "hi" }],
      tools: catalog,
      sampling: { temperature: 0.2, maxTokens: 100 }
    };
    const first = modelRequestFingerprint(describeModelRequest(base));
    const second = modelRequestFingerprint(describeModelRequest(base));
    expect(second).toBe(first);
    const changed = modelRequestFingerprint(describeModelRequest({
      ...base,
      messages: [{ role: "system", content: `${systemPrompt} 新增约束` }, { role: "user", content: "hi" }]
    }));
    expect(changed).not.toBe(first);
  });

  it("changes when a tool schema changes", () => {
    const first = modelRequestFingerprint(describeModelRequest({
      modelId: "m", protocol: "openai-chat", messages: [{ role: "user", content: "hi" }], tools: catalog
    }));
    const second = modelRequestFingerprint(describeModelRequest({
      modelId: "m", protocol: "openai-chat", messages: [{ role: "user", content: "hi" }],
      tools: [{ ...catalog[0]!, description: "读取文件（改）" }]
    }));
    expect(second).not.toBe(first);
  });

  it("uses the same args digest regardless of key order", () => {
    expect(toolCallFingerprint("shell", { a: 1, b: 2 })).toBe(toolCallFingerprint("shell", { b: 2, a: 1 }));
    expect(toolCallFingerprint("shell", { a: 1 })).not.toBe(toolCallFingerprint("grep", { a: 1 }));
  });

  it("produces a catalogue digest that ignores definition order", () => {
    const second: AgentToolDefinition = { name: "shell", description: "命令", parameters: { type: "object" } };
    expect(toolCatalogDigest([{ definition: catalog[0]! }, { definition: second }]))
      .toBe(toolCatalogDigest([{ definition: second }, { definition: catalog[0]! }]));
  });
});

describe("cassette model wrapper", () => {
  it("records request and response without changing the turn", async () => {
    const sink = fakeSink();
    const fake = createFakeModel([{ content: "done", usage: fakeUsage(10, 5) }]);
    const recorder = new ExchangeRecorder(sink.sink, environmentDigest);
    const model = cassetteModel(fake.model, {
      mode: "record",
      runId: "run-1",
      modelId: "deepseek-v3",
      protocol: "openai-chat",
      sampling: { temperature: 0.2 },
      recorder
    });
    const deltas: string[] = [];
    const turn = await model([{ role: "system", content: systemPrompt }], catalog, (text) => deltas.push(text), new AbortController().signal);
    expect(turn.content).toBe("done");
    expect(deltas).toEqual(["done"]);
    expect(fake.state.calls).toBe(1);
    expect(sink.drafts.map((draft) => draft.kind)).toEqual(["model.request", "model.response"]);
  });

  it("strict replay never calls the live model", async () => {
    const fake = createFakeModel([{ content: "live answer" }]);
    const source = new MemoryCassetteSource("c1", metadata());
    const descriptor = describeModelRequest({
      modelId: "deepseek-v3",
      protocol: "openai-chat",
      messages: [{ role: "system", content: systemPrompt }],
      tools: catalog,
      sampling: { temperature: 0.2 }
    });
    source.addModel(modelRequestFingerprint(descriptor), {
      content: "recorded answer",
      toolCalls: [],
      usage: fakeUsage(7, 3),
      finishReason: "stop"
    });
    const model = cassetteModel(fake.model, {
      mode: "strict_replay",
      runId: "run-1",
      modelId: "deepseek-v3",
      protocol: "openai-chat",
      sampling: { temperature: 0.2 },
      source
    });
    const result = await model([{ role: "system", content: systemPrompt }], catalog, () => undefined, new AbortController().signal);
    expect(result.content).toBe("recorded answer");
    expect(fake.state.calls).toBe(0);
  });

  it("strict replay reports request_fingerprint_mismatch instead of reusing old responses", async () => {
    const fake = createFakeModel([{ content: "live answer" }]);
    const source = new MemoryCassetteSource("c1", metadata());
    source.addModel("different", { content: "recorded", toolCalls: [], usage: null, finishReason: "stop" });
    const model = cassetteModel(fake.model, {
      mode: "strict_replay",
      runId: "run-1",
      modelId: "deepseek-v3",
      protocol: "openai-chat",
      source
    });
    await expect(model([{ role: "system", content: "changed prompt" }], catalog, () => undefined, new AbortController().signal))
      .rejects.toMatchObject({ name: "CassetteMismatchError", category: "model_request" });
    expect(fake.state.calls).toBe(0);
  });

  it("live-on-divergence falls back to live and reports divergence", async () => {
    const fake = createFakeModel([{ content: "live answer" }]);
    const divergences: string[] = [];
    const model = cassetteModel(fake.model, {
      mode: "live_on_divergence",
      runId: "run-1",
      modelId: "deepseek-v3",
      protocol: "openai-chat",
      source: new MemoryCassetteSource("c1", metadata()),
      onDivergence: (info) => divergences.push(info.category)
    });
    const result = await model([{ role: "user", content: "hello" }], catalog, () => undefined, new AbortController().signal);
    expect(result.content).toBe("live answer");
    expect(divergences).toEqual(["model_request"]);
  });
});

describe("cassette tool gateway", () => {
  const tool: AgentTool = {
    definition: catalog[0]!,
    async execute(input) {
      return { content: `live:${JSON.stringify(input)}` };
    }
  };

  it("strict replay returns recorded results without touching the workspace", async () => {
    const source = new MemoryCassetteSource("c1", metadata());
    const fingerprint = toolCallFingerprint("read_file", { path: "a.txt" });
    source.addTool(fingerprint, { content: "recorded", isError: false });
    const execute = vi.fn(tool.execute);
    const wrapped = cassetteTools([{ ...tool, execute }], {
      mode: "strict_replay", runId: "run-1", source
    });
    const result = await wrapped[0]!.execute({ path: "a.txt" }, toolContext);
    expect(result.content).toBe("recorded");
    expect(execute).not.toHaveBeenCalled();
  });

  it("a missing tool call in strict replay is an explicit mismatch", async () => {
    const wrapped = cassetteTools([tool], {
      mode: "strict_replay", runId: "run-1", source: new MemoryCassetteSource("c1", metadata())
    });
    await expect(wrapped[0]!.execute({ path: "missing.txt" }, toolContext))
      .rejects.toMatchObject({ name: "CassetteMismatchError", category: "tool_arguments" });
  });

  it("records tool call and result in record mode", async () => {
    const sink = fakeSink();
    const recorder = new ExchangeRecorder(sink.sink, environmentDigest);
    const wrapped = cassetteTools([tool], { mode: "record", runId: "run-1", recorder });
    const result = await wrapped[0]!.execute({ path: "b.txt" }, toolContext);
    expect(result.content).toContain("live:");
    expect(sink.drafts.map((draft) => draft.kind)).toEqual(["tool.call", "tool.result"]);
  });
});

describe("counterfactual override", () => {
  it("replaces exactly one matched call and continues normally", async () => {
    const calls: string[] = [];
    const shell: AgentTool = {
      definition: { name: "shell", description: "命令", parameters: { type: "object" } },
      async execute(input) {
        calls.push(`shell:${JSON.stringify(input)}`);
        return { content: "shell" };
      }
    };
    const grep: AgentTool = {
      definition: { name: "grep", description: "搜索", parameters: { type: "object" } },
      async execute(input) {
        calls.push(`grep:${JSON.stringify(input)}`);
        return { content: "grep" };
      }
    };
    const overridden = applyCounterfactualOverride([shell, grep], {
      toolName: "shell",
      arguments: { command: "rg TODO src" },
      replaceWith: "grep"
    });
    const first = await overridden.tools[0]!.execute({ command: "ls" }, toolContext);
    const second = await overridden.tools[0]!.execute({ command: "ls" }, toolContext);
    expect(first.content).toBe("grep");
    expect(second.content).toBe("shell");
    expect(calls).toEqual(["grep:{\"command\":\"rg TODO src\"}", "shell:{\"command\":\"ls\"}"]);
    expect(overridden.applied()).toBe(true);
  });
});
