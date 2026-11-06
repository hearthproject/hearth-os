import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HearthStore } from "@hearth/eventlog";
import { buildServer } from "./app.ts";

describe("security API", () => {
  let store: HearthStore;
  let outboxRoot: string;

  beforeEach(() => {
    store = new HearthStore(":memory:");
    outboxRoot = mkdtempSync(join(tmpdir(), "hearth-security-"));
  });

  afterEach(() => {
    store.close();
    rmSync(outboxRoot, { recursive: true, force: true });
  });

  it("blocks approvals and scheduler restart until the kill switch is cleared", async () => {
    const app = await buildServer({ store, serveWeb: false, startScheduler: true, outboxRoot });
    try {
      const enabled = await app.inject({
        method: "POST",
        url: "/api/security/kill-switch",
        payload: { enabled: true, reason: "设备丢失演练" }
      });
      expect(enabled.statusCode).toBe(200);
      expect(enabled.json().state).toMatchObject({ killSwitch: true, reason: "设备丢失演练" });

      const draft = (await app.inject({
        method: "POST",
        url: "/api/outbox",
        payload: { account: "local-test", to: ["reviewer@example.test"], subject: "Blocked", body: "No side effect." }
      })).json();
      const approval = (await app.inject({ method: "POST", url: `/api/outbox/${draft.id}/submit` })).json().approval;
      const blocked = await app.inject({
        method: "POST",
        url: `/api/approvals/${approval.id}/decide`,
        payload: { decision: "approve", parameterHash: approval.parameterHash }
      });
      expect(blocked.statusCode).toBe(423);
      expect(blocked.json().error).toBe("KILL_SWITCH_ACTIVE");

      const restart = await app.inject({ method: "POST", url: "/api/system/start" });
      expect(restart.statusCode).toBe(423);

      const disabled = await app.inject({
        method: "POST",
        url: "/api/security/kill-switch",
        payload: { enabled: false }
      });
      expect(disabled.statusCode).toBe(200);
      expect(disabled.json().state.killSwitch).toBe(false);

      const approved = await app.inject({
        method: "POST",
        url: `/api/approvals/${approval.id}/decide`,
        payload: { decision: "approve", parameterHash: approval.parameterHash }
      });
      expect(approved.statusCode).toBe(200);
      expect(approved.json().effect.status).toBe("succeeded");

      const snapshot = await app.inject({ method: "GET", url: "/api/security" });
      expect(snapshot.json().audits.map((audit: { action: string }) => audit.action)).toEqual(
        expect.arrayContaining(["security.kill-switch.enabled", "security.kill-switch.disabled"])
      );
    } finally {
      await app.close();
    }
  });
});
