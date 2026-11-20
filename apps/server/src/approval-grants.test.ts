import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HearthStore } from "@hearth/eventlog";
import { ApprovalGrantRepository } from "./approval-grants.ts";
import { registerApprovalGrantRoutes } from "./approval-grant-routes.ts";

describe("approval grants", () => {
  let store: HearthStore;
  let grants: ApprovalGrantRepository;

  beforeEach(() => {
    store = new HearthStore(":memory:");
    grants = new ApprovalGrantRepository(store);
  });

  afterEach(() => store.close());

  it("creates one active grant per action and revokes it", async () => {
    const first = grants.create("external-write", "browser_submit");
    const duplicate = grants.create("external-write", "browser_submit");
    expect(duplicate.id).toBe(first.id);
    expect(grants.find("external-write", "browser_submit")?.id).toBe(first.id);

    const app = Fastify();
    registerApprovalGrantRoutes(app, grants);
    await app.ready();
    try {
      const listed = await app.inject({ method: "GET", url: "/api/approval-grants" });
      expect(listed.statusCode).toBe(200);
      expect(listed.json().grants).toMatchObject([{ id: first.id, action: "browser_submit" }]);

      const revoked = await app.inject({ method: "DELETE", url: `/api/approval-grants/${first.id}` });
      expect(revoked.statusCode).toBe(200);
      expect(grants.find("external-write", "browser_submit")).toBeNull();
      expect(grants.list(true)[0]?.revokedAt).toBeTruthy();

      const missing = await app.inject({ method: "DELETE", url: `/api/approval-grants/${first.id}` });
      expect(missing.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("keeps grants scoped to their exact action", () => {
    grants.create("external-write", "browser_submit", { host: "example.test" });
    expect(grants.find("external-write", "browser_submit")).toBeNull();
    expect(grants.find("external-write", "browser_submit", { host: "example.test" })).toBeTruthy();
  });
});
