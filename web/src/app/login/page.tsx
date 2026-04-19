"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface DeviceCode {
  device_auth_id: string;
  user_code: string;
  verification_uri: string;
  interval_seconds: number;
}

type Phase = "idle" | "starting" | "awaiting_user" | "completing" | "error";

export default function LoginPage() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [device, setDevice] = useState<DeviceCode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  const startLogin = useCallback(async () => {
    setError(null);
    setDevice(null);
    setPhase("starting");
    try {
      const res = await fetch("/api/auth/login/start", { method: "POST" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          message?: string;
        };
        throw new Error(body.message || `Failed (${res.status})`);
      }
      const data = (await res.json()) as DeviceCode;
      setDevice(data);
      setPhase("awaiting_user");

      stopPolling();
      const intervalMs = Math.max(2, data.interval_seconds) * 1000;
      pollRef.current = setInterval(async () => {
        try {
          const pollRes = await fetch("/api/auth/login/poll", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              device_auth_id: data.device_auth_id,
              user_code: data.user_code,
            }),
          });
          if (!pollRes.ok) {
            const body = (await pollRes.json().catch(() => ({}))) as {
              message?: string;
            };
            throw new Error(body.message || `Poll failed (${pollRes.status})`);
          }
          const pollData = (await pollRes.json()) as { status: string };
          if (pollData.status === "complete") {
            stopPolling();
            setPhase("completing");
            window.location.href = "/";
          }
        } catch (err) {
          stopPolling();
          setError(err instanceof Error ? err.message : "Poll failed");
          setPhase("error");
        }
      }, intervalMs);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
      setPhase("error");
    }
  }, [stopPolling]);

  const copyCode = useCallback(async () => {
    if (!device?.user_code) return;
    try {
      await navigator.clipboard.writeText(device.user_code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  }, [device]);

  return (
    <main className="flex flex-1 items-center justify-center bg-black px-6 py-16 text-zinc-100">
      <div className="w-full max-w-md">
        <div className="mb-10 flex items-center gap-3">
          <div
            aria-hidden
            className="h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_12px_rgba(52,211,153,0.7)]"
          />
          <span className="font-mono text-xs uppercase tracking-[0.2em] text-zinc-500">
            mission control
          </span>
        </div>

        <h1 className="text-3xl font-semibold tracking-tight">Sign in</h1>
        <p className="mt-3 text-sm leading-6 text-zinc-400">
          Authenticate the local Claude Code gateway with your ChatGPT account.
          We use OpenAI&apos;s device-code flow — the same one as the official
          Codex CLI.
        </p>

        <div className="mt-10 rounded-lg border border-zinc-800 bg-zinc-950/60 p-6">
          {phase === "idle" && (
            <button
              type="button"
              onClick={startLogin}
              className="w-full rounded-md bg-zinc-50 px-4 py-2.5 text-sm font-medium text-black transition hover:bg-white"
            >
              Begin secure sign-in
            </button>
          )}

          {phase === "starting" && (
            <p className="text-sm text-zinc-400">Requesting device code…</p>
          )}

          {(phase === "awaiting_user" || phase === "completing") && device && (
            <div className="space-y-5">
              <div>
                <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-500">
                  step 1 — open
                </p>
                <a
                  href={device.verification_uri}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-1 inline-block text-sm text-emerald-400 underline-offset-4 hover:underline"
                >
                  {device.verification_uri}
                </a>
              </div>

              <div>
                <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-500">
                  step 2 — enter this code
                </p>
                <button
                  type="button"
                  onClick={copyCode}
                  className="mt-2 flex w-full items-center justify-between rounded-md border border-zinc-800 bg-black px-4 py-3 text-left font-mono text-xl tracking-[0.4em] text-zinc-50 transition hover:border-zinc-700"
                >
                  <span>{device.user_code}</span>
                  <span className="font-sans text-xs text-zinc-500">
                    {copied ? "copied" : "click to copy"}
                  </span>
                </button>
              </div>

              <div className="flex items-center gap-2 pt-2 text-xs text-zinc-500">
                <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
                {phase === "completing"
                  ? "Authenticated — opening Mission Control…"
                  : "Waiting for browser sign-in…"}
              </div>
            </div>
          )}

          {phase === "error" && (
            <div className="space-y-4">
              <p className="text-sm text-red-400">
                {error ?? "Something went wrong."}
              </p>
              <button
                type="button"
                onClick={startLogin}
                className="w-full rounded-md border border-zinc-800 px-4 py-2.5 text-sm font-medium text-zinc-100 transition hover:border-zinc-700"
              >
                Try again
              </button>
            </div>
          )}
        </div>

        <p className="mt-6 text-xs leading-5 text-zinc-500">
          Tokens are stored locally in{" "}
          <code className="font-mono text-zinc-400">
            ~/.codex-gateway/token.json
          </code>
          . The same file is shared with the CLI gateway, so signing in here
          authorizes both.
        </p>
      </div>
    </main>
  );
}
