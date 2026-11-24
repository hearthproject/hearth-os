import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HearthStore } from "@hearth/eventlog";
import { buildServer } from "./app.ts";
import { SecretBox } from "./secrets.ts";

let root = "";
let store: HearthStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hearth-im-"));
  store = new HearthStore(join(root, "hearth.sqlite"));
});

afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

describe("IM bridge settings", () => {
  it("starts disabled and never returns secrets", async () => {
    const app = await buildServer({
      store,
      serveWeb: false,
      dataDir: root,
      secretBox: new SecretBox(Buffer.alloc(32, 9)),
      modelSettingsPath: join(root, "settings.json"),
      attachmentRoot: join(root, "files"),
      executorSettingsPath: join(root, "executor-settings.json"),
      startMaintenance: false
    });
    const response = await app.inject({ method: "GET", url: "/api/integrations/im" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.settings.wechat).toMatchObject({ enabled: false, hasToken: false });
    expect(body.settings.qq).toMatchObject({ enabled: false, hasClientSecret: false });
    expect(body.status.wechat.state).toBe("disabled");
    expect(body.status.qq.state).toBe("disabled");
    await app.close();
  });

  it("refuses to enable without credentials and stores tokens encrypted", async () => {
    const app = await buildServer({
      store,
      serveWeb: false,
      dataDir: root,
      secretBox: new SecretBox(Buffer.alloc(32, 9)),
      modelSettingsPath: join(root, "settings.json"),
      attachmentRoot: join(root, "files"),
      executorSettingsPath: join(root, "executor-settings.json"),
      startMaintenance: false
    });
    const missing = await app.inject({
      method: "PUT",
      url: "/api/integrations/im/wechat",
      payload: { enabled: true }
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error).toBe("WECHAT_TOKEN_REQUIRED");

    const saved = await app.inject({
      method: "PUT",
      url: "/api/integrations/im/wechat",
      payload: { enabled: false, token: "wechat-token", baseUrl: "https://ilinkai.weixin.qq.com/" }
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().settings.wechat).toMatchObject({
      hasToken: true,
      enabled: false,
      baseUrl: "https://ilinkai.weixin.qq.com"
    });
    expect(JSON.stringify(saved.json())).not.toContain("wechat-token");

    const qq = await app.inject({
      method: "PUT",
      url: "/api/integrations/im/qq",
      payload: { enabled: false, appId: "1024", clientSecret: "qq-secret" }
    });
    expect(qq.statusCode).toBe(200);
    expect(qq.json().settings.qq).toMatchObject({ hasClientSecret: true, appId: "1024" });
    expect(JSON.stringify(qq.json())).not.toContain("qq-secret");
    await app.close();
  });
});
