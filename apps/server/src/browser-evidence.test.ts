import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserEvidenceStore } from "./browser-evidence.ts";

function fakePage(dir: string) {
  return {
    url: () => "https://example.com/form",
    title: vi.fn(async () => "表单"),
    screenshot: vi.fn(async ({ path }: { path: string }) => writeFileSync(path, "png"))
  } as never;
}

describe("BrowserEvidenceStore", () => {
  it("keeps before and after screenshots for a mutating action", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hearth-browser-evidence-"));
    try {
      const store = new BrowserEvidenceStore(dir);
      const record = await store.capture({
        taskId: "task/../x",
        runId: "run-1",
        kind: "click",
        page: fakePage(dir),
        pageDigest: "abc123",
        actionDigest: "def456",
        action: async () => "ok"
      });
      expect(record.screenshotBefore).toMatch(/-before\.png$/);
      expect(record.screenshotAfter).toMatch(/-after\.png$/);
      expect(store.filePath("task/../x", record.screenshotBefore!)).toBeTruthy();
      expect(store.list("task/../x")[0]?.kind).toBe("click");
      expect(store.filePath("task/../x", "../../etc/passwd")).toBeNull();
      expect(existsSync(join(dir, "task_.._x", record.screenshotBefore!))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
