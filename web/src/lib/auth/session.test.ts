/**
 * Tests for shouldUseSecureCookie() — the single knob that decides
 * whether the Mission Control session cookie carries the `Secure`
 * attribute. The default protects production deployments; the
 * MISSION_CONTROL_INSECURE_COOKIES=1 escape hatch lets users test the
 * dashboard over plain http://<vps-ip>:3000 before wiring up TLS.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { shouldUseSecureCookie } from "./session";

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_INSECURE = process.env.MISSION_CONTROL_INSECURE_COOKIES;

beforeEach(() => {
  delete process.env.MISSION_CONTROL_INSECURE_COOKIES;
});

afterEach(() => {
  process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  if (ORIGINAL_INSECURE === undefined) {
    delete process.env.MISSION_CONTROL_INSECURE_COOKIES;
  } else {
    process.env.MISSION_CONTROL_INSECURE_COOKIES = ORIGINAL_INSECURE;
  }
});

describe("shouldUseSecureCookie", () => {
  it("requires Secure cookies in production by default", () => {
    process.env.NODE_ENV = "production";
    expect(shouldUseSecureCookie()).toBe(true);
  });

  it("does not require Secure cookies outside production", () => {
    process.env.NODE_ENV = "development";
    expect(shouldUseSecureCookie()).toBe(false);
  });

  it("honors MISSION_CONTROL_INSECURE_COOKIES=1 even in production", () => {
    process.env.NODE_ENV = "production";
    process.env.MISSION_CONTROL_INSECURE_COOKIES = "1";
    expect(shouldUseSecureCookie()).toBe(false);
  });

  it("ignores MISSION_CONTROL_INSECURE_COOKIES values other than '1'", () => {
    process.env.NODE_ENV = "production";
    process.env.MISSION_CONTROL_INSECURE_COOKIES = "true";
    expect(shouldUseSecureCookie()).toBe(true);
  });
});
