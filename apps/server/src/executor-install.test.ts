import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HearthStore } from "@hearth/eventlog";
import { buildServer } from "./app.ts";
import { ExecutorInstallError, ExecutorInstaller, type InstallRunnerInput } from "./executor-install.ts";

const roots: string[] = [];
const previousDetect = process.env.HEARTH_EXECUTOR_DETECT;

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "hearth-install-"));
  roots.push(root);
  return root;
}

beforeEach(() => {
  process.env.HEARTH_EXECUTOR_DETECT = "off";
});

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
  if (previousDetect === undefined) delete process.env.HEARTH_EXECUTOR_DETECT;
  else process.env.HEARTH_EXECUTOR_DETECT = previousDetect;
});

async function waitForStatus(installer: ExecutorInstaller, id: "kimi", settingsPath: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (installer.status(id, settingsPath)?.status !== "running") return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("install job did not finish");
}

describe("executor installer", () => {
  it("runs the managed npm install and persists the result", async () => {
    const root = tempRoot();
    const settingsPath = join(root, "executor-settings.json");
    const calls: InstallRunnerInput[] = [];
    const installer = new ExecutorInstaller(async (input) => {
      calls.push(input);
      input.onOutput("fake npm output\n");
      return { code: 0, error: null };
    });

    const started = installer.start("kimi", settingsPath);
    expect(started.status).toBe("running");
    expect(started.packageSpec).toBe("@moonshot-ai/kimi-code@2.5.2");
    await waitForStatus(installer, "kimi", settingsPath);

    const finished = installer.status("kimi", settingsPath);
    expect(finished?.status).toBe("succeeded");
    expect(finished?.log).toContain("fake npm output");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual(expect.arrayContaining([
      "install",
      "--prefix",
      join(root, "executors", "kimi"),
      "@moonshot-ai/kimi-code@2.5.2"
    ]));

    const reloaded = new ExecutorInstaller();
    expect(reloaded.status("kimi", settingsPath)?.status).toBe("succeeded");
  });

  it("rejects unsupported executors", () => {
    const installer = new ExecutorInstaller(async () => ({ code: 0, error: null }));
    expect(() => installer.start("native", join(tempRoot(), "executor-settings.json")))
      .toThrow(ExecutorInstallError);
  });

  it("exposes install jobs over the API", async () => {
    const root = tempRoot();
    const installer = new ExecutorInstaller(async (input) => {
      input.onOutput("done\n");
      return { code: 0, error: null };
    });
    const store = new HearthStore(":memory:");
    const app = await buildServer({
      store,
      serveWeb: false,
      modelSettingsPath: join(root, "settings.json"),
      attachmentRoot: join(root, "files"),
      executorSettingsPath: join(root, "executor-settings.json"),
      executorInstaller: installer
    });

    const listed = await app.inject({ method: "GET", url: "/api/executors" });
    const workbuddy = listed.json().executors.find((executor: { id: string }) => executor.id === "workbuddy");
    expect(workbuddy.install.supported).toBe(true);
    expect(workbuddy.install.packageSpec).toBe("@tencent-ai/codebuddy-code@2.181.0");

    const unsupported = await app.inject({ method: "POST", url: "/api/executors/native/install" });
    expect(unsupported.statusCode).toBe(400);
    expect(unsupported.json().error).toBe("INSTALL_UNSUPPORTED");

    const started = await app.inject({ method: "POST", url: "/api/executors/kimi/install" });
    expect(started.statusCode).toBe(202);
    expect(started.json().job.status).toBe("running");
    await waitForStatus(installer, "kimi", join(root, "executor-settings.json"));

    const status = await app.inject({ method: "GET", url: "/api/executors/kimi/install" });
    expect(status.json().job.status).toBe("succeeded");
    await app.close();
    store.close();
  }, 30_000);
});
