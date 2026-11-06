import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HearthStore } from "@hearth/eventlog";
import { buildServer } from "./app.ts";
import { SecretBox } from "./secrets.ts";
import { HearthService } from "./service.ts";

describe("sync API", () => {
  let store: HearthStore;
  let service: HearthService;

  beforeEach(() => {
    store = new HearthStore(":memory:");
    service = new HearthService(store);
  });

  afterEach(() => store.close());

  it("registers a peer and requires its bearer token for event export", async () => {
    const app = await buildServer({ store, serveWeb: false, syncSecretBox: new SecretBox(Buffer.alloc(32, 9)) });
    const created = await app.inject({
      method: "POST",
      url: "/api/sync/peers",
      payload: { name: "second device", baseUrl: "http://127.0.0.1:4318" }
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().token.length).toBeGreaterThanOrEqual(32);
    expect(created.json().peer.tokenHash).toBeUndefined();

    service.createTask({ title: "可同步任务", goal: "只读副本" });
    const unauthorized = await app.inject({ method: "GET", url: "/api/sync/events" });
    expect(unauthorized.statusCode).toBe(401);

    const exported = await app.inject({
      method: "GET",
      url: "/api/sync/events?after=0&limit=50",
      headers: { authorization: "Bearer " + created.json().token }
    });
    expect(exported.statusCode).toBe(200);
    expect(exported.json().instanceId).toBe(store.instanceId);
    expect(exported.json().events.length).toBeGreaterThan(0);

    const revoked = await app.inject({ method: "POST", url: "/api/sync/peers/" + created.json().peer.id + "/revoke" });
    expect(revoked.statusCode).toBe(200);
    const rejected = await app.inject({
      method: "GET",
      url: "/api/sync/events?after=0&limit=50",
      headers: { authorization: "Bearer " + created.json().token }
    });
    expect(rejected.statusCode).toBe(401);
    await app.close();
  });

  it("rotates peer tokens without exposing old credentials", async () => {
    const app = await buildServer({ store, serveWeb: false, syncSecretBox: new SecretBox(Buffer.alloc(32, 11)) });
    const created = await app.inject({
      method: "POST",
      url: "/api/sync/peers",
      payload: { name: "rotate", baseUrl: "http://127.0.0.1:4318" }
    });
    const rotated = await app.inject({ method: "POST", url: "/api/sync/peers/" + created.json().peer.id + "/rotate" });
    expect(rotated.statusCode).toBe(200);
    expect(rotated.json().token).not.toBe(created.json().token);

    const oldToken = await app.inject({
      method: "GET",
      url: "/api/sync/events",
      headers: { authorization: "Bearer " + created.json().token }
    });
    expect(oldToken.statusCode).toBe(401);
    const newToken = await app.inject({
      method: "GET",
      url: "/api/sync/events",
      headers: { authorization: "Bearer " + rotated.json().token }
    });
    expect(newToken.statusCode).toBe(200);
    await app.close();
  });
});
