import { afterEach, describe, expect, it, vi } from "vitest";

import {
  __resetForTests,
  __setNodePtyForTests,
  createSession,
  deleteSession,
  getSession,
  listSessions,
  loadNodePty,
  MAX_SESSIONS,
  startReaperOnce,
} from "./sessionManager";

afterEach(() => {
  __resetForTests();
});

interface FakePty {
  pid: number;
  cols: number;
  rows: number;
  onData: (cb: (d: string) => void) => { dispose(): void };
  onExit: (cb: (e: { exitCode: number; signal?: number }) => void) => {
    dispose(): void;
  };
  resize: (c: number, r: number) => void;
  write: (d: string) => void;
  kill: (sig?: string) => void;
}

function makeFakePty(overrides: Partial<FakePty> = {}): {
  handle: FakePty;
  emitData: (chunk: string) => void;
  emitExit: (code: number, signal?: number) => void;
} {
  let dataCb: ((d: string) => void) | null = null;
  let exitCb: ((e: { exitCode: number; signal?: number }) => void) | null = null;
  const handle: FakePty = {
    pid: 1234,
    cols: 80,
    rows: 24,
    onData: (cb) => {
      dataCb = cb;
      return { dispose: () => (dataCb = null) };
    },
    onExit: (cb) => {
      exitCb = cb;
      return { dispose: () => (exitCb = null) };
    },
    resize: vi.fn(),
    write: vi.fn(),
    kill: vi.fn(),
    ...overrides,
  };
  return {
    handle,
    emitData: (chunk) => dataCb?.(chunk),
    emitExit: (code, signal) => exitCb?.({ exitCode: code, signal }),
  };
}

describe("sessionManager · loadNodePty", () => {
  it("returns null when require throws", () => {
    __setNodePtyForTests(null);
    expect(loadNodePty()).toBeNull();
  });
});

describe("sessionManager · createSession", () => {
  it("returns unsupported when node-pty is unavailable", () => {
    __setNodePtyForTests(null);
    const r = createSession({ shell: "/bin/bash", args: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("unsupported");
  });

  it("spawns a session and returns the id", () => {
    const fake = makeFakePty();
    __setNodePtyForTests({
      spawn: vi.fn(() => fake.handle),
    });
    const r = createSession({
      shell: "/bin/bash",
      args: ["-l"],
      cols: 100,
      rows: 30,
      label: "claude",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.info.shell).toBe("/bin/bash");
      expect(r.info.cols).toBe(100);
      expect(r.info.label).toBe("claude");
      expect(getSession(r.info.id)).not.toBeNull();
    }
  });

  it("clamps invalid cols/rows to defaults", () => {
    const fake = makeFakePty();
    __setNodePtyForTests({ spawn: vi.fn(() => fake.handle) });
    const r = createSession({
      shell: "/bin/sh",
      args: [],
      cols: 9999, // > max
      rows: -5, // < min
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.info.cols).toBe(500); // clamped to max
      expect(r.info.rows).toBe(1); // negative is finite — clamped to min, not fallback
    }
  });

  it("returns spawn_failed when node-pty.spawn throws", () => {
    __setNodePtyForTests({
      spawn: vi.fn(() => {
        throw new Error("ENOENT");
      }),
    });
    const r = createSession({ shell: "/bin/missing", args: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe("spawn_failed");
      expect(r.detail).toContain("ENOENT");
    }
  });

  it("enforces MAX_SESSIONS", () => {
    __setNodePtyForTests({ spawn: vi.fn(() => makeFakePty().handle) });
    for (let i = 0; i < MAX_SESSIONS; i++) {
      const r = createSession({ shell: "/bin/bash", args: [] });
      expect(r.ok).toBe(true);
    }
    const overflow = createSession({ shell: "/bin/bash", args: [] });
    expect(overflow.ok).toBe(false);
    if (!overflow.ok) expect(overflow.error).toBe("limit");
  });
});

describe("sessionManager · session lifecycle", () => {
  it("buffers output into scrollback and replays it on attach", () => {
    const fake = makeFakePty();
    __setNodePtyForTests({ spawn: vi.fn(() => fake.handle) });
    const r = createSession({ shell: "/bin/bash", args: [] });
    if (!r.ok) throw new Error("setup");
    fake.emitData("hello ");
    fake.emitData("world\n");
    const s = getSession(r.info.id);
    expect(s?.scrollback()).toBe("hello world\n");
  });

  it("emits exit and marks the session as exited", () => {
    const fake = makeFakePty();
    __setNodePtyForTests({ spawn: vi.fn(() => fake.handle) });
    const r = createSession({ shell: "/bin/bash", args: [] });
    if (!r.ok) throw new Error("setup");
    const s = getSession(r.info.id);
    if (!s) throw new Error("missing session");
    const exitEvents: Array<{ code: number; signal?: number }> = [];
    s.on("exit", (e) => exitEvents.push(e));
    fake.emitExit(0);
    expect(s.info.exited).toBe(true);
    expect(s.info.exitCode).toBe(0);
    expect(exitEvents).toHaveLength(1);
  });

  it("write() drops input after exit instead of crashing", () => {
    const fake = makeFakePty();
    __setNodePtyForTests({ spawn: vi.fn(() => fake.handle) });
    const r = createSession({ shell: "/bin/bash", args: [] });
    if (!r.ok) throw new Error("setup");
    fake.emitExit(1);
    const s = getSession(r.info.id);
    s?.write("ignored\n");
    expect(fake.handle.write).not.toHaveBeenCalled();
  });

  it("resize() forwards clamped values to node-pty", () => {
    const fake = makeFakePty();
    __setNodePtyForTests({ spawn: vi.fn(() => fake.handle) });
    const r = createSession({ shell: "/bin/bash", args: [] });
    if (!r.ok) throw new Error("setup");
    const s = getSession(r.info.id);
    s?.resize(150, 50);
    expect(fake.handle.resize).toHaveBeenCalledWith(150, 50);
    expect(s?.info.cols).toBe(150);
  });

  it("deleteSession kills and returns true; returns false for unknown id", () => {
    const fake = makeFakePty();
    __setNodePtyForTests({ spawn: vi.fn(() => fake.handle) });
    const r = createSession({ shell: "/bin/bash", args: [] });
    if (!r.ok) throw new Error("setup");
    expect(deleteSession(r.info.id)).toBe(true);
    expect(fake.handle.kill).toHaveBeenCalled();
    expect(deleteSession("nope")).toBe(false);
  });

  it("listSessions returns a snapshot of active session ids", () => {
    __setNodePtyForTests({ spawn: vi.fn(() => makeFakePty().handle) });
    createSession({ shell: "/bin/bash", args: [] });
    createSession({ shell: "/bin/bash", args: [] });
    expect(listSessions()).toHaveLength(2);
  });
});

describe("sessionManager · startReaperOnce", () => {
  it("is idempotent (does not throw when called twice)", () => {
    expect(() => {
      startReaperOnce();
      startReaperOnce();
    }).not.toThrow();
  });
});
