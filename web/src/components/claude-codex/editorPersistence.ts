/**
 * Storage helpers for the editor's "remember what I had open across
 * a refresh" behaviour. Pulled into its own module so the (pure)
 * serialisation logic can be unit-tested without touching `window`.
 *
 * State is keyed by workspace root so opening two different
 * workspaces in different tabs doesn't cross-contaminate. The shape
 * is intentionally tiny — we restore the open path and any unsaved
 * draft, and the snapshot we took of the on-disk file when the
 * draft was first authored. On reload we re-fetch the file and
 * compare `size`/`mtimeMs` to the snapshot so we can warn the
 * operator instead of silently overwriting on save.
 */

export interface PersistedSnapshot {
  size: number;
  mtimeMs: number;
}

export interface PersistedEditorState {
  /** Workspace-relative POSIX path of the open file (no leading `/`). */
  openPath: string;
  /** The dirty buffer, if any. Absent means "no unsaved changes". */
  draft?: string;
  /** Snapshot of the on-disk file at the time `draft` was authored. */
  baseline?: PersistedSnapshot;
}

const KEY_PREFIX = "claude-codex.editor:";

function storageKey(workspaceRoot: string): string {
  return `${KEY_PREFIX}${workspaceRoot}`;
}

/** Pure: turn a JSON blob into validated state, or null on any garbage. */
export function parsePersisted(raw: string | null): PersistedEditorState | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.openPath !== "string" || obj.openPath === "") return null;
  const out: PersistedEditorState = { openPath: obj.openPath };
  if (typeof obj.draft === "string") out.draft = obj.draft;
  const base = obj.baseline as Record<string, unknown> | undefined;
  if (
    base &&
    typeof base.size === "number" &&
    typeof base.mtimeMs === "number"
  ) {
    out.baseline = { size: base.size, mtimeMs: base.mtimeMs };
  }
  return out;
}

/**
 * Decide what to do when restoring a persisted draft against the
 * current on-disk snapshot. Pure helper — exported so the conflict
 * prompt's tri-state can be exhaustively tested.
 *
 *   - "no_draft":   nothing was unsaved; just reopen the file
 *   - "fast_path":  draft matches what's on disk; treat as clean
 *   - "unchanged":  baseline matches disk; restore draft as dirty
 *   - "conflict":   disk changed since we snapshotted; prompt user
 */
export function resolveRestore(
  state: PersistedEditorState,
  diskContent: string,
  diskSnapshot: PersistedSnapshot,
): "no_draft" | "fast_path" | "unchanged" | "conflict" {
  if (state.draft === undefined) return "no_draft";
  if (state.draft === diskContent) return "fast_path";
  if (
    state.baseline &&
    state.baseline.size === diskSnapshot.size &&
    state.baseline.mtimeMs === diskSnapshot.mtimeMs
  ) {
    return "unchanged";
  }
  return "conflict";
}

/* ---- Side-effecting wrappers (browser only) -------------------- */

export function loadPersisted(workspaceRoot: string): PersistedEditorState | null {
  if (typeof window === "undefined") return null;
  try {
    return parsePersisted(window.localStorage.getItem(storageKey(workspaceRoot)));
  } catch {
    return null;
  }
}

export function savePersisted(
  workspaceRoot: string,
  state: PersistedEditorState | null,
): void {
  if (typeof window === "undefined") return;
  try {
    if (!state) {
      window.localStorage.removeItem(storageKey(workspaceRoot));
    } else {
      window.localStorage.setItem(storageKey(workspaceRoot), JSON.stringify(state));
    }
  } catch {
    /* QuotaExceeded / private mode — degrade silently */
  }
}
