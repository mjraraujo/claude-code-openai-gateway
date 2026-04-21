/**
 * Outbound Kanban webhook.
 *
 * Pure helpers (`buildWebhookPayload`, `signPayload`) are independently
 * testable. `dispatchWebhook` performs the actual side-effecting POST
 * with a 5s timeout and a single retry. Failures are logged and
 * swallowed — the webhook is best-effort and must never block or fail
 * the originating Kanban API request.
 */

import crypto from "node:crypto";

import type { Task, WebhookConfig } from "./store";

/** Header name used to publish the HMAC-SHA256 signature. */
export const SIGNATURE_HEADER = "X-Claude-Codex-Signature";

/** Per-attempt request timeout. */
export const WEBHOOK_TIMEOUT_MS = 5_000;

export type WebhookEvent =
  | "task.created"
  | "task.moved"
  | "task.updated"
  | "task.deleted";

export interface WebhookPayload {
  event: WebhookEvent;
  /** ISO-8601 timestamp at which the event was generated. */
  at: string;
  /** Task state before the change (omitted for `task.created`). */
  before: Task | null;
  /** Task state after the change (omitted for `task.deleted`). */
  after: Task | null;
}

/**
 * Build the JSON payload sent to the webhook. Pure function — no I/O,
 * no side effects, no clock unless `now` is passed. The shape is
 * intentionally minimal so consumers can map it to Linear / Jira /
 * Slack at their leisure.
 */
export function buildWebhookPayload(
  event: WebhookEvent,
  before: Task | null,
  after: Task | null,
  now: Date = new Date(),
): WebhookPayload {
  return {
    event,
    at: now.toISOString(),
    before: before ? structuredClone(before) : null,
    after: after ? structuredClone(after) : null,
  };
}

/**
 * Compute the `sha256=<hex>` signature value for a payload body using
 * the configured secret. Mirrors the GitHub / Linear convention so
 * receivers can reuse off-the-shelf middleware.
 */
export function signPayload(secret: string, body: string): string {
  const mac = crypto.createHmac("sha256", secret).update(body).digest("hex");
  return `sha256=${mac}`;
}

interface DispatchResult {
  ok: boolean;
  status?: number;
  error?: string;
}

/**
 * POST `payload` to `config.url`. Best-effort: caller does not need to
 * await; rejections are converted to a `{ ok:false, error }` result
 * and never thrown. One retry on network / 5xx errors.
 *
 * Skips the request entirely when the config is missing, disabled, or
 * has no URL — returns `{ ok:true }` so callers can treat "no
 * webhook" identically to "delivered successfully".
 */
export async function dispatchWebhook(
  config: WebhookConfig | null,
  payload: WebhookPayload,
): Promise<DispatchResult> {
  if (!config || !config.enabled || !config.url) return { ok: true };
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "claude-codex-webhook/1",
  };
  if (config.secret) {
    headers[SIGNATURE_HEADER] = signPayload(config.secret, body);
  }

  let lastError: string | undefined;
  let lastStatus: number | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), WEBHOOK_TIMEOUT_MS);
    try {
      const res = await fetch(config.url, {
        method: "POST",
        headers,
        body,
        signal: ctrl.signal,
      });
      lastStatus = res.status;
      // Drain the body so the connection can be reused / closed cleanly.
      try {
        await res.text();
      } catch {
        /* ignore */
      }
      if (res.status >= 200 && res.status < 300) {
        return { ok: true, status: res.status };
      }
      // Retry on 5xx / 429; give up on other 4xx (auth, validation).
      if (res.status < 500 && res.status !== 429) {
        return { ok: false, status: res.status, error: `http ${res.status}` };
      }
      lastError = `http ${res.status}`;
    } catch (err) {
      lastError = (err as Error).message || "network error";
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, status: lastStatus, error: lastError ?? "delivery failed" };
}
