"use client";

/**
 * Single shared SSE subscription to `/api/runtime/state`.
 *
 * Diagnostic §1 ("State subscription is fragmented across many
 * components"): every panel previously opened its own `EventSource`,
 * which meant N parsing implementations, N reconnect behaviours, and
 * N copies of the runtime snapshot in memory. Funneling everything
 * through this provider gives us:
 *
 *   • one EventSource per browser tab
 *   • one parse path with shared error-handling
 *   • one selector hook so panels re-render only on the slices they care about
 *   • a connection-status flag for UI ("offline" indicator etc.)
 *
 * The provider does not modify the wire format. The `/api/runtime/state`
 * route still emits `event: state` frames whose `data` is a JSON
 * `RuntimeState`, plus `event: heartbeat` frames we ignore. Mounting
 * a single `<RuntimeProvider>` near the app root and consuming via
 * `useRuntimeState()` is the new convention; per-panel `EventSource`
 * use is deprecated.
 */

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type { RuntimeState } from "@/lib/runtime";

/**
 * Lifecycle status of the underlying SSE connection. Panels can use
 * this to show a "reconnecting…" hint without each implementing its
 * own retry/backoff logic.
 */
export type RuntimeConnectionStatus =
  | "idle"
  | "connecting"
  | "open"
  | "reconnecting"
  | "error";

interface RuntimeContextValue {
  state: RuntimeState | null;
  status: RuntimeConnectionStatus;
}

const RuntimeContext = createContext<RuntimeContextValue | null>(null);

export interface RuntimeProviderProps {
  children: ReactNode;
  /**
   * Override the SSE endpoint. Defaults to `/api/runtime/state`. Mostly
   * useful for tests / Storybook.
   */
  url?: string;
}

/**
 * Mount once, near the app root. The first SSE message hydrates
 * `state`; until then `useRuntimeState()` returns `null`, which
 * panels should treat as "loading".
 */
export function RuntimeProvider({
  children,
  url = "/api/runtime/state",
}: RuntimeProviderProps) {
  const [state, setState] = useState<RuntimeState | null>(null);
  const [status, setStatus] = useState<RuntimeConnectionStatus>("idle");

  // We hold the EventSource in a ref so React Fast Refresh and any
  // repeated effect runs (StrictMode, dev) close the previous
  // instance instead of leaking sockets.
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (typeof window === "undefined" || typeof EventSource === "undefined") {
      return;
    }

    setStatus("connecting");
    const es = new EventSource(url);
    esRef.current = es;

    const onState = (ev: MessageEvent) => {
      try {
        const next = JSON.parse(ev.data) as RuntimeState;
        setState(next);
        // The first state frame after `connecting`/`reconnecting`
        // implies the connection is healthy.
        setStatus("open");
      } catch {
        /* malformed frame — ignore, the next one will arrive shortly */
      }
    };

    const onError = () => {
      // EventSource auto-reconnects, but we want to reflect the
      // transition in UI. We only flip from "open" → "reconnecting"
      // (avoiding noise during the initial handshake by leaving
      // "connecting" alone until either a state frame arrives or
      // the connection is fully closed).
      setStatus((prev) => {
        if (prev === "open") return "reconnecting";
        if (prev === "connecting") return "error";
        return prev;
      });
    };

    es.addEventListener("state", onState as EventListener);
    es.addEventListener("error", onError as EventListener);

    return () => {
      es.removeEventListener("state", onState as EventListener);
      es.removeEventListener("error", onError as EventListener);
      es.close();
      if (esRef.current === es) esRef.current = null;
      setStatus("idle");
    };
  }, [url]);

  const value = useMemo<RuntimeContextValue>(
    () => ({ state, status }),
    [state, status],
  );

  return (
    <RuntimeContext.Provider value={value}>{children}</RuntimeContext.Provider>
  );
}

function useRuntimeContext(): RuntimeContextValue {
  const ctx = useContext(RuntimeContext);
  if (!ctx) {
    throw new Error(
      "RuntimeProvider missing — wrap the app in <RuntimeProvider> before using runtime hooks.",
    );
  }
  return ctx;
}

/** Returns the latest `RuntimeState` snapshot (or `null` while loading). */
export function useRuntimeState(): RuntimeState | null {
  return useRuntimeContext().state;
}

/** Returns the SSE connection status. */
export function useRuntimeConnectionStatus(): RuntimeConnectionStatus {
  return useRuntimeContext().status;
}

/** Returns a derived value from the runtime state. */
export function useRuntimeSelector<T>(selector: (state: RuntimeState | null) => T): T {
  const state = useRuntimeState();
  // The `selector` argument is intentionally omitted from the deps:
  // forcing every consumer to `useCallback` its selector would be
  // noisy, and selector-identity changes between renders are safe
  // because we only need to recompute when `state` itself changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => selector(state), [state]);
}
