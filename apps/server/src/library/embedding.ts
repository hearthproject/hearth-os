import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";

export type EmbeddingState = "missing" | "downloading" | "ready" | "error";

export interface EmbeddingProvider {
  readonly modelId: string;
  readonly modelVersion: string;
  readonly dimensions: number;
  readonly state: EmbeddingState;
  readonly progress: number | null;
  readonly error: string | null;
  load(): Promise<void>;
  embed(texts: string[]): Promise<Float32Array[]>;
}

export interface LocalEmbeddingProviderOptions {
  cacheDir: string;
  modelId?: string;
  modelVersion?: string;
  remoteHost?: string;
  loader?: () => Promise<FeatureExtractor>;
}

interface FeatureExtractor {
  (texts: string[], options: { pooling: "mean"; normalize: true }): Promise<{ tolist(): number[][] }>;
}

export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly modelId: string;
  readonly modelVersion: string;
  readonly dimensions = 512;
  readonly cacheDir: string;
  private readonly remoteHost: string | undefined;
  private readonly loader: (() => Promise<FeatureExtractor>) | null;
  private extractor: FeatureExtractor | null = null;
  private loading: Promise<void> | null = null;
  private currentState: EmbeddingState = "missing";
  private currentProgress: number | null = null;
  private currentError: string | null = null;

  constructor(options: LocalEmbeddingProviderOptions) {
    this.cacheDir = options.cacheDir;
    this.modelId = options.modelId ?? "Xenova/bge-small-zh-v1.5";
    this.modelVersion = options.modelVersion ?? "v1";
    this.remoteHost = options.remoteHost ?? process.env.HEARTH_LIBRARY_MODEL_ENDPOINT;
    this.loader = options.loader ?? null;
  }

  get state(): EmbeddingState {
    return this.currentState;
  }

  get progress(): number | null {
    return this.currentProgress;
  }

  get error(): string | null {
    return this.currentError;
  }

  async load(): Promise<void> {
    if (this.currentState === "ready" && this.extractor) return;
    if (this.loading) return this.loading;
    this.currentState = "downloading";
    this.currentProgress = 0;
    this.currentError = null;
    this.loading = this.createExtractor()
      .then((extractor) => {
        this.extractor = extractor;
        this.currentState = "ready";
        this.currentProgress = 1;
      })
      .catch((error: unknown) => {
        this.currentState = "error";
        this.currentProgress = null;
        this.currentError = error instanceof Error ? error.message : String(error);
        throw error;
      })
      .finally(() => {
        this.loading = null;
      });
    return this.loading;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    await this.load();
    if (!this.extractor) throw new Error("语义模型尚未就绪");
    const output = await this.extractor(texts, { pooling: "mean", normalize: true });
    return output.tolist().map((row) => Float32Array.from(row));
  }

  private async createExtractor(): Promise<FeatureExtractor> {
    if (this.loader) return this.loader();
    mkdirSync(this.cacheDir, { recursive: true });
    const transformers = await import("@huggingface/transformers");
    transformers.env.cacheDir = this.cacheDir;
    transformers.env.allowRemoteModels = true;
    transformers.env.allowLocalModels = true;
    if (this.remoteHost) {
      (transformers.env as unknown as { remoteHost: string }).remoteHost = this.remoteHost;
    }
    const extractor = await transformers.pipeline("feature-extraction", this.modelId, {
      dtype: "q8",
      progress_callback: (event: { status?: string; progress?: number }) => {
        if (typeof event.progress === "number") this.currentProgress = Math.max(0, Math.min(1, event.progress));
      }
    });
    if (typeof extractor !== "function") throw new Error("语义模型加载结果不可用");
    return extractor as unknown as FeatureExtractor;
  }
}

export function embeddingToBuffer(vector: Float32Array): Buffer {
  const bytes = Buffer.allocUnsafe(vector.length * 4);
  for (let index = 0; index < vector.length; index += 1) bytes.writeFloatLE(vector[index] ?? 0, index * 4);
  return bytes;
}

export function bufferToEmbedding(buffer: Buffer | Uint8Array): Float32Array {
  const bytes = Buffer.from(buffer);
  if (bytes.length % 4 !== 0) throw new Error("向量数据不完整");
  const vector = new Float32Array(bytes.length / 4);
  for (let index = 0; index < vector.length; index += 1) vector[index] = bytes.readFloatLE(index * 4);
  return vector;
}

export function cosineSimilarity(left: Float32Array, right: Float32Array): number {
  if (left.length !== right.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

export function modelFingerprint(modelId: string, version: string): string {
  return createHash("sha256").update(`${modelId}:${version}`).digest("hex").slice(0, 16);
}
