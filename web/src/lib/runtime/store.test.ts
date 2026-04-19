/**
 * Tests for the runtime store: defaults, mergeWithDefaults via reload,
 * task CRUD via update(), and the atomic write-rename sequence.
 *
 * We point CODEX_GATEWAY_CONFIG_DIR at a fresh temp dir per test so
 * the singleton on-disk state never bleeds between cases. Note that
 * the store's module-level singleton (`store` in store.ts) is created
 * at import time, so we use Vitest's `vi.resetModules()` to obtain a
 * fresh instance whenever we need one bound to the new dir.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mc-store-test-"));
  process.env.CODEX_GATEWAY_CONFIG_DIR = tmpDir;
  vi.resetModules();
});

afterEach(async () => {
  // Atomic write happens off the test's await chain (see store.persist).
  // Give it a tick to settle so rm doesn't race the rename.
  await new Promise((r) => setTimeout(r, 75));
  await fs.rm(tmpDir, { recursive: true, force: true });
  delete process.env.CODEX_GATEWAY_CONFIG_DIR;
});

async function importStore() {
  return await import("./store");
}

describe("runtime store · defaults", () => {
  it("seeds the default state on first read", async () => {
    const { getStore } = await importStore();
    const snap = await getStore().snapshot();
    expect(snap.harness.model).toBe("gpt-5.4");
    expect(snap.harness.autoApproveSafeEdits).toBe(true);
    expect(snap.tasks.length).toBeGreaterThan(0);
    expect(snap.agents.find((a) => a.id === "harness")).toBeTruthy();
    expect(snap.autoDrive.current).toBeNull();
  });

  it("snapshot returns a deep copy that callers cannot mutate", async () => {
    const { getStore } = await importStore();
    const a = await getStore().snapshot();
    a.harness.autoApproveSafeEdits = false;
    a.tasks.push({
      id: "T-mut",
      title: "mutated",
      column: "backlog",
      createdAt: 0,
    });
    const b = await getStore().snapshot();
    expect(b.harness.autoApproveSafeEdits).toBe(true);
    expect(b.tasks.find((t) => t.id === "T-mut")).toBeUndefined();
  });
});

describe("runtime store · update + persistence", () => {
  it("persists mutations atomically and reloads them on next process start", async () => {
    const { getStore } = await importStore();
    await getStore().update((draft) => {
      draft.harness.model = "claude-haiku-4.5";
      draft.harness.persistContext = true;
    });

    // Wait for the queued atomic write to flush.
    await new Promise((r) => setTimeout(r, 50));

    const stateFile = path.join(tmpDir, ".codex-gateway", "mission-control.json");
    const raw = await fs.readFile(stateFile, "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.harness.model).toBe("claude-haiku-4.5");
    expect(parsed.harness.persistContext).toBe(true);

    // Fresh module = fresh singleton; should rehydrate from disk.
    vi.resetModules();
    const fresh = await importStore();
    const snap = await fresh.getStore().snapshot();
    expect(snap.harness.model).toBe("claude-haiku-4.5");
    expect(snap.harness.persistContext).toBe(true);
  });

  it("emits a change event on update", async () => {
    const { getStore } = await importStore();
    const events: number[] = [];
    getStore().on("change", () => events.push(Date.now()));
    await getStore().update((draft) => {
      draft.harness.model = "gpt-4o";
    });
    expect(events.length).toBe(1);
  });
});

describe("runtime store · task CRUD via update()", () => {
  it("supports add, move, and delete of task cards", async () => {
    const { getStore, newId } = await importStore();
    const taskId = newId("T");
    expect(taskId).toMatch(/^T_/);

    await getStore().update((d) => {
      d.tasks.push({
        id: taskId,
        title: "test card",
        column: "backlog",
        createdAt: Date.now(),
      });
    });
    let snap = await getStore().snapshot();
    expect(snap.tasks.find((t) => t.id === taskId)?.column).toBe("backlog");

    // Move to active.
    await getStore().update((d) => {
      const t = d.tasks.find((x) => x.id === taskId);
      if (t) t.column = "active";
    });
    snap = await getStore().snapshot();
    expect(snap.tasks.find((t) => t.id === taskId)?.column).toBe("active");

    // Delete.
    await getStore().update((d) => {
      d.tasks = d.tasks.filter((t) => t.id !== taskId);
    });
    snap = await getStore().snapshot();
    expect(snap.tasks.find((t) => t.id === taskId)).toBeUndefined();
  });
});

describe("runtime store · mergeWithDefaults (reload)", () => {
  it("falls back to default model when on-disk state has a non-string value", async () => {
    // Pre-seed a malformed file before first import.
    const dir = path.join(tmpDir, ".codex-gateway");
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.writeFile(
      path.join(dir, "mission-control.json"),
      JSON.stringify({
        harness: { autoApproveSafeEdits: false, model: 42 },
      }),
    );
    const { getStore } = await importStore();
    const snap = await getStore().snapshot();
    expect(snap.harness.model).toBe("gpt-5.4");
    // Other fields still merge.
    expect(snap.harness.autoApproveSafeEdits).toBe(false);
  });

  it("never restores a 'running' auto-drive run from disk", async () => {
    const dir = path.join(tmpDir, ".codex-gateway");
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.writeFile(
      path.join(dir, "mission-control.json"),
      JSON.stringify({
        autoDrive: {
          current: {
            id: "drv_orphan",
            goal: "x",
            startedAt: 0,
            status: "running",
            steps: [],
            bytesEmitted: 0,
          },
          history: [],
        },
      }),
    );
    const { getStore } = await importStore();
    const snap = await getStore().snapshot();
    expect(snap.autoDrive.current).toBeNull();
  });

  it("clamps invalid task columns to 'backlog'", async () => {
    const dir = path.join(tmpDir, ".codex-gateway");
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.writeFile(
      path.join(dir, "mission-control.json"),
      JSON.stringify({
        tasks: [
          { id: "T-x", title: "bad col", column: "garbage", createdAt: 1 },
        ],
      }),
    );
    const { getStore } = await importStore();
    const snap = await getStore().snapshot();
    expect(snap.tasks.find((t) => t.id === "T-x")?.column).toBe("backlog");
  });
});
