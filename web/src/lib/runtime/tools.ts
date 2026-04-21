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
import path from "node:path";

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

/**
 * Write a Gherkin .feature file to disk for the BDD stage of the
 * endless drive. Distinct from `writeFile` because it auto-creates
 * the file (regular `writeFile` refuses to create new files for
 * safety) and forces the path under `features/`.
 *
 * Path safety: still goes through `safeJoin` so a malicious planner
 * can't break out of the workspace via `../`.
 */
export async function writeFeatureFile(
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
  // Force the file into a `features/` subtree to keep BDD specs in
  // the conventional location and out of arbitrary parts of the
  // workspace. `path.posix.normalize` collapses any `..` segments
  // before we re-prefix.
  let rel = relPath.replace(/^\/+/, "");
  if (!rel.startsWith("features/")) rel = path.posix.join("features", rel);
  if (!rel.endsWith(".feature")) rel = `${rel}.feature`;
  let abs: string;
  try {
    abs = await safeJoin(rel);
    assertInsideWorkspace(abs);
  } catch {
    return { ok: false, error: "invalid path" };
  }
  try {
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf8");
    return {
      ok: true,
      output: `wrote ${Buffer.byteLength(content, "utf8")} bytes to ${rel}`,
      meta: { path: rel },
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * Run cucumber-js against the workspace's `features/` directory (or
 * a caller-supplied path). Thin wrapper over `execCommand` so the
 * existing timeout / output-cap logic applies.
 */
export async function runCucumber(featuresPath?: string): Promise<ToolResult> {
  const arg = sanitizeRelArg(featuresPath) ?? "features";
  return execCommand(`npx --yes cucumber-js ${arg}`);
}

/**
 * Run the configured deploy command. Operators set
 * `CLAUDE_CODEX_DEPLOY_CMD` to whatever is appropriate for their
 * project (`fly deploy`, `kubectl apply -f k8s/`, `gh workflow run
 * deploy.yml`, etc.). Defaults to `fly deploy` since that's what the
 * gateway's own infra uses.
 */
export async function runDeploy(environment?: string): Promise<ToolResult> {
  const base = process.env.CLAUDE_CODEX_DEPLOY_CMD || "fly deploy";
  const env = sanitizeRelArg(environment);
  const cmd = env ? `${base} ${env}` : base;
  return execCommand(cmd);
}

/**
 * Strip whitespace and bash metacharacters from a planner-supplied
 * argument. Returns `null` when the result is empty so callers can
 * easily detect "no value supplied".
 */
function sanitizeRelArg(raw: string | undefined): string | null {
  if (typeof raw !== "string") return null;
  // Allow paths and simple option-style words; drop everything that
  // would let a malicious planner inject extra commands.
  const cleaned = raw.replace(/[^A-Za-z0-9_./:=@\-]/g, "").trim();
  return cleaned || null;
}
