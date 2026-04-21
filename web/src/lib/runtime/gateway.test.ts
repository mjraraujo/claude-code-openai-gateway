/**
 * Tests for the gateway-port discovery helper used by the dashboard
 * to locate `bin/gateway.js` when it has fallen back from the default
 * port. Mirrors the temp-dir / `vi.resetModules()` pattern used by
 * `store.test.ts` — we want a fresh module instance per case so the
 * in-memory port cache doesn't leak between tests.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mc-gateway-test-"));
  process.env.CODEX_GATEWAY_CONFIG_DIR = tmpDir;
  delete process.env.CLAUDE_CODEX_GATEWAY_URL;
  delete process.env.MISSION_CONTROL_GATEWAY_URL;
  vi.resetModules();
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
  delete process.env.CODEX_GATEWAY_CONFIG_DIR;
  delete process.env.CLAUDE_CODEX_GATEWAY_URL;
  delete process.env.MISSION_CONTROL_GATEWAY_URL;
});

async function importGateway() {
  return await import("./gateway");
}

async function writePortFile(port: string) {
  await fs.mkdir(path.join(tmpDir, ".codex-gateway"), { recursive: true });
  await fs.writeFile(path.join(tmpDir, ".codex-gateway", "port"), port);
}

describe("runtime/gateway · getGatewayPort", () => {
  it("returns the default 18923 when no port file exists", async () => {
    const { getGatewayPort, DEFAULT_GATEWAY_PORT } = await importGateway();
    expect(getGatewayPort()).toBe(DEFAULT_GATEWAY_PORT);
    expect(DEFAULT_GATEWAY_PORT).toBe(18923);
  });

  it("reads the port file when present", async () => {
    await writePortFile("18927\n");
    const { getGatewayPort } = await importGateway();
    expect(getGatewayPort()).toBe(18927);
  });

  it("falls back to the default for malformed contents", async () => {
    await writePortFile("not-a-number");
    const { getGatewayPort, DEFAULT_GATEWAY_PORT } = await importGateway();
    expect(getGatewayPort()).toBe(DEFAULT_GATEWAY_PORT);
  });

  it("rejects out-of-range values", async () => {
    await writePortFile("70000");
    const { getGatewayPort, DEFAULT_GATEWAY_PORT } = await importGateway();
    expect(getGatewayPort()).toBe(DEFAULT_GATEWAY_PORT);
  });

  it("rejects zero / negative ports", async () => {
    await writePortFile("0");
    const { getGatewayPort, DEFAULT_GATEWAY_PORT } = await importGateway();
    expect(getGatewayPort()).toBe(DEFAULT_GATEWAY_PORT);
  });

  it("caches reads but honours an explicit reset", async () => {
    await writePortFile("18925");
    const mod = await importGateway();
    expect(mod.getGatewayPort()).toBe(18925);

    // Subsequent disk change shouldn't be observed until the cache
    // expires or is reset, so the helper is cheap on the hot path.
    await writePortFile("18930");
    expect(mod.getGatewayPort()).toBe(18925);

    mod._resetGatewayPortCacheForTests();
    expect(mod.getGatewayPort()).toBe(18930);
  });
});

describe("runtime/gateway · getGatewayUrl", () => {
  it("constructs the messages URL from the discovered port", async () => {
    await writePortFile("18928");
    const { getGatewayUrl } = await importGateway();
    expect(getGatewayUrl()).toBe("http://127.0.0.1:18928/v1/messages");
  });

  it("honours CLAUDE_CODEX_GATEWAY_URL over the port file", async () => {
    await writePortFile("18928");
    process.env.CLAUDE_CODEX_GATEWAY_URL = "http://example.test/v1/messages";
    const { getGatewayUrl } = await importGateway();
    expect(getGatewayUrl()).toBe("http://example.test/v1/messages");
  });

  it("honours the legacy MISSION_CONTROL_GATEWAY_URL alias", async () => {
    process.env.MISSION_CONTROL_GATEWAY_URL = "http://legacy.test/v1/messages";
    const { getGatewayUrl } = await importGateway();
    expect(getGatewayUrl()).toBe("http://legacy.test/v1/messages");
  });
});
