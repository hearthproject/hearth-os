import { describe, expect, it } from "vitest";
import { redactProgressText, sanitizeProgressDetail } from "./progress-detail.ts";

describe("progress detail sanitization", () => {
  it("redacts common credentials from text and structured fields", () => {
    const text = redactProgressText("api_key=sk-abcdefghijklmnop Authorization: Bearer abcdefghijklmnop");
    expect(text).not.toContain("sk-abcdefghijklmnop");
    expect(text).not.toContain("Bearer abcdefghijklmnop");

    const detail = sanitizeProgressDetail({
      executorId: "codex",
      command: "tool --token ghp_abcdefghijklmnopqrstuvwxyz",
      input: { password: "super-secret", query: "safe" },
      output: "export API_KEY=my-secret-value"
    });
    expect(JSON.stringify(detail)).not.toContain("my-secret-value");
    expect(detail?.input).toMatchObject({ password: "[REDACTED]", query: "safe" });
  });

  it("truncates oversized detail payloads", () => {
    const detail = sanitizeProgressDetail({
      executorId: "codex",
      command: "c".repeat(20_000),
      output: "o".repeat(20_000),
      text: "t".repeat(20_000)
    });
    expect(detail?.truncated).toBe(true);
    expect(detail?.output?.length).toBeLessThan(5_000);
    expect(detail?.text?.length).toBeLessThan(5_000);
  });
});
