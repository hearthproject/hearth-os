import { describe, expect, it } from "vitest";
import { parseCsv, runGrader } from "./graders.ts";
import type { ArtifactMap, GraderSpec } from "./types.ts";

const artifacts: ArtifactMap = {
  "notes.md": { text: "项目结论\n负责人：张三\n", bytes: 24 },
  "result.json": { text: JSON.stringify({ status: "ok", items: [{ id: 1 }, { id: 2 }] }), bytes: 48 },
  "rows.csv": { text: "name,amount\nA,10\nB,20\n", bytes: 24 }
};

function grade(spec: GraderSpec) {
  return runGrader(spec, artifacts);
}

describe("runGrader", () => {
  it("checks text includes and excludes", () => {
    expect(grade({ id: "t", title: "text", config: { kind: "text", path: "notes.md", includes: ["项目结论", "张三"], excludes: ["待补充"] } }).passed).toBe(true);
    expect(grade({ id: "t", title: "text", config: { kind: "text", path: "notes.md", excludes: ["项目结论"] } }).passed).toBe(false);
  });

  it("checks JSON paths, values and array lengths", () => {
    const result = grade({
      id: "j",
      title: "json",
      config: { kind: "json", path: "result.json", requiredPaths: ["status", "items.1.id"], equals: { status: "ok" }, minArrayLength: { items: 2 } }
    });
    expect(result.passed).toBe(true);
  });

  it("checks CSV columns and values", () => {
    const result = grade({
      id: "c",
      title: "csv",
      config: { kind: "csv", path: "rows.csv", requiredColumns: ["name", "amount"], minRows: 2, requiredValues: [{ column: "name", equals: "B" }] }
    });
    expect(result.passed).toBe(true);
  });

  it("returns a useful failure for missing artifacts", () => {
    const result = grade({ id: "f", title: "file", config: { kind: "file", path: "missing.md" } });
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("missing.md");
  });

  it("parses quoted CSV cells", () => {
    expect(parseCsv('name,note\nA,"x, y"\n')).toEqual([["name", "note"], ["A", "x, y"]]);
  });
});
