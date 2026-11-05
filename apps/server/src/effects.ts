import type { EffectRecord } from "@hearth/core";

export async function executeEffect(effect: EffectRecord): Promise<Record<string, unknown>> {
  throw new Error(`外部动作执行器尚未接入：${effect.kind}`);
}
