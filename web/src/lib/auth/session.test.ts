/**
 * Tests for shouldUseSecureCookie() — the single knob that decides
 * whether the Mission Control session cookie carries the `Secure`
 * attribute.
 *
 * Resolution order (highest precedence first):
 *   1. MISSION_CONTROL_FORCE_SECURE_COOKIES=1 → always Secure
 *   2. MISSION_CONTROL_INSECURE_COOKIES=1     → never Secure
 *   3. requestProto argument                  → Secure iff "https"
 *   4. NODE_ENV fallback                      → Secure iff production
 *
 * (3) is what makes the dashboard "just work" on a fresh VPS over
 * plain http://<vps-ip>:3000 *and* still set Secure when fronted by
 * Caddy/Nginx that adds `x-forwarded-proto: https`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { shouldUseSecureCookie } from "./session";

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_INSECURE = process.env.MISSION_CONTROL_INSECURE_COOKIES;
const ORIGINAL_FORCE = process.env.MISSION_CONTROL_FORCE_SECURE_COOKIES;

beforeEach(() => {
  delete process.env.MISSION_CONTROL_INSECURE_COOKIES;
  delete process.env.MISSION_CONTROL_FORCE_SECURE_COOKIES;
});

afterEach(() => {
  process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  if (ORIGINAL_INSECURE === undefined) {
    delete process.env.MISSION_CONTROL_INSECURE_COOKIES;
  } else {
    process.env.MISSION_CONTROL_INSECURE_COOKIES = ORIGINAL_INSECURE;
  }
  if (ORIGINAL_FORCE === undefined) {
    delete process.env.MISSION_CONTROL_FORCE_SECURE_COOKIES;
  } else {
    process.env.MISSION_CONTROL_FORCE_SECURE_COOKIES = ORIGINAL_FORCE;
  }
});

describe("shouldUseSecureCookie · request scheme auto-detection", () => {
  it("uses Secure for an https request even outside production", () => {
    process.env.NODE_ENV = "development";
    expect(shouldUseSecureCookie("https")).toBe(true);
  });

  it("does NOT use Secure for an http request even in production", () => {
    process.env.NODE_ENV = "production";
    expect(shouldUseSecureCookie("http")).toBe(false);
  });

  it("is case-insensitive on the proto value", () => {
    expect(shouldUseSecureCookie("HTTPS")).toBe(true);
    expect(shouldUseSecureCookie("HTTP")).toBe(false);
  });
});

describe("shouldUseSecureCookie · explicit overrides", () => {
  it("MISSION_CONTROL_FORCE_SECURE_COOKIES=1 wins over an http request", () => {
    process.env.MISSION_CONTROL_FORCE_SECURE_COOKIES = "1";
    expect(shouldUseSecureCookie("http")).toBe(true);
  });

  it("MISSION_CONTROL_INSECURE_COOKIES=1 wins over an https request", () => {
    process.env.MISSION_CONTROL_INSECURE_COOKIES = "1";
    expect(shouldUseSecureCookie("https")).toBe(false);
  });

  it("FORCE wins over INSECURE when both are set", () => {
    process.env.MISSION_CONTROL_FORCE_SECURE_COOKIES = "1";
    process.env.MISSION_CONTROL_INSECURE_COOKIES = "1";
    expect(shouldUseSecureCookie("http")).toBe(true);
  });

  it("ignores INSECURE values other than '1'", () => {
    process.env.NODE_ENV = "production";
    process.env.MISSION_CONTROL_INSECURE_COOKIES = "true";
    expect(shouldUseSecureCookie("https")).toBe(true);
  });
});

describe("shouldUseSecureCookie · fallback when scheme is unknown", () => {
  it("requires Secure in production", () => {
    process.env.NODE_ENV = "production";
    expect(shouldUseSecureCookie(undefined)).toBe(true);
  });

  it("does not require Secure outside production", () => {
    process.env.NODE_ENV = "development";
    expect(shouldUseSecureCookie(undefined)).toBe(false);
  });
});
