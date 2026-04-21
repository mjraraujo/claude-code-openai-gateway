/**
 * Bounded tool surface available to the agent runtime.
 *
 * These wrap the same primitives as `/api/fs/*` and `/api/exec` so
 * that nothing the agent does can escape `safeJoin` or the exec
 * blocklist. They never execute on the request thread — callers
 * (the auto-drive loop, cron runners, the chat agent loop) invoke
 * them directly.
 *
 * Each tool returns a `ToolResult` with `ok` and either `output` or
 * `error`. The error envelope includes a stable `code` and an
 * actionable `hint` so the planner can recover from common mistakes
 * (`/workspace/...` prefixed paths, missing parent dirs, etc.) on
 * its next step instead of giving up.
 *
 * Output is truncated to keep the model context small and prevent
 * runaway memory growth.
 */

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  assertInsideWorkspace,
  getActiveWorkspaceRoot,
  normaliseUserPath,
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
  /** Stable machine-readable error code. Present iff `ok === false`. */
  code?: ToolErrorCode;
  /** One-line operator/planner-facing hint about how to recover. */
  hint?: string;
  meta?: Record<string, unknown>;
}

export type ToolErrorCode =
  | "missing_path"
  | "missing_command"
  | "invalid_path"
  | "absolute_path"
  | "parent_traversal"
  | "not_a_file"
  | "content_not_string"
  | "content_too_large"
  | "io_error"
  | "command_blocked"
  | "exec_timeout"
  | "exec_killed"
  | "exec_failed";

/**
 * Build a `ToolResult` failure with the standard envelope. Centralised
 * so every tool surfaces the same shape and the chat / auto-drive
 * loops have a single error vocabulary to format and recover from.
 */
function fail(code: ToolErrorCode, error: string, hint?: string, meta?: Record<string, unknown>): ToolResult {
  return { ok: false, code, error, hint, meta };
}

/**
 * Pre-process a planner-supplied path before handing it to
 * `safeJoin`. Returns either `{ ok: true, rel }` carrying the
 * cleaned relative path, or a failure envelope.
 *
 * - Empty / non-string inputs → `missing_path`.
 * - Absolute paths after stripping the conventional
 *   `/workspace/` (or active root) prefix → `absolute_path`.
 * - `..` segments after normalisation → `parent_traversal`.
 */
async function resolveUserPath(
  relPath: string,
  root: string,
): Promise<
  | { ok: true; rel: string }
  | { ok: false; result: ToolResult }
> {
  if (typeof relPath !== "string" || relPath.trim() === "") {
    return {
      ok: false,
      result: fail("missing_path", "missing path", "supply a workspace-relative path, e.g. 'src/app.ts'"),
    };
  }
  const cleaned = normaliseUserPath(relPath, root);
  if (cleaned === "") {
    // The whole path collapsed to the workspace root itself — fine
    // for read/exec but not for write.
    return { ok: true, rel: "" };
  }
  if (path.isAbsolute(cleaned)) {
    return {
      ok: false,
      result: fail(
        "absolute_path",
        `absolute path not allowed: ${relPath}`,
        "use a path relative to the workspace root (drop the leading '/'). The workspace root is the implicit base.",
      ),
    };
  }
  if (cleaned.split(/[\\/]/).some((seg) => seg === "..")) {
    return {
      ok: false,
      result: fail(
        "parent_traversal",
        `parent traversal not allowed: ${relPath}`,
        "remove '..' segments — the workspace is sealed.",
      ),
    };
  }
  return { ok: true, rel: cleaned };
}

export async function readFile(relPath: string): Promise<ToolResult> {
  const root = await getActiveWorkspaceRoot();
  const resolved = await resolveUserPath(relPath, root);
  if (!resolved.ok) return resolved.result;
  let abs: string;
  try {
    abs = await safeJoin(resolved.rel, { root });
    assertInsideWorkspace(abs, root);
  } catch {
    return fail(
      "invalid_path",
      "invalid path",
      "the path resolved outside the workspace (symlink?). Use a plain relative path.",
    );
  }
  try {
    const stat = await fs.stat(abs);
    if (!stat.isFile()) {
      return fail(
        "not_a_file",
        "not a file",
        "the path exists but is not a regular file (directory?). Use exec('ls …') to inspect it.",
      );
    }
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
      output:
        buf.toString("utf8") +
        (truncated
          ? `\n... [truncated, ${stat.size - MAX_READ_BYTES} bytes elided]`
          : ""),
      meta: { size: stat.size, truncated },
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return fail(
        "io_error",
        `file not found: ${resolved.rel}`,
        "double-check the path or list the directory with exec('ls -la <dir>').",
        { errno: code },
      );
    }
    return fail("io_error", (err as Error).message, "filesystem error — see meta.errno", { errno: code });
  }
}

export async function writeFile(
  relPath: string,
  content: string,
): Promise<ToolResult> {
  const root = await getActiveWorkspaceRoot();
  const resolved = await resolveUserPath(relPath, root);
  if (!resolved.ok) return resolved.result;
  if (resolved.rel === "") {
    return fail("missing_path", "missing path", "supply a file path, not the workspace root.");
  }
  if (typeof content !== "string") {
    return fail("content_not_string", "content must be a string", "pass content as a string (not undefined / not an object).");
  }
  if (Buffer.byteLength(content, "utf8") > MAX_WRITE_BYTES) {
    return fail(
      "content_too_large",
      `content too large (${Buffer.byteLength(content, "utf8")} > ${MAX_WRITE_BYTES} bytes)`,
      "split the change across multiple smaller writes.",
    );
  }
  let abs: string;
  try {
    abs = await safeJoin(resolved.rel, { root });
    assertInsideWorkspace(abs, root);
  } catch {
    return fail(
      "invalid_path",
      "invalid path",
      "the path resolved outside the workspace. Use a plain relative path.",
    );
  }
  try {
    const stat = await fs.stat(abs).catch(() => null);
    if (stat && !stat.isFile()) {
      return fail(
        "not_a_file",
        "destination exists but is not a regular file",
        "pick a different path — the destination is a directory or special file.",
      );
    }
    // Auto-create parent directories for new files. This is the
    // behaviour every other "write text to a workspace file" surface
    // (the /api/fs/write route) has, and it's why the chat tool
    // harness used to give up with "refusing to create new file" —
    // the planner's reasonable next step (write a *new* file) was
    // forbidden. We still validate containment via safeJoin above.
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf8");
    return {
      ok: true,
      output: `${stat ? "updated" : "created"} ${resolved.rel} (${Buffer.byteLength(content, "utf8")} bytes)`,
      meta: { path: resolved.rel, created: !stat },
    };
  } catch (err) {
    return fail("io_error", (err as Error).message, "filesystem error — see meta.errno", {
      errno: (err as NodeJS.ErrnoException).code,
    });
  }
}

export async function execCommand(command: string): Promise<ToolResult> {
  if (typeof command !== "string" || command.trim() === "") {
    return fail("missing_command", "missing command", "supply a non-empty bash command.");
  }
  const cmd = command.trim();
  for (const bad of BLOCKED_COMMAND_PATTERNS) {
    if (cmd.includes(bad)) {
      return fail(
        "command_blocked",
        `command blocked: contains pattern '${bad}'`,
        "the dashboard refuses destructive / privilege-escalation commands. Use a safer alternative.",
      );
    }
  }

  const root = await getActiveWorkspaceRoot();
  return new Promise((resolve) => {
    const child = spawn("bash", ["-lc", cmd], {
      cwd: root,
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

    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, EXEC_TIMEOUT_MS);

    child.on("error", (err) => {
      clearTimeout(timeout);
      resolve(fail("exec_failed", err.message, "could not spawn bash — check the runtime environment.", { errno: (err as NodeJS.ErrnoException).code }));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      const out = Buffer.concat(chunks).toString("utf8");
      const tail = truncated ? `\n... [truncated at ${MAX_EXEC_BYTES} bytes]` : "";
      if (code === 0 && !signal) {
        resolve({
          ok: true,
          output: out + tail,
          meta: { code, signal, bytes, truncated },
        });
        return;
      }
      // Failure path — pick the most specific code/hint.
      if (timedOut) {
        resolve(fail(
          "exec_timeout",
          `command timed out after ${EXEC_TIMEOUT_MS}ms`,
          "split the work into smaller commands or run long jobs via cron / auto-drive instead of synchronously.",
          { code, signal, bytes, truncated, output: out + tail },
        ));
        return;
      }
      if (signal != null) {
        resolve(fail(
          "exec_killed",
          `killed by ${signal}`,
          "the process was terminated. If this happens repeatedly the command is being killed by the OS — try a less memory-hungry alternative.",
          { code, signal, bytes, truncated, output: out + tail },
        ));
        return;
      }
      // Non-zero exit: include the captured output as the error
      // body so the planner can act on what the command actually
      // printed (e.g. a TypeScript compile error). Status code 243
      // is the classic "shell exit truncated to 8 bits" — call that
      // out explicitly so the planner can adapt instead of looping.
      const hint =
        code === 243
          ? "exit 243 = process killed (likely by OOM or signal). Try a smaller workload."
          : code != null && code >= 126
            ? "non-zero exit (>=126 usually means 'permission denied' or 'command not found'). Verify the binary is installed and on PATH."
            : "command exited non-zero — inspect the captured output (shown as 'error') and try a different approach.";
      resolve(fail(
        "exec_failed",
        `exit ${code}${out ? "\n" + (out + tail) : ""}`,
        hint,
        { code, signal, bytes, truncated },
      ));
    });
  });
}

/**
 * Write a Gherkin .feature file to disk for the BDD stage of the
 * endless drive. Distinct from `writeFile` because it forces the
 * path into a `features/` subtree and ensures the `.feature`
 * extension; the regular `writeFile` is now also create-on-write so
 * the two share most of the underlying behaviour.
 *
 * Path safety: still goes through `safeJoin` so a malicious planner
 * can't break out of the workspace via `../`.
 */
export async function writeFeatureFile(
  relPath: string,
  content: string,
): Promise<ToolResult> {
  if (typeof relPath !== "string" || relPath === "") {
    return fail("missing_path", "missing path", "supply a feature file name, e.g. 'login.feature'.");
  }
  if (typeof content !== "string") {
    return fail("content_not_string", "content must be a string");
  }
  if (Buffer.byteLength(content, "utf8") > MAX_WRITE_BYTES) {
    return fail("content_too_large", "content too large", "split into multiple smaller features.");
  }
  // Force the file into a `features/` subtree to keep BDD specs in
  // the conventional location and out of arbitrary parts of the
  // workspace. `path.posix.normalize` collapses any `..` segments
  // before we re-prefix.
  const root = await getActiveWorkspaceRoot();
  let rel = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  // Strip a leading copy of the active root or `/workspace/` for
  // consistency with the other tools.
  rel = normaliseUserPath(rel, root) || rel;
  if (!rel.startsWith("features/")) rel = path.posix.join("features", rel);
  if (!rel.endsWith(".feature")) rel = `${rel}.feature`;
  let abs: string;
  try {
    abs = await safeJoin(rel, { root });
    assertInsideWorkspace(abs, root);
  } catch {
    return fail("invalid_path", "invalid path", "use a plain relative feature path under features/.");
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
    return fail("io_error", (err as Error).message, "filesystem error", {
      errno: (err as NodeJS.ErrnoException).code,
    });
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

/**
 * Three Amigos AI BDD validation. Wrapper around `runAmigos()` so
 * the same code path is shared between the dashboard "▶ Run" button
 * and any future planner action that needs to gate the SDLC `bdd`
 * stage on a static review verdict. Returns a one-line summary as
 * `output` so the auto-drive transcript stays compact.
 */
export async function runAmigosTool(
  target: { type: "all" } | { type: "feature"; path: string },
  model: string,
): Promise<ToolResult> {
  const { runAmigos, overallVerdict } = await import("./amigos");
  try {
    const report = await runAmigos({ scope: target, model });
    if (report.error) {
      return fail("io_error", report.error, "amigos run failed — see meta.report", { report });
    }
    const verdict = overallVerdict(report);
    const summary = `amigos ${verdict}: ${report.pass}/${report.scanned} pass, ${report.concerns} concerns, ${report.fail} fail`;
    return {
      // A "concerns" verdict is still a successful run — gating is
      // up to the caller (e.g. the SDLC planner action).
      ok: verdict !== "fail",
      output: summary,
      meta: { report, verdict },
    };
  } catch (err) {
    return fail("io_error", (err as Error).message);
  }
}

// `WORKSPACE_ROOT` re-export for consumers (e.g. cron) that still
// reference the env-derived constant. The active workspace root is
// preferred for new code via `getActiveWorkspaceRoot()`.
export { WORKSPACE_ROOT };
