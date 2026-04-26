/**
 * Centralized JSON fetch helper for runtime mutation calls.
 *
 * Every panel's "POST/PATCH/DELETE → check ok → parse error → set
 * error banner" pattern was previously copy-pasted, leading to drift
 * (see Phase 1 diagnostic §4 "Network mutation patterns" and bug #2
 * "KanbanPanel.deleteCard does not assert res.ok"). Funneling those
 * calls through `fetchJson` removes the silent-failure class of bugs
 * by construction — a non-2xx response always throws an
 * `ApiError` with the server's `error` field surfaced.
 */
export class ApiError extends Error {
  /** Raw HTTP status code returned by the server. */
  readonly status: number;
  /** Best-effort body the server returned (for logging / surfacing). */
  readonly body: unknown;

  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

export interface FetchJsonOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  /** JSON body; will be stringified and sent with `Content-Type: application/json`. */
  body?: unknown;
  /** Standard fetch signal — pass an `AbortController.signal` to cancel. */
  signal?: AbortSignal;
  /** Extra headers merged on top of the JSON content-type. */
  headers?: Record<string, string>;
  /** Forwarded to `fetch`'s `cache` option (e.g. `"no-store"` for status polling). */
  cache?: RequestCache;
}

/**
 * Issue a JSON request and return the parsed response body, or throw
 * an `ApiError` on non-2xx. The server convention across the runtime
 * routes is to return `{ error: string }` on failures, so we surface
 * that as the thrown error's `message`.
 *
 * Returns `null` if the response is empty (DELETEs frequently are).
 */
export async function fetchJson<T = unknown>(
  url: string,
  options: FetchJsonOptions = {},
): Promise<T | null> {
  const { method = "GET", body, signal, headers = {}, cache } = options;

  const init: RequestInit = {
    method,
    signal,
    cache,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }

  const res = await fetch(url, init);

  // Try to parse the body as JSON regardless of status — we want both
  // the success payload AND the error payload to flow through the
  // same path. Empty bodies (common on DELETE) are treated as null.
  let parsed: unknown = null;
  const text = await res.text();
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      // Non-JSON body — keep the raw text so the error message is
      // still useful when the server proxies a non-JSON upstream.
      parsed = text;
    }
  }

  if (!res.ok) {
    const message = errorMessageFromBody(parsed) ?? `request failed (${res.status})`;
    throw new ApiError(res.status, message, parsed);
  }

  return parsed as T | null;
}

/**
 * Best-effort extract of an error string from a parsed body. Looks
 * for the standard `{ error: string }` and `{ message: string }`
 * conventions used across the runtime API routes.
 */
export function errorMessageFromBody(body: unknown): string | null {
  if (typeof body === "string" && body.length > 0) return body;
  if (!body || typeof body !== "object") return null;
  const obj = body as Record<string, unknown>;
  if (typeof obj.error === "string" && obj.error.length > 0) return obj.error;
  if (typeof obj.message === "string" && obj.message.length > 0) return obj.message;
  return null;
}
