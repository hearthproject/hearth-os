import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RunRecord, TaskRecord } from "@hearth/core";
import { publishArtifacts } from "./artifacts.ts";

describe("artifact publishing", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("ignores Hearth internal state instead of counting every checkpoint as an artifact", () => {
    const root = mkdtempSync(join(tmpdir(), "hearth-artifacts-"));
    roots.push(root);
    const outDir = join(root, "out");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "result.md"), "# Result\n");
    mkdirSync(join(outDir, ".hearth", "checkpoints", "run-1"), { recursive: true });
    for (let index = 0; index < 1_200; index += 1) {
      writeFileSync(join(outDir, ".hearth", "checkpoints", "run-1", `${index}.json`), "{}");
    }

    const task = { id: "task-1", title: "Review", outputDir: "task-1", outputDirMode: "managed" } as unknown as TaskRecord;
    const run = { id: "run-1", attempt: 1 } as unknown as RunRecord;
    const artifacts = publishArtifacts({
      task,
      run,
      outDir,
      artifactBase: join(root, ".hearth", "artifacts"),
      expectedOutputs: ["result.md"],
      inputs: []
    });

    expect(artifacts.filter((artifact) => artifact.relativePath.startsWith(".hearth/"))).toHaveLength(0);
    expect(artifacts.some((artifact) => artifact.relativePath === "result.md")).toBe(true);
    expect(artifacts.every((artifact) => artifact.bytes > 0)).toBe(true);
  });
});
