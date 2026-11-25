import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildCodexEnv, loadCodexProfile } from "./profile.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function homeWithConfig(): string {
  const dir = mkdtempSync(join(tmpdir(), "hearth-codex-profile-"));
  dirs.push(dir);
  writeFileSync(
    join(dir, "config.toml"),
    `model = "custom-model"\nmodel_provider = "custom"\n[model_providers.custom]\nname = "Custom"\nbase_url = "https://example.invalid/v1"\nenv_key = "CUSTOM_API_KEY"\nwire_api = "responses"\n`
  );
  return dir;
}

describe("Codex profile", () => {
  it("accepts a custom provider with an environment key", () => {
    const profile = loadCodexProfile({ codexHome: homeWithConfig(), env: { CUSTOM_API_KEY: "test" } });
    expect(profile.providerId).toBe("custom");
    expect(profile.authSource).toBe("provider-env");
    expect(profile.canRun).toBe(true);
  });

  it("injects the provider key into the Codex child process environment", () => {
    const previous = process.env.CUSTOM_API_KEY;
    process.env.CUSTOM_API_KEY = "from-process";
    try {
      const home = homeWithConfig();
      const profile = loadCodexProfile({ codexHome: home, env: {} });
      const env = buildCodexEnv(profile, { CUSTOM_API_KEY: "from-model-registry" });
      expect(env.CUSTOM_API_KEY).toBe("from-model-registry");
      expect(env.CODEX_HOME).toBe(home);
    } finally {
      if (previous === undefined) delete process.env.CUSTOM_API_KEY;
      else process.env.CUSTOM_API_KEY = previous;
    }
  });

  it("falls back to the explicitly selected provider key for a local profile", () => {
    const previous = process.env.CUSTOM_API_KEY;
    process.env.CUSTOM_API_KEY = "from-process";
    try {
      const home = homeWithConfig();
      const profile = loadCodexProfile({ codexHome: home, env: {} });
      const env = buildCodexEnv(profile);
      expect(env.CUSTOM_API_KEY).toBe("from-process");
      expect(env.CODEX_HOME).toBe(home);
    } finally {
      if (previous === undefined) delete process.env.CUSTOM_API_KEY;
      else process.env.CUSTOM_API_KEY = previous;
    }
  });

  it("does not leak unrelated host credentials into the Codex child environment", () => {
    const previousToken = process.env.UNRELATED_HOST_TOKEN;
    const previousPath = process.env.PATH;
    process.env.UNRELATED_HOST_TOKEN = "must-not-leak";
    try {
      const env = buildCodexEnv(
        loadCodexProfile({ codexHome: homeWithConfig(), env: { CUSTOM_API_KEY: "trusted" } }),
        {
          CUSTOM_API_KEY: "trusted",
          UNRELATED_API_KEY: "must-not-leak",
          PATH: "C:\\untrusted",
          TEMP: "C:\\untrusted-temp",
          NODE_OPTIONS: "--require=malicious"
        }
      );
      expect(env.UNRELATED_HOST_TOKEN).toBeUndefined();
      expect(env.UNRELATED_API_KEY).toBeUndefined();
      expect(env.CUSTOM_API_KEY).toBe("trusted");
      expect(env.PATH).toContain(previousPath ?? "");
      expect(env.PATH).not.toContain("C:\\untrusted");
      if (process.platform === "win32") expect(env.PATH).toContain(join(process.env.SystemRoot ?? "C:\\Windows", "System32"));
      expect(env.TEMP).not.toBe("C:\\untrusted-temp");
      expect(env.NODE_OPTIONS).toBeUndefined();
    } finally {
      if (previousToken === undefined) delete process.env.UNRELATED_HOST_TOKEN;
      else process.env.UNRELATED_HOST_TOKEN = previousToken;
    }
  });

  it("reports a missing provider key without falling back to OpenAI login", () => {
    const profile = loadCodexProfile({ codexHome: homeWithConfig(), env: {} });
    expect(profile.authSource).toBe("missing");
    expect(profile.canRun).toBe(false);
    expect(profile.issues.join(" ")).toContain("CUSTOM_API_KEY");
  });
});
