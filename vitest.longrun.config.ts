import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["e2e/longrun/**/*.test.ts"],
    environment: "node",
    testTimeout: 300_000,
    hookTimeout: 300_000,
    fileParallelism: false
  }
});
