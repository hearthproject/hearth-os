// Durable cassette storage: content-addressed blobs in the evidence directory,
// an index in the evidence database. Replay loads only through this layer.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  MemoryCassetteSource,
  canonicalJson,
  sha256Hex,
  type AgentModelTurn,
  type AgentToolResult,
  type CassetteMetadata,
  type CassetteSink,
  type CassetteSource,
  type ExchangeDraft,
  type ReplayedModelTurn,
  type ReplayedToolResult,
  type RuntimeExchange
} from "@hearth/agent-runtime";
import type { EvidenceStore } from "./store.ts";

function blobPath(root: string, ref: string): string {
  const hex = ref.replace(/^sha256:/, "");
  return join(root, hex.slice(0, 2), hex);
}

export function writeContentBlob(root: string, value: unknown): { ref: string; sha256: string; bytes: number } {
  const serialized = typeof value === "string" ? value : canonicalJson(value);
  const sha256 = sha256Hex(serialized);
  const path = blobPath(root, `sha256:${sha256}`);
  if (!existsSync(path)) {
    mkdirSync(join(root, sha256.slice(0, 2)), { recursive: true });
    writeFileSync(path, typeof value === "string" ? serialized : `${JSON.stringify(value)}\n`, "utf8");
  }
  return { ref: `sha256:${sha256}`, sha256, bytes: Buffer.byteLength(serialized, "utf8") };
}

export function readContentBlob(root: string, ref: string): unknown {
  const path = blobPath(root, ref);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

export interface CassetteSessionOptions {
  store: EvidenceStore;
  runId: string;
  taskId: string | null;
  goal: string | null;
  environmentDigest: string;
  toolCatalogDigest?: string | null;
  sourceLabel?: string;
  now?: () => Date;
}

export class CassetteSession implements CassetteSink {
  readonly runId: string;
  readonly cassetteId: string;
  private readonly exchanges: RuntimeExchange[] = [];
  private readonly startedAt: string;
  private finished = false;
  private observedCatalogDigest: string | null = null;

  constructor(private readonly options: CassetteSessionOptions) {
    this.runId = options.runId;
    this.cassetteId = `cassette:${options.runId}`;
    this.startedAt = (options.now ?? (() => new Date()))().toISOString();
  }

  setToolCatalogDigest(digest: string): void {
    this.observedCatalogDigest = digest;
  }

  record(draft: ExchangeDraft, exchange?: RuntimeExchange): void {
    if (!exchange) return;
    writeContentBlob(this.options.store.blobRoot, draft.input);
    if (draft.output !== undefined) writeContentBlob(this.options.store.blobRoot, draft.output);
    this.exchanges.push(exchange);
  }

  /** Called at the end of the run; also finalizes metadata for Strict Replay. */
  finish(termination: Record<string, unknown>): CassetteMetadata {
    const now = (this.options.now ?? (() => new Date()))();
    if (!this.finished) {
      this.finished = true;
      const exchange: RuntimeExchange = {
        schemaVersion: 1,
        id: `${this.runId}:termination`,
        runId: this.runId,
        parentId: this.exchanges.at(-1)?.id ?? null,
        kind: "termination",
        sequence: this.exchanges.length + 1,
        stepId: null,
        requestFingerprint: null,
        environmentDigest: this.options.environmentDigest,
        input: { ref: "sha256:termination", sha256: "termination", bytes: 0, summary: null },
        output: {
          ref: `sha256:${sha256Hex(canonicalJson(termination))}`,
          sha256: sha256Hex(canonicalJson(termination)),
          bytes: Buffer.byteLength(canonicalJson(termination), "utf8"),
          summary: String(termination.status ?? termination.reason ?? "termination")
        },
        latencyMs: null,
        usage: null,
        sideEffectReceipt: null,
        simulated: false,
        createdAt: now.toISOString()
      };
      this.exchanges.push(exchange);
      writeContentBlob(this.options.store.blobRoot, termination);
    }
    const metadata = this.metadata(now.toISOString());
    this.options.store.saveCassette(this.cassetteId, metadata, this.exchanges);
    return metadata;
  }

  private metadata(createdAt: string): CassetteMetadata {
    const firstRequest = this.exchanges.find((exchange) => exchange.kind === "model.request");
    const descriptor = firstRequest
      ? readContentBlob(this.options.store.blobRoot, firstRequest.input.ref) as {
          modelId?: string;
          protocol?: string;
          sampling?: Record<string, unknown>;
          messages?: Array<{ role: string; content: string }>;
          tools?: CassetteMetadata["toolCatalog"];
        } | null
      : null;
    const systemPrompt = descriptor?.messages?.find((message) => message.role === "system")?.content ?? null;
    const kinds: CassetteMetadata["kinds"] = {};
    for (const exchange of this.exchanges) {
      kinds[exchange.kind] = (kinds[exchange.kind] ?? 0) + 1;
    }
    const terminationExchange = this.exchanges.find((exchange) => exchange.kind === "termination");
    return {
      cassetteId: this.cassetteId,
      runId: this.runId,
      taskId: this.options.taskId,
      createdAt,
      modelId: descriptor?.modelId ?? null,
      protocol: descriptor?.protocol ?? null,
      sampling: (descriptor?.sampling as CassetteMetadata["sampling"]) ?? null,
      environmentDigest: this.options.environmentDigest,
      toolCatalog: descriptor?.tools ?? [],
      toolCatalogDigest: this.observedCatalogDigest ?? this.options.toolCatalogDigest ?? null,
      systemPrompt,
      goal: this.options.goal,
      exchangeCount: this.exchanges.length,
      kinds,
      manifestFingerprint: null,
      termination: terminationExchange
        ? readContentBlob(this.options.store.blobRoot, terminationExchange.output.ref) as Record<string, unknown>
        : null
    };
  }

  exchangesView(): RuntimeExchange[] {
    return [...this.exchanges];
  }
}

export interface LoadedCassette {
  metadata: CassetteMetadata;
  exchanges: RuntimeExchange[];
  source: CassetteSource;
  termination: Record<string, unknown> | null;
}

export function loadCassette(store: EvidenceStore, cassetteId: string): LoadedCassette | null {
  const stored = store.getCassette(cassetteId);
  if (!stored) return null;
  const source = new MemoryCassetteSource(cassetteId, stored.metadata);
  let toolOrdinal = 0;
  for (const exchange of stored.exchanges) {
    if (exchange.kind === "model.response") {
      const output = readContentBlob(store.blobRoot, exchange.output.ref) as {
        content?: string;
        toolCalls?: AgentModelTurn["toolCalls"];
        finishReason?: string | null;
      } | null;
      if (!output) continue;
      const turn: AgentModelTurn = {
        content: output.content ?? "",
        toolCalls: output.toolCalls ?? [],
        usage: exchange.usage ? { ...exchange.usage } : null,
        finishReason: output.finishReason ?? "stop"
      };
      source.addModel(exchange.requestFingerprint ?? "", turn);
    }
    if (exchange.kind === "tool.result" && exchange.requestFingerprint) {
      const result = readContentBlob(store.blobRoot, exchange.output.ref) as AgentToolResult | null;
      if (!result || typeof result.content !== "string") continue;
      const meta = readContentBlob(store.blobRoot, exchange.input.ref) as { ordinal?: number } | null;
      source.addTool(exchange.requestFingerprint, result, meta?.ordinal ?? 0);
      toolOrdinal += 1;
    }
  }
  void toolOrdinal;
  const termination = stored.exchanges.find((exchange) => exchange.kind === "termination");
  return {
    metadata: stored.metadata,
    exchanges: stored.exchanges,
    source,
    termination: termination ? readContentBlob(store.blobRoot, termination.output.ref) as Record<string, unknown> : null
  };
}

export function listCassettes(store: EvidenceStore, runId?: string): CassetteMetadata[] {
  return store.listCassettes(runId);
}

export function replayedTurn(result: ReplayedModelTurn): AgentModelTurn {
  return result.turn;
}

export function replayedResult(result: ReplayedToolResult): AgentToolResult {
  return result.result;
}

