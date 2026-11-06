import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HearthStore } from "@hearth/eventlog";
import { DesktopService } from "./desktop.ts";
import { HearthService } from "./service.ts";

const DEVICE_TOKEN = "d".repeat(43);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64");

describe("desktop device service", () => {
  let store: HearthStore;
  let service: HearthService;
  let desktop: DesktopService;
  let frameRoot: string;

  beforeEach(() => {
    store = new HearthStore(":memory:");
    service = new HearthService(store);
    frameRoot = mkdtempSync(join(tmpdir(), "hearth-frames-"));
    desktop = new DesktopService(service, frameRoot);
  });

  afterEach(() => {
    store.close();
    rmSync(frameRoot, { recursive: true, force: true });
  });

  function pairDevice() {
    const started = desktop.createPairingRequest({
      name: "Workstation",
      version: "1.0.0",
      deviceToken: DEVICE_TOKEN,
      apps: ["notepad"],
      capabilities: ["observe", "desktop.control", "ui.automation"]
    });
    const pairing = desktop.getPairingStatus(started.request.id, started.secret);
    expect(pairing.request.status).toBe("pending");
    const device = desktop.approvePairing(started.request.id);
    const redeemed = desktop.getPairingStatus(started.request.id, started.secret);
    expect(redeemed.request.status).toBe("redeemed");
    return { started, device, redeemed };
  }

  it("keeps pairing separate from capability approval and device tokens private", () => {
    const { started, device, redeemed } = pairDevice();
    expect(device.online).toBe(false);
    expect(device).not.toHaveProperty("tokenHash");
    expect(redeemed.device).not.toHaveProperty("tokenHash");
    expect(device.capabilities.map((capability) => capability.status)).toEqual(["pending", "pending", "pending"]);
    expect(desktop.authenticateDevice(DEVICE_TOKEN).status).toBe("online");
    expect(() => desktop.createSession(device.id)).toThrowError(expect.objectContaining({ code: "CAPABILITY_NOT_APPROVED" }));
    expect(() => desktop.getPairingStatus(started.request.id, "wrong-secret")).toThrowError(expect.objectContaining({ code: "PAIRING_SECRET_INVALID" }));
  });

  it("requires a fresh, allowlisted observation before a low-risk action", () => {
    const { device } = pairDevice();
    desktop.approveCapability(device.id, "observe", ["notepad"]);
    desktop.approveCapability(device.id, "desktop.control", ["notepad"]);
    desktop.authenticateDevice(DEVICE_TOKEN);
    const created = desktop.createSession(device.id);
    const observation = desktop.nextCommand(desktop.authenticateDevice(DEVICE_TOKEN));
    expect(observation).toMatchObject({ kind: "observe", status: "claimed" });
    expect(() => desktop.uploadObservation(desktop.authenticateDevice(DEVICE_TOKEN), {
      sessionId: created.session.id,
      commandId: observation!.id,
      jpegBase64: JPEG,
      width: 100,
      height: 100,
      activeApp: "chrome",
      windowTitle: "Blocked"
    })).toThrowError(expect.objectContaining({ code: "APP_NOT_ALLOWED" }));

    const frame = desktop.uploadObservation(desktop.authenticateDevice(DEVICE_TOKEN), {
      sessionId: created.session.id,
      commandId: observation!.id,
      jpegBase64: JPEG,
      width: 100,
      height: 100,
      activeApp: "notepad",
      windowTitle: "Draft - Notepad"
    });
    expect(desktop.sessionView(created.session.id).frame?.id).toBe(frame.id);
    expect(desktop.readFrame(device.id, frame.id).frame.sha256).toHaveLength(64);

    const action = desktop.enqueueAction(created.session.id, {
      kind: "click", frameId: frame.id, x: 0.5, y: 0.5
    });
    expect(action).toMatchObject({ kind: "click", status: "queued", frameId: frame.id, payload: { expectedApp: "notepad" } });
    const claimed = desktop.nextCommand(desktop.authenticateDevice(DEVICE_TOKEN));
    expect(claimed?.kind).toBe("click");
    desktop.completeCommand(desktop.authenticateDevice(DEVICE_TOKEN), action.id, { status: "succeeded" });
    expect(() => desktop.enqueueAction(created.session.id, {
      kind: "type", frameId: frame.id, text: "stale"
    })).toThrowError(expect.objectContaining({ code: "FRAME_STALE" }));
  });

  it("cancels queued input on pause and takeover, then requires a new observation", () => {
    const { device } = pairDevice();
    desktop.approveCapability(device.id, "observe", ["notepad"]);
    desktop.approveCapability(device.id, "desktop.control", ["notepad"]);
    desktop.authenticateDevice(DEVICE_TOKEN);
    const created = desktop.createSession(device.id);
    const initialObservation = desktop.nextCommand(desktop.authenticateDevice(DEVICE_TOKEN));
    const frame = desktop.uploadObservation(desktop.authenticateDevice(DEVICE_TOKEN), {
      sessionId: created.session.id, commandId: initialObservation!.id, jpegBase64: JPEG, width: 100, height: 100,
      activeApp: "notepad", windowTitle: "Draft - Notepad"
    });

    desktop.enqueueAction(created.session.id, { kind: "press", frameId: frame.id, keys: "Ctrl+S" });
    desktop.pauseSession(created.session.id);
    expect(desktop.nextCommand(desktop.authenticateDevice(DEVICE_TOKEN))).toBeNull();
    expect(desktop.sessionView(created.session.id).commands.some((command) => command.status === "cancelled")).toBe(true);

    desktop.resumeSession(created.session.id);
    const resumedObservation = desktop.nextCommand(desktop.authenticateDevice(DEVICE_TOKEN));
    expect(resumedObservation?.kind).toBe("observe");
    const resumedFrame = desktop.uploadObservation(desktop.authenticateDevice(DEVICE_TOKEN), {
      sessionId: created.session.id, commandId: resumedObservation!.id, jpegBase64: JPEG,
      width: 100, height: 100, activeApp: "notepad", windowTitle: "Draft - Notepad"
    });
    desktop.enqueueAction(created.session.id, { kind: "click", frameId: resumedFrame.id, x: 0.25, y: 0.25 });
    desktop.nextCommand(desktop.authenticateDevice(DEVICE_TOKEN));
    desktop.takeOverSession(created.session.id);
    expect(desktop.sessionView(created.session.id).session.status).toBe("taken_over");
    expect(desktop.nextCommand(desktop.authenticateDevice(DEVICE_TOKEN))).toBeNull();

    const released = desktop.releaseSession(created.session.id);
    expect(released.session.status).toBe("active");
    expect(released.session.currentFrameId).toBeNull();
    expect(released.commands.some((command) => command.kind === "observe" && command.status === "queued")).toBe(true);
  });

  it("revoking a device invalidates its token and terminates active sessions", () => {
    const { device } = pairDevice();
    desktop.approveCapability(device.id, "observe", ["notepad"]);
    desktop.authenticateDevice(DEVICE_TOKEN);
    const created = desktop.createSession(device.id);
    desktop.revokeDevice(device.id);
    expect(() => desktop.authenticateDevice(DEVICE_TOKEN)).toThrowError(expect.objectContaining({ code: "DEVICE_UNAUTHORIZED" }));
    expect(desktop.sessionView(created.session.id).session.status).toBe("terminated");
  });
});
