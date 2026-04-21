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

    const stateFile = path.join(tmpDir, ".codex-gateway", "claude-codex.json");
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
      path.join(dir, "claude-codex.json"),
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
      path.join(dir, "claude-codex.json"),
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
      path.join(dir, "claude-codex.json"),
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

  it("migrates the legacy mission-control.json filename on first load", async () => {
    const dir = path.join(tmpDir, ".codex-gateway");
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    // Only the legacy file exists — the new-name file is absent.
    await fs.writeFile(
      path.join(dir, "mission-control.json"),
      JSON.stringify({ harness: { model: "gpt-4o" } }),
    );
    const { getStore } = await importStore();
    const snap = await getStore().snapshot();
    expect(snap.harness.model).toBe("gpt-4o");
    // The rename side-effect moves legacy -> new filename.
    const newExists = await fs
      .stat(path.join(dir, "claude-codex.json"))
      .then(() => true)
      .catch(() => false);
    const legacyExists = await fs
      .stat(path.join(dir, "mission-control.json"))
      .then(() => true)
      .catch(() => false);
    expect(newExists).toBe(true);
    expect(legacyExists).toBe(false);
  });
});

describe("runtime store · normalizeSubtasks", () => {
  it("drops malformed items and clamps to the per-task cap", async () => {
    const { normalizeSubtasks, MAX_SUBTASKS_PER_TASK } = await importStore();
    const out = normalizeSubtasks([
      { id: "s1", title: "ok", done: true },
      { id: "", title: "missing id" },
      { id: "s2", title: "" },
      { id: "s3", title: "   whitespace-ok  ", done: "truthy-but-not-bool" },
      null,
      "string",
      { id: "s4", title: "x".repeat(500) },
    ]);
    expect(out).toBeDefined();
    const list = out!;
    expect(list.map((s) => s.id)).toEqual(["s1", "s3", "s4"]);
    // Non-boolean `done` coerces to false (strict equality check).
    expect(list[1].done).toBe(false);
    // Title is trimmed + capped at 200.
    expect(list[1].title).toBe("whitespace-ok");
    expect(list[2].title.length).toBe(200);

    // Cap enforcement.
    const many = Array.from({ length: MAX_SUBTASKS_PER_TASK + 5 }, (_, i) => ({
      id: `s${i}`,
      title: `t${i}`,
    }));
    expect(normalizeSubtasks(many)!.length).toBe(MAX_SUBTASKS_PER_TASK);
  });

  it("returns undefined for non-array or empty input", async () => {
    const { normalizeSubtasks } = await importStore();
    expect(normalizeSubtasks(undefined)).toBeUndefined();
    expect(normalizeSubtasks(null)).toBeUndefined();
    expect(normalizeSubtasks("nope")).toBeUndefined();
    expect(normalizeSubtasks([])).toBeUndefined();
    expect(normalizeSubtasks([{ id: "", title: "" }])).toBeUndefined();
  });
});

describe("runtime store · persona + webhook defaults", () => {
  it("seeds persona='core' and webhook=null", async () => {
    const { getStore } = await importStore();
    const snap = await getStore().snapshot();
    expect(snap.harness.persona).toBe("core");
    expect(snap.harness.webhook).toBeNull();
  });

  it("clamps an unknown persona on disk back to 'core'", async () => {
    const dir = path.join(tmpDir, ".codex-gateway");
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.writeFile(
      path.join(dir, "claude-codex.json"),
      JSON.stringify({ harness: { persona: "evil-persona" } }),
    );
    const { getStore } = await importStore();
    const snap = await getStore().snapshot();
    expect(snap.harness.persona).toBe("core");
  });

  it("preserves a valid persona and a valid webhook on reload", async () => {
    const dir = path.join(tmpDir, ".codex-gateway");
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.writeFile(
      path.join(dir, "claude-codex.json"),
      JSON.stringify({
        harness: {
          persona: "review",
          webhook: {
            url: "https://example.com/hook",
            secret: "shh",
            enabled: true,
          },
        },
      }),
    );
    const { getStore } = await importStore();
    const snap = await getStore().snapshot();
    expect(snap.harness.persona).toBe("review");
    expect(snap.harness.webhook?.url).toContain("example.com");
    expect(snap.harness.webhook?.enabled).toBe(true);
    expect(snap.harness.webhook?.secret).toBe("shh");
  });

  it("drops a webhook with an invalid URL on reload", async () => {
    const dir = path.join(tmpDir, ".codex-gateway");
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.writeFile(
      path.join(dir, "claude-codex.json"),
      JSON.stringify({
        harness: { webhook: { url: "ftp://nope", enabled: true } },
      }),
    );
    const { getStore } = await importStore();
    const snap = await getStore().snapshot();
    expect(snap.harness.webhook).toBeNull();
  });
});

describe("runtime store · isValidPersona / personaAgentId", () => {
  it("only accepts the three closed-set values", async () => {
    const { isValidPersona } = await importStore();
    expect(isValidPersona("core")).toBe(true);
    expect(isValidPersona("impl")).toBe(true);
    expect(isValidPersona("review")).toBe(true);
    expect(isValidPersona("CORE")).toBe(false);
    expect(isValidPersona("")).toBe(false);
    expect(isValidPersona(null)).toBe(false);
    expect(isValidPersona(undefined)).toBe(false);
  });

  it("maps each persona to the corresponding seeded agent row", async () => {
    const { personaAgentId } = await importStore();
    expect(personaAgentId("core")).toBe("ruflo-core");
    expect(personaAgentId("impl")).toBe("ruflo-impl");
    expect(personaAgentId("review")).toBe("ruflo-review");
  });
});
