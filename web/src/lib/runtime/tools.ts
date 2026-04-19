/**
 * Bounded tool surface available to the agent runtime.
 *
 * These wrap the same primitives as `/api/fs/*` and `/api/exec` so
 * that nothing the agent does can escape `safeJoin` or the exec
 * blocklist. They never execute on the request thread — callers
 * (the auto-drive loop, cron runners) invoke them directly.
 *
 * Each tool returns a `ToolResult` with `ok` and either `output` or
 * `error`. Output is truncated to keep the model context small and
 * prevent runaway memory growth.
 */

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";

import {
  assertInsideWorkspace,
  safeJoin,
  WORKSPACE_ROOT,
} from "@/lib/fs/workspace";

const MAX_READ_BYTES = 64 * 1024;
const MAX_WRITE_BYTES = 256 * 1024;
const MAX_EXEC_BYTES = 64 * 1024;
const EXEC_TIMEOUT_MS = 30_000;

const BLOCKED_COMMAND_PATTERNS = [
  "rm -rf /",
  "sudo ",
  ":(){",
  "mkfs",
  "shutdown",
  "reboot",
  "dd if=",
];

export interface ToolResult {
  ok: boolean;
  output?: string;
  error?: string;
  meta?: Record<string, unknown>;
}

export async function readFile(relPath: string): Promise<ToolResult> {
  if (typeof relPath !== "string" || relPath === "") {
    return { ok: false, error: "missing path" };
  }
  let abs: string;
  try {
    abs = await safeJoin(relPath);
    assertInsideWorkspace(abs);
  } catch {
    return { ok: false, error: "invalid path" };
  }
  try {
    const stat = await fs.stat(abs);
    if (!stat.isFile()) return { ok: false, error: "not a file" };
    const buf = Buffer.alloc(Math.min(stat.size, MAX_READ_BYTES));
    const fh = await fs.open(abs, "r");
    try {
      await fh.read(buf, 0, buf.length, 0);
    } finally {
      await fh.close();
    }
    const truncated = stat.size > MAX_READ_BYTES;
    return {
      ok: true,
      output: buf.toString("utf8") + (truncated ? `\n... [truncated, ${stat.size - MAX_READ_BYTES} bytes elided]` : ""),
      meta: { size: stat.size, truncated },
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function writeFile(
  relPath: string,
  content: string,
): Promise<ToolResult> {
  if (typeof relPath !== "string" || relPath === "") {
    return { ok: false, error: "missing path" };
  }
  if (typeof content !== "string") {
    return { ok: false, error: "content must be a string" };
  }
  if (Buffer.byteLength(content, "utf8") > MAX_WRITE_BYTES) {
    return { ok: false, error: "content too large" };
  }
  let abs: string;
  try {
    abs = await safeJoin(relPath);
    assertInsideWorkspace(abs);
  } catch {
    return { ok: false, error: "invalid path" };
  }
  try {
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat || !stat.isFile()) {
      return { ok: false, error: "refusing to create new file" };
    }
    await fs.writeFile(abs, content, "utf8");
    return { ok: true, output: `wrote ${Buffer.byteLength(content, "utf8")} bytes`, meta: { path: relPath } };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function execCommand(command: string): Promise<ToolResult> {
  if (typeof command !== "string" || command.trim() === "") {
    return { ok: false, error: "missing command" };
  }
  const cmd = command.trim();
  for (const bad of BLOCKED_COMMAND_PATTERNS) {
    if (cmd.includes(bad)) return { ok: false, error: "command blocked" };
  }

  return new Promise((resolve) => {
    const child = spawn("bash", ["-lc", cmd], {
      cwd: WORKSPACE_ROOT,
      env: { ...process.env, FORCE_COLOR: "0", TERM: "dumb" },
    });
    let bytes = 0;
    const chunks: Buffer[] = [];
    let truncated = false;

    const onData = (buf: Buffer) => {
      const remaining = MAX_EXEC_BYTES - bytes;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      const slice = buf.length > remaining ? buf.subarray(0, remaining) : buf;
      chunks.push(slice);
      bytes += slice.length;
      if (buf.length > remaining) truncated = true;
    };

    child.stdout.on("data", onData);
    child.stderr.on("data", onData);

    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
    }, EXEC_TIMEOUT_MS);

    child.on("error", (err) => {
      clearTimeout(timeout);
      resolve({ ok: false, error: err.message });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      const out = Buffer.concat(chunks).toString("utf8");
      const tail = truncated ? `\n... [truncated at ${MAX_EXEC_BYTES} bytes]` : "";
      resolve({
        ok: code === 0 && !signal,
        output: out + tail,
        error:
          signal != null
            ? `killed by ${signal}`
            : code !== 0
              ? `exit ${code}`
              : undefined,
        meta: { code, signal, bytes, truncated },
      });
    });
  });
}
