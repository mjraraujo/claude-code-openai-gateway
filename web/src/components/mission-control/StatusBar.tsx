"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { RuntimeState } from "@/lib/runtime";

interface StatusResponse {
  authenticated: boolean;
  token_valid: boolean;
  token_expires_at: number | null;
}

interface DeviceCode {
  device_auth_id: string;
  user_code: string;
  verification_uri: string;
  interval_seconds: number;
}

export function StatusBar() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [runtime, setRuntime] = useState<RuntimeState | null>(null);
  const [reauthOpen, setReauthOpen] = useState(false);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/status", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as StatusResponse;
      setStatus(data);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    const id = setInterval(fetchStatus, 30_000);
    return () => clearInterval(id);
  }, [fetchStatus]);

  useEffect(() => {
    const es = new EventSource("/api/runtime/state");
    es.addEventListener("state", (ev) => {
      try {
        setRuntime(JSON.parse((ev as MessageEvent).data) as RuntimeState);
      } catch {
        /* ignore */
      }
    });
    return () => es.close();
  }, []);

  const onLogout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/login";
  };

  const tokenValid = status?.token_valid;
  const autoDriveActive = !!runtime?.autoDrive.current;
  const cronTotal = runtime?.departments.reduce(
    (acc, d) => acc + d.cron.length,
    0,
  );

  return (
    <header className="flex items-center justify-between border-b border-zinc-900 bg-black px-4 py-2 text-xs text-zinc-300">
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          <div
            aria-hidden
            className={
              "h-1.5 w-1.5 rounded-full " +
              (tokenValid
                ? "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.7)]"
                : "bg-zinc-600")
            }
          />
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-500">
            mission control
          </span>
        </div>
        <span className="text-zinc-700">·</span>
        <span className="font-mono text-[10px] text-zinc-500">
          gateway: localhost:18923
        </span>
        {autoDriveActive && (
          <>
            <span className="text-zinc-700">·</span>
            <span className="flex items-center gap-1.5 font-mono text-[10px] text-red-300">
              <span
                aria-hidden
                className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-red-400 shadow-[0_0_6px_rgba(248,113,113,0.7)]"
              />
              auto-drive · step{" "}
              {runtime?.autoDrive.current?.steps.length ?? 0}
            </span>
          </>
        )}
        {!!cronTotal && !autoDriveActive && (
          <>
            <span className="text-zinc-700">·</span>
            <span className="font-mono text-[10px] text-zinc-500">
              {cronTotal} cron
            </span>
          </>
        )}
      </div>

      <div className="flex items-center gap-3">
        <span className="font-mono text-[10px] text-zinc-500">
          {tokenValid
            ? `token ok${
                status?.token_expires_at
                  ? ` · exp ${formatRelative(status.token_expires_at)}`
                  : ""
              }`
            : status
              ? "token expired"
              : "token: unknown"}
        </span>
        {/* Once we know status and token is invalid, surface re-auth
            inline so the user doesn't have to leave the dashboard. */}
        {status && !tokenValid ? (
          <button
            type="button"
            onClick={() => setReauthOpen(true)}
            className="rounded border border-amber-700/60 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-300 hover:border-amber-600 hover:bg-amber-500/20"
          >
            Re-authenticate
          </button>
        ) : (
          <button
            type="button"
            onClick={onLogout}
            className="rounded border border-zinc-800 px-2 py-0.5 text-[11px] text-zinc-400 hover:border-zinc-700 hover:text-zinc-200"
          >
            Sign out
          </button>
        )}
      </div>
      {reauthOpen && (
        <ReauthModal
          onClose={() => setReauthOpen(false)}
          onComplete={() => {
            setReauthOpen(false);
            void fetchStatus();
          }}
        />
      )}
    </header>
  );
}

function formatRelative(ts: number): string {
  const diff = ts - Date.now();
  if (diff <= 0) return "expired";
  const hours = Math.floor(diff / 3_600_000);
  if (hours >= 24) return `${Math.floor(hours / 24)}d`;
  if (hours >= 1) return `${hours}h`;
  return `${Math.max(1, Math.floor(diff / 60_000))}m`;
}

/**
 * Inline re-authentication dialog. Reuses the same device-code endpoints
 * as `/login`, but stays inside the dashboard so any in-progress work
 * (open Monaco buffers, terminal sessions) is not lost.
 */
function ReauthModal({
  onClose,
  onComplete,
}: {
  onClose: () => void;
  onComplete: () => void;
}) {
  const [phase, setPhase] = useState<
    "starting" | "awaiting" | "completing" | "error"
  >("starting");
  const [device, setDevice] = useState<DeviceCode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => () => stopPolling(), [stopPolling]);

  // Kick off the device-code flow on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/auth/login/start", { method: "POST" });
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as {
            message?: string;
          };
          throw new Error(j.message || `start failed (${res.status})`);
        }
        const data = (await res.json()) as DeviceCode;
        if (cancelled) return;
        setDevice(data);
        setPhase("awaiting");

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
              const j = (await pollRes.json().catch(() => ({}))) as {
                message?: string;
              };
              throw new Error(j.message || `poll failed (${pollRes.status})`);
            }
            const pollData = (await pollRes.json()) as { status: string };
            if (pollData.status === "complete") {
              stopPolling();
              setPhase("completing");
              onComplete();
            }
          } catch (err) {
            stopPolling();
            setError((err as Error).message);
            setPhase("error");
          }
        }, intervalMs);
      } catch (err) {
        if (cancelled) return;
        setError((err as Error).message);
        setPhase("error");
      }
    })();
    return () => {
      cancelled = true;
      stopPolling();
    };
  }, [onComplete, stopPolling]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="reauth-title"
    >
      <div className="w-full max-w-md rounded-lg border border-amber-500/40 bg-zinc-950 p-6 text-zinc-200">
        <h3 id="reauth-title" className="text-base font-semibold text-amber-300">
          Re-authenticate
        </h3>
        <p className="mt-3 text-sm leading-6 text-zinc-300">
          Your Codex token has expired. Approve the new device code to keep
          using the gateway. Your dashboard session stays open.
        </p>

        {phase === "starting" && (
          <p className="mt-4 font-mono text-xs text-zinc-500">
            requesting device code…
          </p>
        )}

        {phase === "awaiting" && device && (
          <div className="mt-4 space-y-3">
            <div className="rounded-md border border-zinc-800 bg-black px-3 py-3">
              <p className="font-mono text-[10px] uppercase tracking-[0.15em] text-zinc-500">
                code
              </p>
              <p className="mt-1 select-all font-mono text-2xl tracking-widest text-zinc-100">
                {device.user_code}
              </p>
            </div>
            <p className="text-xs text-zinc-300">
              Open{" "}
              <a
                href={device.verification_uri}
                target="_blank"
                rel="noreferrer"
                className="text-amber-300 underline hover:text-amber-200"
              >
                {device.verification_uri}
              </a>{" "}
              and enter the code above.
            </p>
            <p className="font-mono text-[10px] text-zinc-500">
              waiting for approval…
            </p>
          </div>
        )}

        {phase === "completing" && (
          <p className="mt-4 font-mono text-xs text-emerald-400">
            ✓ token refreshed
          </p>
        )}

        {phase === "error" && (
          <p className="mt-4 font-mono text-xs text-red-400">
            ⚠ {error ?? "unknown error"}
          </p>
        )}

        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-zinc-800 px-3 py-1.5 text-xs text-zinc-300 hover:border-zinc-700"
          >
            {phase === "completing" ? "Close" : "Cancel"}
          </button>
        </div>
      </div>
    </div>
  );
}

