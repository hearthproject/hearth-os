import type { ScenarioAssertion, ScenarioDefinition } from "@hearth/eval-core";

export interface ControlledClock {
  now(): Date;
  set(value: Date | string): void;
  advance(ms: number): void;
}

export interface ScenarioContext {
  scenario: ScenarioDefinition;
  repetition: number;
  root: string;
  artifactDir: string;
  clock: ControlledClock;
  fakeUser: { id: string; name: string };
  fakePreference: string;
  fakeSecret: string;
  assertions: ScenarioAssertion[];
  evidence: Record<string, unknown>;
  check(name: string, passed: boolean, detail: string): boolean;
  record(key: string, value: unknown): void;
}

export interface ScenarioHandlerResult {
  summary: Record<string, unknown>;
  assertions: ScenarioAssertion[];
}

export type ScenarioHandler = (context: ScenarioContext) => Promise<ScenarioHandlerResult>;
