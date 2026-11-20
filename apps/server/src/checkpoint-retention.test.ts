import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pruneRunCheckpointFiles } from "./scheduler.ts";

describe("checkpoint retention", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("keeps milestones and the newest 40 non-milestone checkpoints", () => {
    const root = mkdtempSync(join(tmpdir(), "hearth-checkpoints-"));
    roots.push(root);
    for (let seq = 1; seq <= 100; seq += 1) {
      writeFileSync(join(root, `${String(seq).padStart(4, "0")}-tool.json`), "{}", "utf8");
    }
    writeFileSync(join(root, "0101-compaction.json"), "{}", "utf8");
    writeFileSync(join(root, "0102-final.json"), "{}", "utf8");
    writeFileSync(join(root, "0103-plan.json"), "{}", "utf8");

    pruneRunCheckpointFiles(root);

    const names = readdirSync(root);
    expect(names.filter((name) => name.endsWith("-tool.json"))).toHaveLength(40);
    expect(names).toContain("0101-compaction.json");
    expect(names).toContain("0102-final.json");
    expect(names).toContain("0103-plan.json");
    expect(names).not.toContain("0001-tool.json");
    expect(names).toContain("0061-tool.json");
  });
});
