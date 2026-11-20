import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentToolContext } from "../types.ts";
import { createAgentState } from "./file-state.ts";
import { rewindTurnTool, snapshotBeforeMutation } from "./snapshots.ts";

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
      expect(snapshotBeforeMutation(context, file)).toBe("snap_t1_1");

      state.turn = 2;
      const second = snapshotBeforeMutation(context, file);
      expect(second).toBe("snap_t2_2");
      writeFileSync(file, "three\n", "utf8");

      state.turn = 3;
      await rewindTurnTool.execute({ turn: 2 }, context);
      expect(readFileSync(file, "utf8")).toBe("two\n");
      await rewindTurnTool.execute({ turn: 1 }, context);
      expect(readFileSync(file, "utf8")).toBe("one\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
