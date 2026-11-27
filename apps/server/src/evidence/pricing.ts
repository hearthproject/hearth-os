// Versioned USD pricing for model usage.
//
// Prices are operator-owned data, not code defaults. A missing price is
// recorded as `unpriced` and never silently converted to zero.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, digestOf } from "./contracts.ts";

export interface PriceRow {
  providerId: string | null;
  /** Case-insensitive substring matched against the model id. Longest match wins. */
  modelPattern: string;
  inputPerMTok: number;
  cachedInputPerMTok: number | null;
  cacheWritePerMTok: number | null;
  outputPerMTok: number;
  reasoningPerMTok: number | null;
  /** Where the number came from (vendor page, invoice, contract). */
  source: string;
  asOf: string;
}

export interface PricingSnapshot {
  schemaVersion: 1;
  id: string;
  version: string;
  currency: "USD";
  asOf: string;
  rows: PriceRow[];
  digest: string;
  source: string;
}

export interface CostComponent {
  component: "input" | "cached_input" | "cache_write" | "output" | "reasoning";
  tokens: number;
  usd: number;
}

export interface CostEstimate {
  priced: boolean;
  currency: "USD";
  usd: number;
  snapshotId: string;
  pricingVersion: string;
  components: CostComponent[];
  unpricedReason: string | null;
}

export interface UsageLike {
  inputTokens: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  outputTokens: number;
  reasoningOutputTokens?: number;
}

export const EMPTY_PRICING_ROWS: PriceRow[] = [];

export function loadPricingFile(path: string): PriceRow[] {
  if (!existsSync(path)) return [];
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const rows = Array.isArray(raw) ? raw : (raw as { rows?: unknown }).rows;
  if (!Array.isArray(rows)) throw new Error(`价格文件格式错误：${path}`);
  return rows.map((row) => validatePriceRow(row));
}

export function validatePriceRow(value: unknown): PriceRow {
  if (!value || typeof value !== "object") throw new Error("价格行必须是对象");
  const record = value as Record<string, unknown>;
  const modelPattern = typeof record.modelPattern === "string" ? record.modelPattern : typeof record.model === "string" ? record.model : "";
  if (!modelPattern) throw new Error("价格行缺少 modelPattern");
  const nonNegative = (field: string, required: boolean): number | null => {
    const raw = record[field];
    if (raw === undefined || raw === null) {
      if (required) throw new Error(`价格行缺少 ${field}`);
      return null;
    }
    const number = Number(raw);
    if (!Number.isFinite(number) || number < 0) throw new Error(`价格行 ${field} 必须是非负数`);
    return number;
  };
  return {
    providerId: typeof record.providerId === "string" ? record.providerId : null,
    modelPattern,
    inputPerMTok: nonNegative("inputPerMTok", true) as number,
    cachedInputPerMTok: nonNegative("cachedInputPerMTok", false),
    cacheWritePerMTok: nonNegative("cacheWritePerMTok", false),
    outputPerMTok: nonNegative("outputPerMTok", true) as number,
    reasoningPerMTok: nonNegative("reasoningPerMTok", false),
    source: typeof record.source === "string" ? record.source : "operator",
    asOf: typeof record.asOf === "string" ? record.asOf : new Date().toISOString().slice(0, 10)
  };
}

export class PricingRegistry {
  private snapshot: PricingSnapshot;

  constructor(input: { rows?: PriceRow[]; version?: string; source?: string; dataDir?: string; envPath?: string | null; now?: Date } = {}) {
    const now = input.now ?? new Date();
    const filePath = input.envPath ?? (input.dataDir ? join(input.dataDir, "pricing.json") : null);
    const fileRows = filePath ? loadPricingFile(filePath) : [];
    const rows = [...(input.rows ?? []), ...fileRows];
    this.snapshot = this.build(rows, input.version ?? "custom", input.source ?? (filePath ? `file:${filePath}` : "none"), now);
  }

  private build(rows: PriceRow[], version: string, source: string, now: Date): PricingSnapshot {
    const sorted = [...rows].sort((left, right) =>
      `${left.providerId ?? ""}:${left.modelPattern}`.localeCompare(`${right.providerId ?? ""}:${right.modelPattern}`));
    const body = {
      schemaVersion: 1 as const,
      currency: "USD" as const,
      rows: sorted,
      version,
      source
    };
    const digest = digestOf(body);
    return {
      schemaVersion: 1,
      id: `pricing:${digest.slice("sha256:".length, 7 + 12)}`,
      version,
      currency: "USD",
      asOf: now.toISOString(),
      rows: sorted,
      digest,
      source
    };
  }

  active(): PricingSnapshot {
    return this.snapshot;
  }

  /** Replace the active table (operator edit / test). Keeps a new digest. */
  replace(rows: PriceRow[], version: string, source: string): PricingSnapshot {
    this.snapshot = this.build(rows, version, source, new Date());
    return this.snapshot;
  }

  match(providerId: string | null, modelId: string): PriceRow | null {
    const model = modelId.toLowerCase();
    const provider = providerId?.toLowerCase() ?? null;
    const candidates = this.snapshot.rows
      .filter((row) => row.modelPattern && model.includes(row.modelPattern.toLowerCase()))
      .filter((row) => row.providerId === null || provider === null || row.providerId.toLowerCase() === provider)
      .sort((left, right) => right.modelPattern.length - left.modelPattern.length);
    return candidates[0] ?? null;
  }

  estimate(input: {
    providerId: string | null;
    modelId: string;
    usage: UsageLike;
    fallbackRow?: PriceRow | null;
  }): CostEstimate {
    const row = this.match(input.providerId, input.modelId) ?? input.fallbackRow ?? null;
    if (!row) {
      return {
        priced: false,
        currency: "USD",
        usd: 0,
        snapshotId: this.snapshot.id,
        pricingVersion: this.snapshot.version,
        components: [],
        unpricedReason: `pricing_missing: ${input.providerId ?? "*"}/${input.modelId}`
      };
    }
    const cacheWrite = Math.max(0, input.usage.cacheWriteInputTokens ?? 0);
    const cached = Math.max(0, input.usage.cachedInputTokens ?? 0);
    const billableInput = Math.max(0, input.usage.inputTokens - cached - cacheWrite);
    const output = Math.max(0, input.usage.outputTokens);
    const reasoning = Math.max(0, input.usage.reasoningOutputTokens ?? 0);
    const perMillion = (tokens: number, rate: number | null): number =>
      rate === null ? 0 : (tokens / 1_000_000) * rate;
    const allComponents: CostComponent[] = [
      { component: "input", tokens: billableInput, usd: perMillion(billableInput, row.inputPerMTok) },
      { component: "cached_input", tokens: cached, usd: perMillion(cached, row.cachedInputPerMTok) },
      { component: "cache_write", tokens: cacheWrite, usd: perMillion(cacheWrite, row.cacheWritePerMTok) },
      {
        component: "output",
        tokens: Math.max(0, output - reasoning),
        usd: perMillion(Math.max(0, output - reasoning), row.outputPerMTok)
      },
      { component: "reasoning", tokens: reasoning, usd: perMillion(reasoning, row.reasoningPerMTok ?? row.outputPerMTok) }
    ];
    const components = allComponents.filter((component) => component.tokens > 0 || component.usd > 0);
    const usd = components.reduce((sum, component) => sum + component.usd, 0);
    return {
      priced: true,
      currency: "USD",
      usd: Number(usd.toFixed(6)),
      snapshotId: this.snapshot.id,
      pricingVersion: this.snapshot.version,
      components,
      unpricedReason: null
    };
  }
}

/** Public snapshot payload for the read-only API. */
export function pricingSnapshotView(registry: PricingRegistry): Record<string, unknown> {
  const snapshot = registry.active();
  return {
    id: snapshot.id,
    version: snapshot.version,
    currency: snapshot.currency,
    asOf: snapshot.asOf,
    source: snapshot.source,
    digest: snapshot.digest,
    rows: snapshot.rows,
    canonical: canonicalJson(snapshot.rows)
  };
}
