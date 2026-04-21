/**
 * PTY session lifecycle.
 *
 * The dashboard's interactive Claude terminal needs a real PTY (so
 * `claude-codex` sees a TTY and can render its full TUI) but Next.js
 * App Router can't host a WebSocket. Instead we expose the PTY via
 * the same SSE-out + POST-in pattern the chat dock already uses:
 *
 *   1. POST /api/pty                  — create a session, returns id
 *   2. GET  /api/pty/[id]/stream      — SSE of stdout/exit events
 *   3. POST /api/pty/[id]/input       — write to stdin
 *   4. POST /api/pty/[id]/resize      — update cols/rows
 *   5. DEL  /api/pty/[id]             — kill
 *
 * Sessions are kept in a process-level Map and reaped after a TTL of
 * inactivity (no client polling means a navigated-away tab eventually
 * dies on its own without leaking child processes). One operator with
 * a handful of tabs is the design point — `MAX_SESSIONS` is a coarse
 * runaway guard.
 *
 * `node-pty` is an `optionalDependencies` (its native bindings don't
 * compile in every sandbox) so this module imports it lazily and
 * reports a clean `unsupported` error when it isn't available rather
 * than crashing the whole route module on import.
 */

import { EventEmitter } from "node:events";
import { createRequire } from "node:module";

export const MAX_SESSIONS = 16;
export const DEFAULT_COLS = 120;
export const DEFAULT_ROWS = 32;
/** Inactivity (no input + no client stream open) after which the session is reaped. */
export const SESSION_IDLE_MS = 10 * 60 * 1000;
/** Output ring-buffer size. Lets a freshly-attached stream replay recent output. */
export const SCROLLBACK_BYTES = 64 * 1024;

export interface SpawnOptions {
  shell: string;
  args: readonly string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  cols?: number;
  rows?: number;
  /** Cosmetic — included in the create response so the UI can label it. */
  label?: string;
}

export interface PtySessionInfo {
  id: string;
  shell: string;
  args: readonly string[];
  cols: number;
  rows: number;
  createdAt: number;
  label?: string;
  exited: boolean;
  exitCode?: number;
  exitSignal?: string;
}

interface NodePtyHandle {
  pid: number;
  cols: number;
  rows: number;
  onData(cb: (data: string) => void): { dispose(): void };
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): {
    dispose(): void;
  };
  resize(cols: number, rows: number): void;
  write(data: string): void;
  kill(signal?: string): void;
}

interface NodePtyModule {
  spawn: (
    file: string,
    args: readonly string[],
    options: {
      name?: string;
      cols?: number;
      rows?: number;
      cwd?: string;
      env?: NodeJS.ProcessEnv;
    },
  ) => NodePtyHandle;
}

let cachedPtyModule: NodePtyModule | null | undefined;

/**
 * Load `node-pty` once. Returns `null` (rather than throwing) when
 * the optional dep is absent so callers can downgrade gracefully.
 *
 * Exported for tests that need to override the loader.
 */
export function loadNodePty(): NodePtyModule | null {
  if (cachedPtyModule !== undefined) return cachedPtyModule;
  try {
    // `createRequire` lets us pull in a CommonJS native addon from
    // ESM-compiled code without inviting bundlers to follow it.
    // Combined with `serverExternalPackages: ["node-pty"]` in
    // `next.config.ts`, Next.js leaves the import alone and the
    // standalone output's module tracer copies the real package
    // over from node_modules.
    const req = createRequire(import.meta.url);
    cachedPtyModule = req("node-pty") as NodePtyModule;
  } catch {
    cachedPtyModule = null;
  }
  return cachedPtyModule;
}

/** Test-only hook to inject a fake module without touching `require`. */
export function __setNodePtyForTests(mod: NodePtyModule | null): void {
  cachedPtyModule = mod;
}

class PtySession extends EventEmitter {
  readonly info: PtySessionInfo;
  private handle: NodePtyHandle;
  private buffer = "";
  private lastActivityAt: number;
  /** Number of attached SSE streams. */
  private listenerCount_ = 0;

  constructor(info: PtySessionInfo, handle: NodePtyHandle) {
    super();
    this.setMaxListeners(0);
    this.info = info;
    this.handle = handle;
    this.lastActivityAt = Date.now();
    handle.onData((data) => this.onData(data));
    handle.onExit(({ exitCode, signal }) => this.onExit(exitCode, signal));
  }

  private onData(chunk: string): void {
    this.lastActivityAt = Date.now();
    this.buffer += chunk;
    if (this.buffer.length > SCROLLBACK_BYTES) {
      this.buffer = this.buffer.slice(this.buffer.length - SCROLLBACK_BYTES);
    }
    this.emit("data", chunk);
  }

  private onExit(code: number, signal?: number): void {
    this.info.exited = true;
    this.info.exitCode = code;
    if (signal != null) this.info.exitSignal = String(signal);
    this.emit("exit", { code, signal });
  }

  write(data: string): void {
    if (this.info.exited) return;
    this.lastActivityAt = Date.now();
    this.handle.write(data);
  }

  resize(cols: number, rows: number): void {
    if (this.info.exited) return;
    const c = clampInt(cols, 1, 500, DEFAULT_COLS);
    const r = clampInt(rows, 1, 200, DEFAULT_ROWS);
    this.info.cols = c;
    this.info.rows = r;
    this.lastActivityAt = Date.now();
    try {
      this.handle.resize(c, r);
    } catch {
      // PTY already exited — ignore.
    }
  }

  kill(signal: string = "SIGHUP"): void {
    try {
      this.handle.kill(signal);
    } catch {
      /* ignore */
    }
  }

  /** Returns the current scrollback so a newly-attached stream can replay it. */
  scrollback(): string {
    return this.buffer;
  }

  /** Tracks whether anything is listening (for idle reaping). */
  attachListener(): void {
    this.listenerCount_++;
    this.lastActivityAt = Date.now();
  }
  detachListener(): void {
    if (this.listenerCount_ > 0) this.listenerCount_--;
    this.lastActivityAt = Date.now();
  }

  isIdle(now: number): boolean {
    return (
      this.listenerCount_ === 0 &&
      now - this.lastActivityAt > SESSION_IDLE_MS
    );
  }
}

const sessions = new Map<string, PtySession>();
let idSeq = 0;

function newSessionId(): string {
  idSeq += 1;
  return `pty-${Date.now().toString(36)}-${idSeq.toString(36)}`;
}

export type CreateResult =
  | { ok: true; info: PtySessionInfo }
  | { ok: false; error: "unsupported" | "limit" | "spawn_failed"; detail?: string };

export function createSession(opts: SpawnOptions): CreateResult {
  if (sessions.size >= MAX_SESSIONS) {
    return { ok: false, error: "limit" };
  }
  const mod = loadNodePty();
  if (!mod) {
    return {
      ok: false,
      error: "unsupported",
      detail:
        "node-pty native binding is not available in this build — install it on the host to enable the interactive terminal",
    };
  }

  const cols = clampInt(opts.cols, 1, 500, DEFAULT_COLS);
  const rows = clampInt(opts.rows, 1, 200, DEFAULT_ROWS);
  let handle: NodePtyHandle;
  try {
    handle = mod.spawn(opts.shell, opts.args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd: opts.cwd,
      env: filterEnv(opts.env),
    });
  } catch (err) {
    return { ok: false, error: "spawn_failed", detail: (err as Error).message };
  }

  const info: PtySessionInfo = {
    id: newSessionId(),
    shell: opts.shell,
    args: [...opts.args],
    cols,
    rows,
    createdAt: Date.now(),
    label: opts.label,
    exited: false,
  };
  const session = new PtySession(info, handle);
  sessions.set(info.id, session);

  // Auto-reap on exit so the Map doesn't grow unbounded across
  // restarts of the claude-codex CLI inside the session.
  session.once("exit", () => {
    setTimeout(() => sessions.delete(info.id), 5_000);
  });

  return { ok: true, info: { ...info } };
}

export function getSession(id: string): PtySession | null {
  return sessions.get(id) ?? null;
}

export function deleteSession(id: string, signal: string = "SIGHUP"): boolean {
  const s = sessions.get(id);
  if (!s) return false;
  s.kill(signal);
  return true;
}

export function listSessions(): PtySessionInfo[] {
  return Array.from(sessions.values()).map((s) => ({ ...s.info }));
}

let reaperTimer: NodeJS.Timeout | null = null;
/**
 * Start the idle-session reaper. Idempotent — safe to call from any
 * route file that touches the session map.
 */
export function startReaperOnce(): void {
  if (reaperTimer) return;
  reaperTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, s] of sessions) {
      if (s.isIdle(now)) {
        s.kill("SIGHUP");
        sessions.delete(id);
      }
    }
  }, 60_000);
  // Don't keep the Node process alive purely to run the reaper.
  reaperTimer.unref?.();
}

/** Test-only: tear down all sessions and reset the reaper timer. */
export function __resetForTests(): void {
  for (const [, s] of sessions) {
    s.removeAllListeners();
    try {
      s.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  }
  sessions.clear();
  if (reaperTimer) {
    clearInterval(reaperTimer);
    reaperTimer = null;
  }
  cachedPtyModule = undefined;
  idSeq = 0;
}

function clampInt(
  raw: number | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(raw)));
}

/**
 * Strip undefined values so the spawn call doesn't pass `KEY=undefined`
 * through to the child. Defensive — callers can pass `process.env`
 * directly without massaging it first.
 */
function filterEnv(
  env: Record<string, string | undefined> | undefined,
): NodeJS.ProcessEnv {
  // The `NodeJS.ProcessEnv` interface insists on `NODE_ENV` but the
  // child process is happy without it; cast to bypass that overly
  // strict declaration without lying about the runtime contract.
  const out = {} as NodeJS.ProcessEnv;
  if (!env) return out;
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

export type { PtySession };
