import { p0ActionScenarios } from "./p0-action.ts";
import { p0BoundaryScenarios } from "./p0-boundary.ts";
import { p0EffectScenarios } from "./p0-effect.ts";
import { p0SensitiveScenarios } from "./p0-sensitive.ts";
import { p1MemorySkillScenarios } from "./p1-memory-skill.ts";
import { p1ScheduleScenarios } from "./p1-schedule.ts";
import { p1ProactiveScenarios } from "./p1-proactive.ts";
import { p2ConnectionScenarios } from "./p2-connection.ts";
import { paScenarios } from "./pa-scenarios.ts";
import type { ScenarioHandler } from "./types.ts";

export const scenarioHandlers: Record<string, ScenarioHandler> = {
  ...p0ActionScenarios,
  ...p0BoundaryScenarios,
  ...p0EffectScenarios,
  ...p0SensitiveScenarios,
  ...p1MemorySkillScenarios,
  ...p1ScheduleScenarios,
  ...p1ProactiveScenarios,
  ...p2ConnectionScenarios,
  ...paScenarios
};

export function scenarioHandler(id: string): ScenarioHandler {
  const handler = scenarioHandlers[id];
  if (!handler) throw new Error(`No scenario handler registered for ${id}`);
  return handler;
}
