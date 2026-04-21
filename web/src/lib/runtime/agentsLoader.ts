/**
 * agents/*.md loader.
 *
 * Each workspace contains an `agents/` directory of editable
 * Markdown files; one file per agent, with YAML-ish frontmatter
 * declaring `name`, `role`, `model`, `skill`, and `tools`. The body
 * (Markdown after the closing `---`) becomes the agent's system
 * prompt verbatim.
 *
 * This module is small on purpose:
 *   - `parseAgentMarkdown(text, defaults)` is a pure parser used by
 *     tests and by the loader.
 *   - `loadAgentsFromWorkspace(root)` walks `<root>/agents/*.md` and
 *     returns the parsed records.
 *   - `seedDefaultAgents(root)` materialises the bundled default
 *     agents (Dev / QA / PO — the "Three Amigos" trio) into a
 *     workspace that doesn't yet have an `agents/` directory. It's
 *     idempotent — present files are never overwritten.
 *
 * The runtime store's `agents` array is populated separately by
 * the dashboard's existing harness; nothing here mutates state.
 * That means the loader can be called from a route, a test, or a
 * future polling watcher without coordination.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import { assertInsideWorkspace, safeJoin } from "@/lib/fs/workspace";

/** A single parsed agent spec. */
export interface MarkdownAgent {
  /** Canonical id, derived from the file name (e.g. `dev.md` → `dev`). */
  id: string;
  /** Display name from frontmatter, falling back to the id. */
  name: string;
  /** Free-form role string. */
  role?: string;
  /** Model id forwarded to the planner. */
  model?: string;
  /** Free-form skill summary. */
  skill?: string;
  /** Whitelist of tool ids the agent is allowed to call. */
  tools: string[];
  /** System-prompt body (Markdown after the frontmatter block). */
  prompt: string;
  /** Source path on disk. */
  filePath: string;
}

/** Bundled default agent specs (kept inline so they ship with the bundle). */
const DEFAULT_AGENTS: Array<{ file: string; content: string }> = [
  {
    file: "dev.md",
    content: `---
name: Dev
role: developer
model: gpt-5.3-codex
skill: implementation
tools: [read_file, write_file, exec]
---

# Dev

You are the Dev voice in the Three Amigos refinement. Push for
implementation feasibility:

- Is the story small enough to ship in a single sprint?
- Are there unstated dependencies on other systems?
- What would the first failing test look like?

Speak in code-review tone: short, concrete, willing to disagree.
`,
  },
  {
    file: "qa.md",
    content: `---
name: QA
role: quality
model: gpt-5.3-codex
skill: testing
tools: [read_file, exec]
---

# QA

You are the QA voice in the Three Amigos refinement. Push for
testability:

- What observable behaviour proves this story is done?
- Which edge cases will bite us?
- What's the simplest Given/When/Then we could automate?

Be concrete about test data and acceptance criteria.
`,
  },
  {
    file: "po.md",
    content: `---
name: PO
role: product
model: gpt-5.3-codex
skill: discovery
tools: [read_file]
---

# PO

You are the Product Owner voice in the Three Amigos refinement.
Push for value clarity:

- Which user is this story for, and what problem does it solve?
- What's the smallest version that delivers value?
- What does success look like in a metric we can measure?

Be willing to trade scope for clarity.
`,
  },
];

/** Maximum bytes we'll read from a single agent file (defends against runaway prompts). */
const MAX_AGENT_BYTES = 32 * 1024;

/**
 * Pure parser: split a Markdown agent spec into frontmatter +
 * body and validate the frontmatter fields. Exported for unit
 * tests; invalid input throws so the caller can decide how to
 * surface the error.
 */
export function parseAgentMarkdown(
  text: string,
  defaults: { id: string; filePath: string },
): MarkdownAgent {
  const fm = extractFrontmatter(text);
  const body = (fm ? fm.body : text).trim();
  const frontmatter = fm ? parseFrontmatterFields(fm.raw) : {};
  return {
    id: defaults.id,
    name: typeof frontmatter.name === "string" && frontmatter.name.trim()
      ? frontmatter.name.trim().slice(0, 64)
      : defaults.id,
    role: typeof frontmatter.role === "string" ? frontmatter.role.trim().slice(0, 64) : undefined,
    model: typeof frontmatter.model === "string" ? frontmatter.model.trim().slice(0, 64) : undefined,
    skill: typeof frontmatter.skill === "string" ? frontmatter.skill.trim().slice(0, 128) : undefined,
    tools: parseToolList(frontmatter.tools),
    prompt: body,
    filePath: defaults.filePath,
  };
}

/**
 * List + parse every `agents/*.md` file under a workspace. Files
 * that fail to parse are skipped (we log to stderr) so one broken
 * spec can't take the whole loader down.
 */
export async function loadAgentsFromWorkspace(
  workspaceRoot: string,
): Promise<MarkdownAgent[]> {
  let agentsDir: string;
  try {
    agentsDir = await safeJoin("agents", { root: workspaceRoot });
    assertInsideWorkspace(agentsDir, workspaceRoot);
  } catch {
    return [];
  }
  let entries: string[];
  try {
    entries = await fs.readdir(agentsDir);
  } catch {
    return [];
  }
  const out: MarkdownAgent[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".md")) continue;
    let abs: string;
    try {
      abs = await safeJoin(path.join("agents", entry), { root: workspaceRoot });
      assertInsideWorkspace(abs, workspaceRoot);
    } catch {
      continue;
    }
    let stat;
    try {
      stat = await fs.stat(abs);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size > MAX_AGENT_BYTES) continue;
    let text: string;
    try {
      text = await fs.readFile(abs, "utf8");
    } catch {
      continue;
    }
    try {
      out.push(
        parseAgentMarkdown(text, {
          id: entry.replace(/\.md$/, ""),
          filePath: abs,
        }),
      );
    } catch {
      /* skip broken file */
    }
  }
  return out;
}

/**
 * Seed the bundled default agents (Dev / QA / PO) into a workspace
 * that has no `agents/` directory yet. Idempotent: existing files
 * are never overwritten. Returns the list of files that were
 * created so the caller can surface a toast.
 */
export async function seedDefaultAgents(workspaceRoot: string): Promise<string[]> {
  const created: string[] = [];
  let agentsDir: string;
  try {
    agentsDir = await safeJoin("agents", { root: workspaceRoot });
    assertInsideWorkspace(agentsDir, workspaceRoot);
  } catch {
    return [];
  }
  await fs.mkdir(agentsDir, { recursive: true });
  for (const { file, content } of DEFAULT_AGENTS) {
    const dest = path.join(agentsDir, file);
    try {
      await fs.access(dest);
      continue; // already exists
    } catch {
      /* missing */
    }
    try {
      await fs.writeFile(dest, content, "utf8");
      created.push(`agents/${file}`);
    } catch {
      /* skip */
    }
  }
  return created;
}

/* ─── Frontmatter helpers (kept tiny — no yaml dep) ────────────────── */

function extractFrontmatter(text: string): { raw: string; body: string } | null {
  if (!text.startsWith("---")) return null;
  // Find the closing `---` on its own line (with optional CRLF).
  const closeRe = /^---\s*$/m;
  const rest = text.slice(3);
  const m = rest.match(closeRe);
  if (!m || m.index === undefined) return null;
  const raw = rest.slice(0, m.index);
  const body = rest.slice(m.index + m[0].length);
  return { raw, body };
}

/**
 * Parse a tiny subset of YAML — `key: value` pairs, with values
 * being either bare strings or `[a, b, c]` flow lists. We only
 * care about a handful of fields, so a 30-line parser beats taking
 * on a full YAML dependency.
 */
function parseFrontmatterFields(raw: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    let value: string = line.slice(colon + 1).trim();
    // Strip surrounding quotes if present.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function parseToolList(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  const trimmed = raw.trim();
  // Flow-style list: `[a, b, c]`
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed
      .slice(1, -1)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 16);
  }
  // CSV fallback: `read_file, exec`
  return trimmed
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 16);
}
