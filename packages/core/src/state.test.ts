import { describe, expect, it } from "vitest";
import { assertTransition, canTransition, isTerminal } from "./state.ts";

describe("task state machine", () => {
  it("allows the expected happy path", () => {
    expect(canTransition("queued", "running")).toBe(true);
    expect(canTransition("running", "waiting_approval")).toBe(true);
    expect(canTransition("waiting_approval", "running")).toBe(true);
    expect(canTransition("running", "completed")).toBe(true);
  });

  it("lets a queued task become recoverable when its executor is unavailable", () => {
    expect(canTransition("queued", "recoverable")).toBe(true);
    expect(() => assertTransition("queued", "recoverable")).not.toThrow();
  });

  it("pauses a running task and allows it to resume or be cancelled", () => {
    expect(canTransition("running", "paused")).toBe(true);
    expect(canTransition("paused", "queued")).toBe(true);
    expect(canTransition("paused", "cancelled")).toBe(true);
    expect(isTerminal("paused")).toBe(false);
  });

  it("reopens a completed goal or plan task through an explicit queue transition", () => {
    expect(canTransition("completed", "queued")).toBe(true);
    expect(() => assertTransition("completed", "queued")).not.toThrow();
  });

  it("rejects other transitions out of terminal states", () => {
    expect(canTransition("completed", "running")).toBe(false);
    expect(canTransition("cancelled", "queued")).toBe(false);
    expect(() => assertTransition("completed", "running")).toThrow("Invalid task transition");
  });

  it("marks completed and cancelled as terminal", () => {
    expect(isTerminal("completed")).toBe(true);
    expect(isTerminal("cancelled")).toBe(true);
    expect(isTerminal("recoverable")).toBe(false);
  });
});
