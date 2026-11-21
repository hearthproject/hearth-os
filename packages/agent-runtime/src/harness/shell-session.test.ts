import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runShellSession } from "./shell-session.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hearth-shell-abort-"));
  tempDirs.push(dir);
  return dir;
}

describe("runShellSession abort", () => {
  it("kills the process tree when the runtime signal aborts", async () => {
    const root = tempDir();
    const marker = join(root, "late.txt");
    const controller = new AbortController();
    const command = `node -e "setTimeout(()=>require('fs').writeFileSync(process.argv[1],'late'),1500)" "${marker}"`;
    setTimeout(() => controller.abort(), 100);
    const result = await runShellSession({
      command,
      cwd: root,
      outDir: root,
      timeoutMs: 2_000,
      unsafeNoSandbox: true,
      signal: controller.signal
    });
    expect(result.aborted).toBe(true);
    expect(result.running).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 1_700));
    expect(() => rmSync(marker, { force: false })).toThrow();
  });
});
