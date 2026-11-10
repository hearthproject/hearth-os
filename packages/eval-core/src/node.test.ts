import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadCaseCatalog, validateCatalogShape } from "./node.ts";
import { runGrader } from "./graders.ts";
import { EVAL_FAMILIES, type ArtifactMap } from "./types.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

describe("case catalog", () => {
  it("loads exactly 60 valid cases across eight families", () => {
    const loaded = loadCaseCatalog(repoRoot);
    expect(loaded.issues).toEqual([]);
    expect(loaded.cases).toHaveLength(60);
    expect(validateCatalogShape(loaded.cases)).toEqual([]);
    const counts = Object.fromEntries(EVAL_FAMILIES.map((family) => [family, 0]));
    for (const loadedCase of loaded.cases) {
      const family = loadedCase.manifest.family;
      counts[family] = (counts[family] ?? 0) + 1;
    }
    expect(counts).toEqual({
      email: 8,
      calendar: 7,
      documents: 9,
      research: 8,
      code: 8,
      web: 8,
      desktop: 5,
      "cross-app": 7
    });
  });

  it("passes every deterministic grader against each offline golden artifact", () => {
    const loaded = loadCaseCatalog(repoRoot);
    const failures: string[] = [];
    for (const loadedCase of loaded.cases) {
      if (loadedCase.manifest.runModes.length === 1 && loadedCase.manifest.runModes[0] === "live-only") continue;
      const artifacts = readArtifacts(join(loadedCase.directory, "golden"));
      for (const criterion of loadedCase.manifest.criteria.filter((item) => item.source === "deterministic")) {
        const grader = loadedCase.manifest.graders.find((item) => item.id === criterion.graderId);
        if (!grader) {
          failures.push(`${loadedCase.manifest.id}/${criterion.id}: missing grader`);
          continue;
        }
        const result = runGrader(grader, artifacts);
        if (!result.passed) failures.push(`${loadedCase.manifest.id}/${criterion.id}: ${result.reason}`);
      }
    }
    expect(failures).toEqual([]);
  });
});

function readArtifacts(directory: string, prefix = ""): ArtifactMap {
  const artifacts: ArtifactMap = {};
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      Object.assign(artifacts, readArtifacts(absolute, relative));
      continue;
    }
    const text = readFileSync(absolute, "utf8");
    artifacts[relative] = { text, bytes: statSync(absolute).size };
  }
  return artifacts;
}
