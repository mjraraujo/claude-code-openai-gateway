/**
 * Tests for the outbound Kanban webhook helpers.
 *
 * The pure helpers (`buildWebhookPayload`, `signPayload`,
 * `normalizeWebhookUrl`, `normalizeWebhook`) are exercised
 * directly. `dispatchWebhook` is exercised against a stubbed
 * `globalThis.fetch` so we never make real HTTP calls.
 */

import crypto from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildWebhookPayload,
  dispatchWebhook,
  SIGNATURE_HEADER,
  signPayload,
} from "./webhook";
import {
  MAX_WEBHOOK_SECRET_LENGTH,
  MAX_WEBHOOK_URL_LENGTH,
  normalizeWebhook,
  normalizeWebhookUrl,
} from "./store";
import type { Task } from "./store";

const SAMPLE_TASK: Task = {
  id: "T-1",
  title: "ship the thing",
  column: "active",
  createdAt: 1_700_000_000_000,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildWebhookPayload", () => {
  it("includes event, ISO timestamp, before, after", () => {
    const at = new Date("2026-01-02T03:04:05.000Z");
    const p = buildWebhookPayload("task.moved", SAMPLE_TASK, {
      ...SAMPLE_TASK,
      column: "review",
    }, at);
    expect(p.event).toBe("task.moved");
    expect(p.at).toBe("2026-01-02T03:04:05.000Z");
    expect(p.before?.column).toBe("active");
    expect(p.after?.column).toBe("review");
  });

  it("clones inputs so later mutation cannot rewrite history", () => {
    const before = { ...SAMPLE_TASK };
    const p = buildWebhookPayload("task.updated", before, before);
    before.title = "MUTATED";
    expect(p.before?.title).toBe("ship the thing");
    expect(p.after?.title).toBe("ship the thing");
  });

  it("allows null before for create events and null after for delete", () => {
    const created = buildWebhookPayload("task.created", null, SAMPLE_TASK);
    expect(created.before).toBeNull();
    expect(created.after).not.toBeNull();
    const deleted = buildWebhookPayload("task.deleted", SAMPLE_TASK, null);
    expect(deleted.before).not.toBeNull();
    expect(deleted.after).toBeNull();
  });
});

describe("signPayload", () => {
  it("matches the canonical sha256 HMAC of the body", () => {
    const body = '{"hello":"world"}';
    const expected =
      "sha256=" +
      crypto.createHmac("sha256", "shh").update(body).digest("hex");
    expect(signPayload("shh", body)).toBe(expected);
  });

  it("changes when the secret changes", () => {
    const a = signPayload("a", "{}");
    const b = signPayload("b", "{}");
    expect(a).not.toBe(b);
    expect(a.startsWith("sha256=")).toBe(true);
  });
});

describe("normalizeWebhookUrl", () => {
  it("accepts http and https URLs", () => {
    expect(normalizeWebhookUrl("https://example.com/hooks")).toContain("example.com");
    expect(normalizeWebhookUrl("http://localhost:9999/x")).toContain("localhost");
  });

  it("rejects non-HTTP schemes", () => {
    expect(normalizeWebhookUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeWebhookUrl("file:///etc/passwd")).toBeNull();
    expect(normalizeWebhookUrl("ftp://example.com/")).toBeNull();
  });

  it("rejects malformed values", () => {
    expect(normalizeWebhookUrl("")).toBeNull();
    expect(normalizeWebhookUrl("not a url")).toBeNull();
    expect(normalizeWebhookUrl(undefined)).toBeNull();
    expect(normalizeWebhookUrl(123)).toBeNull();
  });

  it("enforces the URL length cap", () => {
    const tooLong = "https://example.com/" + "x".repeat(MAX_WEBHOOK_URL_LENGTH);
    expect(normalizeWebhookUrl(tooLong)).toBeNull();
  });
});

describe("normalizeWebhook", () => {
  it("returns null for missing or invalid input", () => {
    expect(normalizeWebhook(null)).toBeNull();
    expect(normalizeWebhook("nope")).toBeNull();
    expect(normalizeWebhook({ url: "ftp://x", enabled: true })).toBeNull();
  });

  it("keeps a valid config and coerces enabled to a boolean", () => {
    const cfg = normalizeWebhook({
      url: "https://example.com/hook",
      enabled: 1,
    });
    expect(cfg).not.toBeNull();
    expect(cfg?.enabled).toBe(false); // only `=== true` is enabled
    expect(cfg?.url).toContain("example.com");
  });

  it("preserves and caps an optional secret", () => {
    const cfg = normalizeWebhook({
      url: "https://example.com/hook",
      enabled: true,
      secret: "x".repeat(MAX_WEBHOOK_SECRET_LENGTH + 50),
    });
    expect(cfg?.enabled).toBe(true);
    expect(cfg?.secret?.length).toBe(MAX_WEBHOOK_SECRET_LENGTH);
  });

  it("omits the secret field when none provided", () => {
    const cfg = normalizeWebhook({
      url: "https://example.com/hook",
      enabled: true,
    });
    expect(cfg).not.toBeNull();
    expect(cfg?.secret).toBeUndefined();
  });
});

describe("dispatchWebhook", () => {
  it("noops when config is null / disabled / urlless", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("ok", { status: 200 }));
    expect(await dispatchWebhook(null, sample())).toEqual({ ok: true });
    expect(
      await dispatchWebhook(
        { url: "https://x.com/y", enabled: false },
        sample(),
      ),
    ).toEqual({ ok: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends the payload as JSON with the signature header when a secret is set", async () => {
    let capturedInit: RequestInit | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => {
      capturedInit = init as RequestInit;
      return Promise.resolve(new Response("", { status: 200 }));
    });
    const result = await dispatchWebhook(
      { url: "https://example.com/hook", secret: "topsecret", enabled: true },
      sample(),
    );
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    const body = capturedInit?.body as string;
    const expected = signPayload("topsecret", body);
    expect(headers[SIGNATURE_HEADER]).toBe(expected);
  });

  it("omits the signature header when no secret is configured", async () => {
    let capturedInit: RequestInit | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => {
      capturedInit = init as RequestInit;
      return Promise.resolve(new Response("", { status: 204 }));
    });
    await dispatchWebhook(
      { url: "https://example.com/hook", enabled: true },
      sample(),
    );
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers[SIGNATURE_HEADER]).toBeUndefined();
  });

  it("does NOT retry on non-retryable 4xx", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("nope", { status: 404 }));
    const result = await dispatchWebhook(
      { url: "https://example.com/hook", enabled: true },
      sample(),
    );
    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("retries once on 5xx and reports the final failure", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("err", { status: 500 }));
    const result = await dispatchWebhook(
      { url: "https://example.com/hook", enabled: true },
      sample(),
    );
    expect(result.ok).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("retries on 429 then succeeds", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("slow down", { status: 429 }))
      .mockResolvedValueOnce(new Response("", { status: 200 }));
    const result = await dispatchWebhook(
      { url: "https://example.com/hook", enabled: true },
      sample(),
    );
    expect(result.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("returns an error result instead of throwing when fetch rejects", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("boom"));
    const result = await dispatchWebhook(
      { url: "https://example.com/hook", enabled: true },
      sample(),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/boom/);
  });
});

function sample() {
  return buildWebhookPayload("task.updated", SAMPLE_TASK, SAMPLE_TASK);
}
