import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, errorMessageFromBody, fetchJson } from "./fetchJson";

describe("errorMessageFromBody", () => {
  it("returns the string itself when the body is a non-empty string", () => {
    expect(errorMessageFromBody("boom")).toBe("boom");
  });

  it("prefers `error` over `message`", () => {
    expect(errorMessageFromBody({ error: "e", message: "m" })).toBe("e");
  });

  it("falls back to `message` when `error` is missing", () => {
    expect(errorMessageFromBody({ message: "m" })).toBe("m");
  });

  it("returns null for empty / unrecognised shapes", () => {
    expect(errorMessageFromBody(null)).toBeNull();
    expect(errorMessageFromBody("")).toBeNull();
    expect(errorMessageFromBody({})).toBeNull();
    expect(errorMessageFromBody({ error: "" })).toBeNull();
    expect(errorMessageFromBody(42)).toBeNull();
  });
});

describe("fetchJson", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    // Each test installs its own mock — don't accidentally leak the
    // real fetch into the suite.
    (globalThis as unknown as { fetch: unknown }).fetch = undefined;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockFetch(impl: (url: string, init: RequestInit) => Response | Promise<Response>) {
    const fn = vi.fn(async (url: string, init: RequestInit) => impl(url, init));
    (globalThis as unknown as { fetch: typeof fn }).fetch = fn;
    return fn;
  }

  it("parses a 200 JSON body", async () => {
    mockFetch(() => new Response(JSON.stringify({ ok: true, n: 1 }), { status: 200 }));
    const out = await fetchJson<{ ok: boolean; n: number }>("/x");
    expect(out).toEqual({ ok: true, n: 1 });
  });

  it("returns null for an empty body (e.g. DELETE)", async () => {
    // 204 cannot be used with the undici Response constructor in node;
    // 200 + empty body exercises the same parse-empty branch.
    mockFetch(() => new Response("", { status: 200 }));
    const out = await fetchJson("/x", { method: "DELETE" });
    expect(out).toBeNull();
  });

  it("sends body as JSON with the right header + method", async () => {
    const fn = mockFetch(() => new Response("{}", { status: 200 }));
    await fetchJson("/x", { method: "POST", body: { a: 1 } });
    expect(fn).toHaveBeenCalledTimes(1);
    const init = fn.mock.calls[0][1];
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ a: 1 }));
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("does NOT add a Content-Type header when no body is sent", async () => {
    const fn = mockFetch(() => new Response("{}", { status: 200 }));
    await fetchJson("/x", { headers: { "X-Custom": "1" } });
    const init = fn.mock.calls[0][1];
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBeUndefined();
    expect(headers["X-Custom"]).toBe("1");
  });

  it("throws ApiError with surfaced server `error` on non-2xx", async () => {
    mockFetch(
      () => new Response(JSON.stringify({ error: "missing_goal" }), { status: 400 }),
    );
    await expect(fetchJson("/x", { method: "POST" })).rejects.toMatchObject({
      name: "ApiError",
      status: 400,
      message: "missing_goal",
    });
  });

  it("throws ApiError with synthetic message when body has no error field", async () => {
    mockFetch(() => new Response("{}", { status: 500 }));
    const err = await fetchJson("/x").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(500);
    expect((err as ApiError).message).toBe("request failed (500)");
  });

  it("preserves a non-JSON error body in the thrown error", async () => {
    mockFetch(() => new Response("plain text crash", { status: 502 }));
    const err = (await fetchJson("/x").catch((e) => e)) as ApiError;
    expect(err.status).toBe(502);
    expect(err.message).toBe("plain text crash");
    expect(err.body).toBe("plain text crash");
  });

  it("forwards the abort signal", async () => {
    const fn = mockFetch(() => new Response("{}", { status: 200 }));
    const ctrl = new AbortController();
    await fetchJson("/x", { signal: ctrl.signal });
    expect(fn.mock.calls[0][1].signal).toBe(ctrl.signal);
  });
});
