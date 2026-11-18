import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_RESTARTS,
  RESTART_DELAYS_MS,
  buildServerLaunch,
  defaultServerPaths,
  portStatus,
  probePort,
  resolveDesktopRoot,
  restartDelay,
  waitForHealth
} from "./server-process";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe("desktop server launch", () => {
  const root = "D:\\App\\hearth-os";

  it("builds the development launch with Electron's Node mode and fixed port", () => {
    const launch = buildServerLaunch({
      mode: "dev",
      root,
      dataDir: join(root, ".hearth"),
      webDist: join(root, "apps", "web", "dist"),
      execPath: "C:\\Electron\\electron.exe"
    });

    expect(launch.command).toBe("C:\\Electron\\electron.exe");
    expect(launch.args[0]).toContain("tsx");
    expect(launch.args[1]).toContain("apps");
    expect(launch.env.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(launch.env.HEARTH_ROOT).toBe(root);
    expect(launch.env.HEARTH_DATA_DIR).toBe(join(root, ".hearth"));
    expect(launch.env.HEARTH_WEB_DIST).toBe(join(root, "apps", "web", "dist"));
    expect(launch.env.HEARTH_PORT).toBe("4317");
    expect(launch.env.HEARTH_DESKTOP).toBe("1");
    expect(launch.baseUrl).toBe("http://127.0.0.1:4317");
  });

  it("builds the production launch from resources/server", () => {
    const launch = buildServerLaunch({
      mode: "prod",
      root,
      dataDir: join(root, ".hearth"),
      webDist: join(root, "apps", "web", "dist"),
      execPath: "C:\\Hearth\\Hearth.exe",
      resourcesPath: "C:\\Hearth\\resources"
    });

    expect(launch.args).toEqual(["C:\\Hearth\\resources\\server\\server.mjs"]);
    expect(launch.env.HEARTH_PORT).toBe("4317");
  });

  it("rejects production mode without resourcesPath", () => {
    expect(() => buildServerLaunch({
      mode: "prod",
      root,
      dataDir: join(root, ".hearth"),
      webDist: join(root, "apps", "web", "dist")
    })).toThrow(/resourcesPath/);
  });

  it("resolves the desktop root from the compiled dist directory", () => {
    expect(resolveDesktopRoot("D:\\App\\hearth-os\\apps\\desktop\\dist")).toBe("D:\\App\\hearth-os");
  });

  it("returns the default data and web paths", () => {
    expect(defaultServerPaths(root)).toEqual({
      dataDir: join(root, ".hearth"),
      webDist: join(root, "apps", "web", "dist")
    });
  });

  it("waits for a healthy server", async () => {
    const server = createServer((request, response) => {
      if (request.url === "/api/health") {
        response.statusCode = 200;
        response.end("{}");
        return;
      }
      response.statusCode = 404;
      response.end();
    });
    servers.push(server);

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    await waitForHealth(`http://127.0.0.1:${address.port}`, 5_000);
  });

  it("reports a timeout when the server never responds", async () => {
    await expect(waitForHealth("http://127.0.0.1:1", 1_000)).rejects.toThrow(/没有就绪/);
  });

  it("uses a bounded restart backoff and then gives up", () => {
    expect(RESTART_DELAYS_MS).toHaveLength(MAX_RESTARTS);
    expect(restartDelay(0)).toBe(1_000);
    expect(restartDelay(4)).toBe(30_000);
    expect(restartDelay(5)).toBeNull();
  });

  it("detects a listening port and identifies a Hearth health response", async () => {
    let name = "Hearth";
    const server = createServer((request, response) => {
      if (request.url === "/api/health") {
        response.statusCode = 200;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ name }));
        return;
      }
      response.statusCode = 404;
      response.end();
    });
    servers.push(server);

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;

    expect(await probePort(address.port)).toBe(true);
    expect(await portStatus(`http://127.0.0.1:${address.port}`, address.port)).toBe("hearth");

    name = "OtherService";
    expect(await portStatus(`http://127.0.0.1:${address.port}`, address.port)).toBe("occupied");
  });

  it("treats a closed port as free", async () => {
    expect(await probePort(1)).toBe(false);
    expect(await portStatus("http://127.0.0.1:1", 1)).toBe("free");
  });
});
