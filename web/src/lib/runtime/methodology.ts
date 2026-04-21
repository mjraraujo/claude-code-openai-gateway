/**
 * Methodology / dev-mode scaffolding registry.
 *
 * When the operator switches `harness.methodology` or `harness.devMode`
 * the dashboard materialises a small, opinionated set of starter
 * files into the active workspace. The seeding is **idempotent**:
 * existing files are never overwritten and the per-workspace
 * `ScaffoldRecord` ledger tracks which methodology/dev-mode has
 * already been seeded so repeated PATCHes are no-ops.
 *
 * Templates are inlined as string constants below — keeping them in
 * the bundle (rather than in a `templates/` directory loaded at
 * runtime) sidesteps the Next.js standalone-build asset-tracing
 * problem (the tracer doesn't follow dynamic `path.join` calls so
 * non-bundled `.md` files would be missing in production images).
 *
 * The actual write happens via the same `safeJoin()` surface the
 * chat / auto-drive harness uses, so path-traversal protection and
 * the active-workspace anchor are reused.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import { assertInsideWorkspace, safeJoin } from "@/lib/fs/workspace";

import { activeWorkspace, getStore, type RuntimeState } from "./store";

export interface ScaffoldFile {
  /** Destination path, relative to the workspace root. */
  path: string;
  /** Inline template content (UTF-8 text). */
  content: string;
}

export interface ScaffoldEntry {
  /** Stable id matching `harness.methodology` / `harness.devMode`. */
  id: string;
  /** Friendly display name shown in the toast. */
  name: string;
  files: ScaffoldFile[];
}

/* ─── Template literals (kept short — operators edit on disk) ───────── */

const SPEC_MD = `# Spec

> One-page description of the system this workspace builds.

## Problem
…

## Users
…

## Acceptance criteria
- [ ] …
`;

const DECISIONS_MD = `# Decisions

A running log of architectural decisions. New entries at the top.

## YYYY-MM-DD — title
**Context**

**Decision**

**Consequences**
`;

const EXAMPLE_FEATURE = `Feature: Example feature

  Scenario: a clear, testable behaviour
    Given a precondition
    When an action occurs
    Then an observable outcome holds
`;

const FEATURES_README = `# Features

Gherkin \`.feature\` files live under this directory. The dashboard's
Three Amigos panel reads them from here, and the auto-drive BDD
stage emits new ones via the \`feature_file\` planner tool.

Conventions:
- One \`Feature:\` per file.
- \`Scenario:\` titles describe an observable behaviour.
- Avoid \`And\` chains longer than ~5 steps — split into a second
  \`Scenario\` instead.
`;

const TESTS_README = `# Tests

This workspace follows TDD: write a failing test, make it pass,
refactor.

## Layout
- Unit tests next to the code they cover, suffix \`.test.<ext>\`.
- Cross-module tests under \`tests/integration/\`.

## Running
Use the project's existing runner — the dashboard's auto-drive loop
will detect common conventions (\`npm test\`, \`pytest\`, \`go test\`).
`;

const XP_PRACTICES = `# XP practices

This workspace is set up for Extreme Programming practices:
- Pair / mob programming as the default mode.
- Continuous integration: every push triggers the full test suite.
- Small releases: ship vertical slices, not big bangs.
- Refactor mercilessly — keep the design simple.
`;

const DEVMODE_DEFAULT = `# Dev mode notes

The active dev-mode setting (e.g. \`prototype\`, \`production\`,
\`hardening\`) controls how cautious the auto-drive planner is and
how deeply review steps gate progress. Document the current mode and
any per-workspace overrides here.
`;

/**
 * Registry of methodology templates. Add a new methodology by
 * adding an entry here.
 */
export const METHODOLOGY_REGISTRY: ScaffoldEntry[] = [
  {
    id: "spec-driven",
    name: "Spec-driven",
    files: [
      { path: "SPEC.md", content: SPEC_MD },
      { path: "DECISIONS.md", content: DECISIONS_MD },
    ],
  },
  {
    id: "bdd",
    name: "BDD",
    files: [
      { path: "features/example.feature", content: EXAMPLE_FEATURE },
      { path: "features/README.md", content: FEATURES_README },
    ],
  },
  {
    id: "tdd",
    name: "TDD",
    files: [{ path: "tests/README.md", content: TESTS_README }],
  },
  {
    id: "xp",
    name: "XP",
    files: [{ path: "PRACTICES.md", content: XP_PRACTICES }],
  },
];

/** Registry of dev-mode templates. Independent from methodology. */
export const DEVMODE_REGISTRY: ScaffoldEntry[] = [
  {
    id: "default",
    name: "Default",
    files: [{ path: "DEVMODE.md", content: DEVMODE_DEFAULT }],
  },
];

/** Result of scaffolding a single methodology / devMode change. */
export interface ScaffoldResult {
  workspaceId: string;
  entryId: string;
  filesCreated: string[];
  filesSkipped: string[];
}

/** Look up a registry entry by id; returns null when nothing matches. */
export function findMethodology(id: string | undefined): ScaffoldEntry | null {
  if (!id) return null;
  return METHODOLOGY_REGISTRY.find((m) => m.id === id) ?? null;
}

export function findDevMode(id: string | undefined): ScaffoldEntry | null {
  if (!id) return null;
  return DEVMODE_REGISTRY.find((m) => m.id === id) ?? null;
}

/**
 * Idempotent scaffolding of an entry's files into the active
 * workspace. Returns which files were created vs. skipped so the
 * caller can surface a toast.
 */
export async function scaffoldMethodology(
  state: RuntimeState,
  entry: ScaffoldEntry,
  kind: "methodology" | "devMode",
): Promise<ScaffoldResult> {
  const ws = activeWorkspace(state);
  const filesCreated: string[] = [];
  const filesSkipped: string[] = [];
  for (const f of entry.files) {
    let abs: string;
    try {
      abs = await safeJoin(f.path, { root: ws.root });
      assertInsideWorkspace(abs, ws.root);
    } catch {
      continue;
    }
    try {
      await fs.access(abs);
      filesSkipped.push(f.path);
      continue;
    } catch {
      /* doesn't exist — create */
    }
    try {
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, f.content, "utf8");
      filesCreated.push(f.path);
    } catch {
      /* non-fatal — the toast simply reports fewer files */
    }
  }

  await getStore().update((draft) => {
    let rec = draft.scaffolds.find((s) => s.workspaceId === ws.id);
    if (!rec) {
      rec = { workspaceId: ws.id, filesSeeded: [] };
      draft.scaffolds.push(rec);
    }
    if (kind === "methodology") rec.methodology = entry.id;
    else rec.devMode = entry.id;
    const seen = new Set(rec.filesSeeded ?? []);
    for (const f of filesCreated) seen.add(f);
    rec.filesSeeded = Array.from(seen).slice(0, 200);
  });

  return {
    workspaceId: ws.id,
    entryId: entry.id,
    filesCreated,
    filesSkipped,
  };
}
