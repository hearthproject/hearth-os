import type { ArtifactRecord, EffectRecord } from "@hearth/core";
import { executeGitHubEffect } from "./github.ts";

export interface EffectExecutionContext {
  getArtifact?(id: string): ArtifactRecord | null;
}

export async function executeEffect(
  effect: EffectRecord,
  _context: EffectExecutionContext = {}
): Promise<Record<string, unknown>> {
  if (effect.kind.startsWith("github.")) return executeGitHubEffect(effect);
  throw new Error(`外部动作执行器尚未接入：${effect.kind}`);
}
