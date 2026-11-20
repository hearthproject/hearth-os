import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentToolContext } from "../types.ts";
import { createAgentState } from "./file-state.ts";
import { recordCreatedFile, recordSnapshotAfterMutation, rewindTurnTool, snapshotBeforeMutation } from "./snapshots.ts";

describe("per-turn snapshots", () => {
  it("creates one snapshot per file per turn and rewinds a whole turn", async () => {
    const root = mkdtempSync(join(tmpdir(), "hearth-turn-history-"));
    try {
      const out = join(root, "out");
      mkdirSync(out, { recursive: true });
      const file = join(root, "note.md");
      writeFileSync(file, "one\n", "utf8");
      const state = createAgentState(root);
      const context: AgentToolContext = {
        workspaceRoot: root,
        outDir: out,
        state,
        permissions: { readRoots: [root], writeRoots: [root, out], networkHosts: [], tools: ["rewind_turn"] },
        signal: new AbortController().signal
      };

      state.turn = 1;
      const first = snapshotBeforeMutation(context, file);
      expect(first).toBe("snap_t1_1");
      writeFileSync(file, "two\n", "utf8");
      recordSnapshotAfterMutation(context, file, first!);
      expect(snapshotBeforeMutation(context, file)).toBe("snap_t1_1");
      const manifest = JSON.parse(readFileSync(join(out, ".hearth", "file-history", "turn-1", "manifest.json"), "utf8"));
      expect(manifest.files[0]).toMatchObject({ path: "note.md", beforeHash: expect.any(String), afterHash: expect.any(String), insertions: 1, deletions: 1 });

      state.turn = 2;
      const second = snapshotBeforeMutation(context, file);
      expect(second).toBe("snap_t2_2");
      writeFileSync(file, "three\n", "utf8");
      recordSnapshotAfterMutation(context, file, second!);

      state.turn = 3;
      const rewound = await rewindTurnTool.execute({ turn: 2 }, context);
      expect(readFileSync(file, "utf8")).toBe("two\n");
      expect(rewound.metadata?.insertions).toBe(1);
      await rewindTurnTool.execute({ turn: 1 }, context);
      expect(readFileSync(file, "utf8")).toBe("one\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("removes files created in a turn and reports partial failures", async () => {
    const root = mkdtempSync(join(tmpdir(), "hearth-turn-created-"));
    try {
      const out = join(root, "out");
      mkdirSync(out, { recursive: true });
      const existing = join(root, "existing.md");
      const created = join(root, "created.md");
      writeFileSync(existing, "one\n", "utf8");
      writeFileSync(created, "new\n", "utf8");
      const state = createAgentState(root);
      const context: AgentToolContext = {
        workspaceRoot: root,
        outDir: out,
        state,
        permissions: { readRoots: [root], writeRoots: [root, out], networkHosts: [], tools: ["rewind_turn"] },
        signal: new AbortController().signal
      };
      state.turn = 1;
      const snapshot = snapshotBeforeMutation(context, existing);
      writeFileSync(existing, "two\n", "utf8");
      recordSnapshotAfterMutation(context, existing, snapshot!);
      recordCreatedFile(context, created, true);
      rmSync(join(out, ".hearth", "snapshots", snapshot!, "existing.md"));

      const result = await rewindTurnTool.execute({ turn: 1 }, context);
      expect(readFileSync(existing, "utf8")).toBe("two\n");
      expect(result.content).toContain("失败 existing.md");
      expect(result.metadata?.failures).toEqual([{ path: "existing.md", reason: "快照文件缺失" }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps only the latest 100 turn manifests", async () => {
    const root = mkdtempSync(join(tmpdir(), "hearth-turn-prune-"));
    try {
      const out = join(root, "out");
      const history = join(out, ".hearth", "file-history");
      mkdirSync(history, { recursive: true });
      for (let turn = 1; turn <= 101; turn += 1) {
        mkdirSync(join(history, `turn-${turn}`), { recursive: true });
      }
      const file = join(root, "note.md");
      writeFileSync(file, "one\n", "utf8");
      const state = createAgentState(root);
      const context: AgentToolContext = {
        workspaceRoot: root,
        outDir: out,
        state,
        permissions: { readRoots: [root], writeRoots: [root, out], networkHosts: [], tools: [] },
        signal: new AbortController().signal
      };
      state.turn = 101;
      snapshotBeforeMutation(context, file);
      expect(readdirSync(history).filter((name) => /^turn-\d+$/.test(name))).toHaveLength(100);
      expect(existsSync(join(history, "turn-1"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
