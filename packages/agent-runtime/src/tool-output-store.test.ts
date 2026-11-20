import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { storeOversizedToolResult } from "./harness/tool-output-store.ts";

describe("oversized tool result artifacts", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("stores a 20MB result and keeps the message bounded", () => {
    const root = mkdtempSync(join(tmpdir(), "hearth-tool-results-"));
    roots.push(root);
    const body = "x".repeat(20 * 1024 * 1024);

    const stored = storeOversizedToolResult(root, "shell", body);

    expect(stored.fullOutputPath).not.toBeNull();
    expect(stored.content.length).toBeLessThan(16_000);
    expect(stored.content).toContain("full output:");
    expect(statSync(stored.fullOutputPath!).size).toBe(body.length);
  });

  it("deduplicates identical oversized output", () => {
    const root = mkdtempSync(join(tmpdir(), "hearth-tool-results-"));
    roots.push(root);
    const body = "y".repeat(17_000);

    const first = storeOversizedToolResult(root, "tool", body);
    const second = storeOversizedToolResult(root, "tool", body);

    expect(second.fullOutputPath).toBe(first.fullOutputPath);
  });
});
