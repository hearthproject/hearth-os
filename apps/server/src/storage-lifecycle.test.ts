import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inheritPreviousOutput } from "./scheduler.ts";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "hearth-storage-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("retry output inheritance", () => {
  it("copies published files but not journal, cache or checkpoint bookkeeping", () => {
    const root = tempRoot();
    const previous = join(root, "out", "run-1");
    const next = join(root, "out", "run-2");
    mkdirSync(join(previous, ".hearth", "journals"), { recursive: true });
    mkdirSync(join(previous, ".hearth", "cache"), { recursive: true });
    mkdirSync(join(previous, ".hearth", "checkpoints"), { recursive: true });
    mkdirSync(join(previous, ".hearth", "tool-results"), { recursive: true });
    writeFileSync(join(previous, "result.md"), "# published\n", "utf8");
    writeFileSync(join(previous, ".hearth", "journals", "run.jsonl"), "{}\n", "utf8");
    writeFileSync(join(previous, ".hearth", "cache", "blob.bin"), "cache", "utf8");
    writeFileSync(join(previous, ".hearth", "checkpoints", "1.json"), "{}", "utf8");
    const referenced = "0123456789abcdef.txt";
    const unreferenced = "fedcba9876543210.txt";
    writeFileSync(join(previous, ".hearth", "tool-results", referenced), "kept", "utf8");
    writeFileSync(join(previous, ".hearth", "tool-results", unreferenced), "dropped", "utf8");

    inheritPreviousOutput(previous, next, {
      messages: [{ role: "tool", content: `full output: ${join(previous, ".hearth", "tool-results", referenced)}` }]
    });

    expect(existsSync(join(next, "result.md"))).toBe(true);
    expect(existsSync(join(next, ".hearth", "journals"))).toBe(false);
    expect(existsSync(join(next, ".hearth", "cache"))).toBe(false);
    expect(existsSync(join(next, ".hearth", "checkpoints"))).toBe(false);
    expect(existsSync(join(next, ".hearth", "tool-results", referenced))).toBe(true);
    expect(existsSync(join(next, ".hearth", "tool-results", unreferenced))).toBe(false);
  });
});
