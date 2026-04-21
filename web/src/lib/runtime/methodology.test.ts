/**
 * Tests for methodology / dev-mode scaffolding (PR 3).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

let workspace: string;
let cfgDir: string;

beforeEach(async () => {
  workspace = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "mc-meth-test-")),
  );
  cfgDir = await fs.mkdtemp(path.join(os.tmpdir(), "mc-meth-cfg-"));
  process.env.MISSION_CONTROL_WORKSPACE = workspace;
  process.env.CODEX_GATEWAY_CONFIG_DIR = cfgDir;
  vi.resetModules();
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
  await fs.rm(cfgDir, { recursive: true, force: true });
  delete process.env.MISSION_CONTROL_WORKSPACE;
  delete process.env.CODEX_GATEWAY_CONFIG_DIR;
});

describe("methodology registry", () => {
  it("exposes the four expected methodologies", async () => {
    const m = await import("./methodology");
    const ids = m.METHODOLOGY_REGISTRY.map((e) => e.id);
    expect(ids).toEqual(["spec-driven", "bdd", "tdd", "xp"]);
  });

  it("findMethodology returns null for unknown ids", async () => {
    const m = await import("./methodology");
    expect(m.findMethodology("nope")).toBeNull();
    expect(m.findMethodology(undefined)).toBeNull();
    expect(m.findMethodology("spec-driven")).not.toBeNull();
  });
});

describe("scaffoldMethodology", () => {
  it("creates SPEC.md + DECISIONS.md for spec-driven into the active workspace", async () => {
    const { getStore } = await import("./store");
    const { findMethodology, scaffoldMethodology } = await import(
      "./methodology"
    );
    const state = await getStore().snapshot();
    const entry = findMethodology("spec-driven");
    expect(entry).not.toBeNull();
    const result = await scaffoldMethodology(state, entry!, "methodology");
    expect(result.filesCreated.sort()).toEqual([
      "DECISIONS.md",
      "SPEC.md",
    ]);
    expect(
      await fs.readFile(path.join(workspace, "SPEC.md"), "utf8"),
    ).toMatch(/# Spec/);
  });

  it("is idempotent — second call skips existing files", async () => {
    const { getStore } = await import("./store");
    const { findMethodology, scaffoldMethodology } = await import(
      "./methodology"
    );
    const entry = findMethodology("bdd")!;
    const state = await getStore().snapshot();
    const first = await scaffoldMethodology(state, entry, "methodology");
    expect(first.filesCreated.length).toBeGreaterThan(0);
    const second = await scaffoldMethodology(state, entry, "methodology");
    expect(second.filesCreated).toEqual([]);
    expect(second.filesSkipped.length).toBe(first.filesCreated.length);
  });

  it("records the methodology id in the workspace's scaffold ledger", async () => {
    const { getStore } = await import("./store");
    const { findMethodology, scaffoldMethodology } = await import(
      "./methodology"
    );
    const entry = findMethodology("tdd")!;
    const state = await getStore().snapshot();
    await scaffoldMethodology(state, entry, "methodology");
    const after = await getStore().snapshot();
    const rec = after.scaffolds.find((s) => s.workspaceId === after.activeWorkspaceId);
    expect(rec).toBeTruthy();
    expect(rec!.methodology).toBe("tdd");
    expect(rec!.filesSeeded).toContain("tests/README.md");
  });
});
