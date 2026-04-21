/**
 * Tests for the runtime tool harness — the single surface every
 * agent (auto-drive, cron, chat) goes through to touch the
 * filesystem or run shell commands.
 *
 * The headline behaviour we verify here is the bug fix from the
 * problem statement: `writeFile` MUST be able to create new files
 * (the old behaviour returned "refusing to create new file" which
 * caused the chat planner to give up). We also exercise the new
 * actionable error envelopes (`code` + `hint`) and the
 * `/workspace/...` path-prefix normalisation.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mc-tools-test-"));
  workspace = await fs.realpath(workspace);
  process.env.MISSION_CONTROL_WORKSPACE = workspace;
  // Point the runtime store at a fresh dir so its DEFAULT_WORKSPACE_ROOT
  // resolves to the same place we set above.
  process.env.CODEX_GATEWAY_CONFIG_DIR = await fs.mkdtemp(
    path.join(os.tmpdir(), "mc-tools-cfg-"),
  );
  vi.resetModules();
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
  if (process.env.CODEX_GATEWAY_CONFIG_DIR) {
    await fs.rm(process.env.CODEX_GATEWAY_CONFIG_DIR, {
      recursive: true,
      force: true,
    });
  }
  delete process.env.MISSION_CONTROL_WORKSPACE;
  delete process.env.CODEX_GATEWAY_CONFIG_DIR;
});

async function importTools() {
  return await import("./tools");
}

describe("tools.writeFile", () => {
  it("creates new files (regression: used to refuse with 'refusing to create new file')", async () => {
    const tools = await importTools();
    const res = await tools.writeFile("hello.md", "# hi\n");
    expect(res.ok).toBe(true);
    expect(res.meta?.created).toBe(true);
    const onDisk = await fs.readFile(path.join(workspace, "hello.md"), "utf8");
    expect(onDisk).toBe("# hi\n");
  });

  it("auto-creates missing parent directories", async () => {
    const tools = await importTools();
    const res = await tools.writeFile("deep/nested/dir/note.txt", "x");
    expect(res.ok).toBe(true);
    const onDisk = await fs.readFile(
      path.join(workspace, "deep/nested/dir/note.txt"),
      "utf8",
    );
    expect(onDisk).toBe("x");
  });

  it("strips a leading /workspace/ prefix the planner often emits", async () => {
    const tools = await importTools();
    const res = await tools.writeFile("/workspace/notes.md", "ok");
    expect(res.ok).toBe(true);
    const onDisk = await fs.readFile(path.join(workspace, "notes.md"), "utf8");
    expect(onDisk).toBe("ok");
  });

  it("returns an actionable error envelope for absolute paths", async () => {
    const tools = await importTools();
    const res = await tools.writeFile("/etc/passwd", "boom");
    expect(res.ok).toBe(false);
    expect(res.code).toBe("absolute_path");
    expect(res.hint).toMatch(/relative/);
  });

  it("rejects parent-directory traversal with a clear code", async () => {
    const tools = await importTools();
    const res = await tools.writeFile("../escape.txt", "boom");
    expect(res.ok).toBe(false);
    expect(res.code).toBe("parent_traversal");
  });

  it("reports content_too_large with code instead of opaque error", async () => {
    const tools = await importTools();
    const huge = "x".repeat(300_000);
    const res = await tools.writeFile("big.txt", huge);
    expect(res.ok).toBe(false);
    expect(res.code).toBe("content_too_large");
  });

  it("updates an existing file (created:false in meta)", async () => {
    const tools = await importTools();
    await fs.writeFile(path.join(workspace, "existing.md"), "old");
    const res = await tools.writeFile("existing.md", "new");
    expect(res.ok).toBe(true);
    expect(res.meta?.created).toBe(false);
    const onDisk = await fs.readFile(path.join(workspace, "existing.md"), "utf8");
    expect(onDisk).toBe("new");
  });
});

describe("tools.readFile", () => {
  it("reads a file inside the workspace", async () => {
    const tools = await importTools();
    await fs.writeFile(path.join(workspace, "readme.txt"), "hello");
    const res = await tools.readFile("readme.txt");
    expect(res.ok).toBe(true);
    expect(res.output).toBe("hello");
  });

  it("returns code=io_error with a useful hint when the file is missing", async () => {
    const tools = await importTools();
    const res = await tools.readFile("nope.txt");
    expect(res.ok).toBe(false);
    expect(res.code).toBe("io_error");
    expect(res.hint).toMatch(/list/);
  });

  it("returns code=missing_path on empty input", async () => {
    const tools = await importTools();
    const res = await tools.readFile("");
    expect(res.ok).toBe(false);
    expect(res.code).toBe("missing_path");
  });

  it("strips leading /workspace/ from read paths too", async () => {
    const tools = await importTools();
    await fs.writeFile(path.join(workspace, "doc.md"), "hello");
    const res = await tools.readFile("/workspace/doc.md");
    expect(res.ok).toBe(true);
    expect(res.output).toBe("hello");
  });
});

describe("tools.execCommand", () => {
  it("runs a simple command in the workspace cwd", async () => {
    const tools = await importTools();
    await fs.writeFile(path.join(workspace, "marker"), "");
    const res = await tools.execCommand("ls");
    expect(res.ok).toBe(true);
    expect(res.output ?? "").toContain("marker");
  });

  it("rejects blocked patterns with code=command_blocked", async () => {
    const tools = await importTools();
    const res = await tools.execCommand("sudo whoami");
    expect(res.ok).toBe(false);
    expect(res.code).toBe("command_blocked");
  });

  it("captures non-zero exit and emits an actionable hint", async () => {
    const tools = await importTools();
    const res = await tools.execCommand("bash -c 'exit 7'");
    expect(res.ok).toBe(false);
    expect(res.code).toBe("exec_failed");
    expect(res.hint).toBeTruthy();
  });
});
