"use client";

import { useEffect, useState } from "react";

interface StatusResponse {
  authenticated: boolean;
  token_valid: boolean;
  token_expires_at: number | null;
}

export function StatusBar() {
  const [status, setStatus] = useState<StatusResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    const fetchStatus = async () => {
      try {
        const res = await fetch("/api/auth/status", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as StatusResponse;
        if (!cancelled) setStatus(data);
      } catch {
        /* ignore */
      }
    };
    fetchStatus();
    const id = setInterval(fetchStatus, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const onLogout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/login";
  };

  const tokenValid = status?.token_valid;

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
      </div>

      <div className="flex items-center gap-3">
        <span className="font-mono text-[10px] text-zinc-500">
          {tokenValid
            ? `token ok${
                status?.token_expires_at
                  ? ` · exp ${formatRelative(status.token_expires_at)}`
                  : ""
              }`
            : "token: unknown"}
        </span>
        <button
          type="button"
          onClick={onLogout}
          className="rounded border border-zinc-800 px-2 py-0.5 text-[11px] text-zinc-400 hover:border-zinc-700 hover:text-zinc-200"
        >
          Sign out
        </button>
      </div>
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
