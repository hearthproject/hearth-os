import { describe, expect, it } from "vitest";
import {
  buildDailySkillIndex,
  buildFullSkillDocument,
  buildSkillResourceList,
  classifySkillResource,
  clipSkillDescription,
  parseSkillDocument,
  renderSkillDocument,
  SkillPackageError
} from "./skill-package.ts";

const SKILL = `---
name: weekly-review
description: Summarize the week and flag unfinished commitments.
version: 1.0.0
platforms: [windows, macos, linux]
tools: [read_file, search_files, write_file]
permissions:
  readRoots: ["~/.hearth/notes"]
  writeRoots: ["~/.hearth/notes/reviews"]
  networkHosts: []
metadata:
  hearth:
    category: productivity
    originTaskId: task_123
    originHash: sha256:${"a".repeat(64)}
    adoptedAt: 2026-11-09
---

# Weekly Review Skill

## When to Use

Use on Friday afternoons.

## Prerequisites

Read the notes folder.

## Procedure

1. Collect the week.
2. Flag unfinished commitments.

## Quick Reference

- notes: ~/.hearth/notes

## Pitfalls

Do not mark an unfinished item complete.

## Verification

Every flagged item points to a source note.
`;

describe("skill package", () => {
  it("parses and renders a readable SKILL.md without losing metadata", () => {
    const document = parseSkillDocument(SKILL);
    expect(document.manifest).toMatchObject({
      name: "weekly-review",
      version: "1.0.0",
      platforms: ["windows", "macos", "linux"],
      tools: ["read_file", "search_files", "write_file"],
      permissions: {
        readRoots: ["~/.hearth/notes"],
        writeRoots: ["~/.hearth/notes/reviews"],
        networkHosts: []
      },
      metadata: {
        hearth: {
          category: "productivity",
          originTaskId: "task_123",
          origin: "agent",
          pinned: false
        }
      }
    });
    expect(document.contentHash).toMatch(/^sha256:[a-f0-9]{64}$/);

    const rendered = renderSkillDocument(document);
    const reparsed = parseSkillDocument(rendered);
    expect(reparsed.manifest).toEqual(document.manifest);
    expect(reparsed.body).toBe(document.body);
  });

  it("rejects malformed manifests and missing fixed sections", () => {
    expect(() => parseSkillDocument(SKILL.replace("name: weekly-review", "name: Weekly Review")))
      .toThrowError(expect.objectContaining({ code: "SKILL_NAME_INVALID" }));
    expect(() => parseSkillDocument(SKILL.replace("## Verification", "## Done")))
      .toThrowError(expect.objectContaining({ code: "SKILL_SECTION_MISSING" }));
    expect(() => parseSkillDocument("no frontmatter"))
      .toThrowError(SkillPackageError);
  });

  it("only indexes adopted skills and clips descriptions to sixty characters", () => {
    const document = parseSkillDocument(SKILL);
    const longDocument = parseSkillDocument(SKILL.replace(
      "description: Summarize the week and flag unfinished commitments.",
      "description: This description is deliberately much longer than sixty characters so that the index remains compact and useful."
    ));
    expect(clipSkillDescription(longDocument.manifest.description)).toHaveLength(60);

    const index = buildDailySkillIndex([
      { document, status: "adopted", pinned: false },
      { document: longDocument, status: "adopted", pinned: true, id: "long-review" },
      { document, status: "stale", id: "stale-review" }
    ]);
    expect(index).toHaveLength(2);
    expect(index[0]).toMatchObject({ id: "long-review", pinned: true });
    expect(index[0]?.description).toHaveLength(60);
    expect(index[0]?.tags).toContain("productivity");
  });

  it("separates the index, full document, and resource layers", () => {
    const document = parseSkillDocument(SKILL);
    expect(buildFullSkillDocument(document).body).toContain("## Procedure");

    const resources = buildSkillResourceList([
      { path: "templates/review.md", kind: classifySkillResource("templates/review.md"), bytes: 20 },
      { path: "references/notes.md", kind: classifySkillResource("references/notes.md"), bytes: 10 },
      { path: "scripts/collect.ts", kind: classifySkillResource("scripts/collect.ts"), bytes: 30 }
    ]);
    expect(resources.map((item) => item.path)).toEqual([
      "references/notes.md",
      "scripts/collect.ts",
      "templates/review.md"
    ]);
  });
});
