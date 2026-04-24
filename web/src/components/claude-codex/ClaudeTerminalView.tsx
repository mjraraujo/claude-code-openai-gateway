"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

import type { PtyKind } from "@/lib/pty/policy";

interface ClaudeTerminalViewProps {
  /** Which binary the PTY should spawn. Defaults to "claude". */
  kind?: PtyKind;
  /**
   * Server-side PTY session id this view should try to reattach to
   * before falling back to spawning a fresh session. Set by the
   * parent {@link import("./TerminalTabs").TerminalTabs} from
   * persisted state so a page reload reattaches to the same `claude`
   * REPL instead of starting a new one.
   */
  persistedSessionId?: string;
  /**
   * Notifies the parent of the session id this view ended up bound
   * to (or `undefined` if the underlying PTY had to be torn down).
   * The parent persists it to localStorage so the next reload can
   * reattach.
   */
  onSession?: (sessionId: string | undefined) => void;
}

interface SessionInfo {
  id: string;
  shell: string;
  cols: number;
  rows: number;
  label?: string;
  /** Set by the server when the underlying PTY has already exited. */
  exited?: boolean;
}

type Status =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "running"; sessionId: string }
  | { kind: "exited"; code: number | null; signal: string | null }
  | { kind: "error"; message: string };

/**
 * xterm.js-backed terminal that talks to `/api/pty/*`.
 *
 * Lifecycle:
 *   1. On mount, POST /api/pty to create a session.
 *   2. Open `/api/pty/<id>/stream` (SSE) for output. The first event
 *      replays the scrollback so reattaches paint correctly.
 *   3. Forward xterm `onData` to POST /api/pty/<id>/input.
 *   4. ResizeObserver → fitAddon.fit() → POST /api/pty/<id>/resize.
 *   5. On unmount, abort the SSE stream. The session itself is *not*
 *      killed so reopening the tab can reattach. The server reaps
 *      idle sessions automatically.
 *
 * No DOM globals (Terminal, ResizeObserver) are touched on the
 * server because the whole module is only imported via
 * `next/dynamic({ ssr: false })` from the parent.
 */
export default function ClaudeTerminalView({
  kind = "claude",
  persistedSessionId,
  onSession,
}: ClaudeTerminalViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionRef = useRef<SessionInfo | null>(null);
  const inputAbortRef = useRef<AbortController | null>(null);
  const streamAbortRef = useRef<AbortController | null>(null);
  // Capture persistence inputs in refs so the parent updating
  // `persistedSessionId` (which we ourselves trigger via
  // `onSession`) doesn't tear down and re-mount the PTY.
  const persistedRef = useRef<string | undefined>(persistedSessionId);
  const onSessionRef = useRef<typeof onSession>(onSession);
  useEffect(() => {
    onSessionRef.current = onSession;
  }, [onSession]);
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const sendInput = useCallback(async (data: string) => {
    const session = sessionRef.current;
    if (!session) return;
    // Single in-flight POST per keystroke is fine for a typing
    // operator; we don't try to coalesce.
    try {
      const ctrl = new AbortController();
      inputAbortRef.current = ctrl;
      await fetch(`/api/pty/${session.id}/input`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data }),
        signal: ctrl.signal,
      });
    } catch {
      /* network blip — keystroke lost; xterm has no way to undo */
    }
  }, []);

  const sendResize = useCallback(async (cols: number, rows: number) => {
    const session = sessionRef.current;
    if (!session) return;
    try {
      await fetch(`/api/pty/${session.id}/resize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cols, rows }),
      });
    } catch {
      /* ignore */
    }
  }, []);

  // Boot the terminal + session.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const term = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      theme: {
        background: "#000000",
        foreground: "#e4e4e7",
        cursor: "#a5f3fc",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    try {
      fit.fit();
    } catch {
      /* container has no size yet — ResizeObserver will fix it */
    }
    termRef.current = term;
    fitRef.current = fit;
    term.onData((data) => {
      void sendInput(data);
    });

    setStatus({ kind: "starting" });

    let cancelled = false;
    (async () => {
      const persisted = persistedRef.current;
      try {
        // 1. If the parent gave us a persisted session id, try to
        //    reattach before spawning. This is what makes a browser
        //    refresh land back in the same `claude` REPL instead of
        //    a fresh one. A 404 means the server already reaped the
        //    session (idle timeout) and we should fall through to
        //    POST /api/pty.
        let session: SessionInfo | null = null;
        if (persisted) {
          try {
            const res = await fetch(`/api/pty/${persisted}`, {
              cache: "no-store",
            });
            if (res.ok) {
              const body = (await res.json()) as { session: SessionInfo };
              if (!body.session.exited) session = body.session;
            }
          } catch {
            /* network blip — fall through to POST */
          }
        }

        if (!session) {
          const res = await fetch("/api/pty", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              kind,
              cols: term.cols,
              rows: term.rows,
            }),
          });
          if (!res.ok) {
            // The route returns `{ error: "...", detail?: "..." }` —
            // rename for readability so the nested `detail.detail`
            // chain doesn't read like a typo.
            const errBody = (await res.json().catch(() => ({}))) as {
              error?: string;
              detail?: string;
            };
            const msg =
              errBody.error === "unsupported"
                ? `interactive terminal unavailable: ${errBody.detail ?? "node-pty not installed"}`
                : `pty create failed (${res.status}): ${errBody.error ?? ""}`;
            throw new Error(msg);
          }
          session = ((await res.json()) as { session: SessionInfo }).session;
        }

        if (cancelled) return;
        sessionRef.current = session;
        // Push the (possibly new) session id back up to the parent
        // so it can persist for the next reload.
        if (session.id !== persisted) {
          persistedRef.current = session.id;
          onSessionRef.current?.(session.id);
        }
        setStatus({ kind: "running", sessionId: session.id });
        attachStream(session.id);
      } catch (err) {
        if (!cancelled) {
          const message = (err as Error).message;
          term.write(`\r\n\x1b[31m${message}\x1b[0m\r\n`);
          setStatus({ kind: "error", message });
          // Forget the dead session id so the next mount tries to
          // create fresh rather than chase a 404 again.
          if (persisted) {
            persistedRef.current = undefined;
            onSessionRef.current?.(undefined);
          }
        }
      }
    })();

    function attachStream(sessionId: string) {
      const ctrl = new AbortController();
      streamAbortRef.current = ctrl;
      void streamSse(sessionId, ctrl.signal, {
        onInit: (scrollback) => {
          if (scrollback) term.write(scrollback);
        },
        onChunk: (chunk) => term.write(chunk),
        onExit: (code, signal) => {
          term.write(
            `\r\n\x1b[33m[pty exited code=${code ?? "?"}${signal ? ` signal=${signal}` : ""}]\x1b[0m\r\n`,
          );
          setStatus({ kind: "exited", code, signal });
        },
        onError: (msg) => {
          term.write(`\r\n\x1b[31m[stream error: ${msg}]\x1b[0m\r\n`);
        },
      });
    }

    return () => {
      cancelled = true;
      streamAbortRef.current?.abort();
      inputAbortRef.current?.abort();
      streamAbortRef.current = null;
      inputAbortRef.current = null;
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [kind, sendInput]);

  // ResizeObserver → fit → POST resize.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let lastCols = 0;
    let lastRows = 0;
    const ro = new ResizeObserver(() => {
      const term = termRef.current;
      const fit = fitRef.current;
      if (!term || !fit) return;
      try {
        fit.fit();
      } catch {
        return;
      }
      if (term.cols !== lastCols || term.rows !== lastRows) {
        lastCols = term.cols;
        lastRows = term.rows;
        void sendResize(term.cols, term.rows);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [sendResize]);

  return (
    <div className="flex h-full flex-col bg-black">
      <div className="flex shrink-0 items-center justify-between border-b border-zinc-900 px-3 py-1.5">
        <span className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">
          claude codex · interactive
        </span>
        <span className="text-[10px] text-zinc-500">{statusLabel(status)}</span>
      </div>
      <div ref={containerRef} className="min-h-0 flex-1 px-2 py-1" />
    </div>
  );
}

function statusLabel(s: Status): string {
  switch (s.kind) {
    case "idle":
      return "idle";
    case "starting":
      return "starting…";
    case "running":
      return "running";
    case "exited":
      return s.signal
        ? `exited (signal ${s.signal})`
        : `exited (code ${s.code ?? "?"})`;
    case "error":
      return "error";
  }
}

/**
 * Drain an SSE stream, dispatching events to the supplied callbacks.
 * Pulled into its own function so the boot effect stays readable.
 */
async function streamSse(
  sessionId: string,
  signal: AbortSignal,
  handlers: {
    onInit: (scrollback: string) => void;
    onChunk: (chunk: string) => void;
    onExit: (code: number | null, signal: string | null) => void;
    onError: (message: string) => void;
  },
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`/api/pty/${sessionId}/stream`, { signal });
  } catch (err) {
    if ((err as Error).name !== "AbortError") {
      handlers.onError((err as Error).message);
    }
    return;
  }
  if (!res.ok || !res.body) {
    handlers.onError(`stream open failed (${res.status})`);
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        dispatchSseBlock(block, handlers);
      }
    }
  } catch (err) {
    if ((err as Error).name !== "AbortError") {
      handlers.onError((err as Error).message);
    }
  }
}

function dispatchSseBlock(
  block: string,
  handlers: {
    onInit: (scrollback: string) => void;
    onChunk: (chunk: string) => void;
    onExit: (code: number | null, signal: string | null) => void;
    onError: (message: string) => void;
  },
): void {
  let event = "message";
  let data = "";
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data += line.slice(5).trim();
  }
  if (!data) return;
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(data) as Record<string, unknown>;
  } catch {
    return;
  }
  switch (event) {
    case "init":
      if (typeof payload.scrollback === "string") {
        handlers.onInit(payload.scrollback);
      }
      break;
    case "out":
      if (typeof payload.chunk === "string") handlers.onChunk(payload.chunk);
      break;
    case "exit":
      handlers.onExit(
        typeof payload.code === "number" ? payload.code : null,
        typeof payload.signal === "string"
          ? payload.signal
          : payload.signal != null
            ? String(payload.signal)
            : null,
      );
      break;
    default:
      break;
  }
}
