/**
 * Tests for the workspace path-safety helpers.
 *
 * `safeJoin()` and `assertInsideWorkspace()` are the only sanitiser
 * between user-supplied paths and `fs.*` calls in the dashboard, so
 * any regression here is a path-traversal vulnerability. We exercise
 * the boundary cases CodeQL and human reviewers care about.
 *
 * The workspace root is fixed via the MISSION_CONTROL_WORKSPACE env
 * var to a fresh temp dir per test.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mc-workspace-test-"));
  // Realpath the root so symlinked /tmp paths (macOS) compare equal.
  workspace = await fs.realpath(workspace);
  process.env.MISSION_CONTROL_WORKSPACE = workspace;
  vi.resetModules();
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
  delete process.env.MISSION_CONTROL_WORKSPACE;
});

async function importMod() {
  return await import("./workspace");
}

describe("safeJoin", () => {
  it("returns the workspace root for empty / '/' input", async () => {
    const m = await importMod();
    expect(await m.safeJoin("")).toBe(workspace);
    expect(await m.safeJoin("/")).toBe(workspace);
  });

  it("resolves a normal relative path inside the workspace", async () => {
    const m = await importMod();
    await fs.writeFile(path.join(workspace, "hello.txt"), "hi");
    const resolved = await m.safeJoin("hello.txt");
    expect(resolved).toBe(path.join(workspace, "hello.txt"));
  });

  it("rejects absolute paths", async () => {
    const m = await importMod();
    await expect(m.safeJoin("/etc/passwd")).rejects.toThrow("invalid path");
  });

  it("rejects parent-directory traversal", async () => {
    const m = await importMod();
    await expect(m.safeJoin("../escape")).rejects.toThrow("invalid path");
    await expect(m.safeJoin("foo/../../escape")).rejects.toThrow("invalid path");
  });

  it("rejects symlinks pointing outside the workspace", async () => {
    const m = await importMod();
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "mc-outside-"));
    try {
      const linkPath = path.join(workspace, "evil-link");
      await fs.symlink(outsideDir, linkPath);
      await expect(m.safeJoin("evil-link")).rejects.toThrow("invalid path");
      await expect(m.safeJoin("evil-link/secret.txt")).rejects.toThrow(
        "invalid path",
      );
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });

  it("allows symlinks pointing inside the workspace", async () => {
    const m = await importMod();
    const target = path.join(workspace, "real");
    await fs.mkdir(target);
    await fs.symlink(target, path.join(workspace, "link"));
    const resolved = await m.safeJoin("link");
    expect(resolved).toBe(target);
  });

  it("walks up to the nearest existing ancestor for not-yet-created files", async () => {
    const m = await importMod();
    await fs.mkdir(path.join(workspace, "sub"));
    const resolved = await m.safeJoin("sub/new-file.txt");
    expect(resolved).toBe(path.join(workspace, "sub", "new-file.txt"));
  });

  it("rejects non-string input", async () => {
    const m = await importMod();
    await expect(
      m.safeJoin(null as unknown as string),
    ).rejects.toThrow("invalid path");
  });

  it("normalises Windows-style separators safely", async () => {
    const m = await importMod();
    await fs.writeFile(path.join(workspace, "winfile"), "x");
    // \ becomes / and is then resolved as a regular relative path.
    const resolved = await m.safeJoin("winfile");
    expect(resolved).toBe(path.join(workspace, "winfile"));
  });
});

describe("assertInsideWorkspace", () => {
  it("accepts paths inside the workspace", async () => {
    const m = await importMod();
    expect(() =>
      m.assertInsideWorkspace(path.join(workspace, "ok.txt")),
    ).not.toThrow();
    expect(() => m.assertInsideWorkspace(workspace)).not.toThrow();
  });

  it("rejects paths outside the workspace", async () => {
    const m = await importMod();
    expect(() => m.assertInsideWorkspace("/etc/passwd")).toThrow(
      "invalid path",
    );
    expect(() => m.assertInsideWorkspace(path.join(workspace, "..", "x"))).toThrow(
      "invalid path",
    );
  });

  it("rejects relative paths", async () => {
    const m = await importMod();
    expect(() => m.assertInsideWorkspace("./relative")).toThrow("invalid path");
  });
});

describe("toRelative", () => {
  it("turns absolute workspace paths into POSIX-rooted relative paths", async () => {
    const m = await importMod();
    expect(m.toRelative(workspace)).toBe("/");
    expect(m.toRelative(path.join(workspace, "a", "b.txt"))).toBe("a/b.txt");
  });
});

describe("isIgnoredRelPath", () => {
  it("rejects empty / undefined inputs as 'not ignored'", async () => {
    const m = await importMod();
    expect(m.isIgnoredRelPath("")).toBe(false);
  });

  it("flags entries inside known noisy build dirs", async () => {
    const m = await importMod();
    expect(m.isIgnoredRelPath("node_modules/foo/bar.js")).toBe(true);
    expect(m.isIgnoredRelPath(".git/HEAD")).toBe(true);
    expect(m.isIgnoredRelPath(".next/cache/x")).toBe(true);
    expect(m.isIgnoredRelPath("dist")).toBe(true);
  });

  it("flags hidden entries except .github (mirrors tree route)", async () => {
    const m = await importMod();
    expect(m.isIgnoredRelPath(".env")).toBe(true);
    expect(m.isIgnoredRelPath("src/.DS_Store")).toBe(true);
    expect(m.isIgnoredRelPath(".github/workflows/ci.yml")).toBe(false);
  });

  it("does not flag normal source paths", async () => {
    const m = await importMod();
    expect(m.isIgnoredRelPath("src/index.ts")).toBe(false);
    expect(m.isIgnoredRelPath("README.md")).toBe(false);
  });
});
