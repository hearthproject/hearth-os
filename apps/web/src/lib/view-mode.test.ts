import { describe, expect, it } from "vitest";
import { resolveViewMode, shouldPersistViewMode } from "./view-mode.tsx";

describe("resolveViewMode", () => {
  it("defaults to the simple view", () => {
    expect(resolveViewMode(null)).toBe("simple");
    expect(resolveViewMode("")).toBe("simple");
    expect(resolveViewMode("aggressive")).toBe("simple");
  });

  it("keeps a stored professional view", () => {
    expect(resolveViewMode("pro")).toBe("pro");
  });

  it("lets the url pin the mode for scripted checks", () => {
    expect(resolveViewMode("pro", "simple")).toBe("simple");
    expect(resolveViewMode("simple", "pro")).toBe("pro");
    expect(resolveViewMode("pro", "banana")).toBe("pro");
  });

  it("does not persist a scripted url override", () => {
    expect(shouldPersistViewMode("simple")).toBe(false);
    expect(shouldPersistViewMode("pro")).toBe(false);
    expect(shouldPersistViewMode(null)).toBe(true);
    expect(shouldPersistViewMode("banana")).toBe(true);
  });
});
