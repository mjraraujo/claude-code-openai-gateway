/**
 * Pure state helpers for the multi-terminal tab bar.
 *
 * Kept free of React so the rules — never zero tabs, hard cap on
 * concurrent terminals, sensible "next active" pick when the active
 * tab is closed — can be unit-tested in isolation. The component
 * (`TerminalTabs.tsx`) wires these into `useState`.
 */

export interface TerminalTab {
  /** Stable id used as React key + as the route into per-tab state. */
  id: string;
  /** Human label shown in the tab strip. Editable via renameTab(). */
  label: string;
  /**
   * Which view to render for this tab.
   *   - "claude": interactive xterm.js + node-pty session running the
   *     bundled `claude-codex` CLI (or whatever `CLAUDE_CODEX_PTY_BIN`
   *     points at). Default for the first tab.
   *   - "shell": the existing non-interactive `bash -lc` SSE shell.
   *
   * Persisted in tab state so the tab strip can render an icon and so
   * a re-render of `TerminalTabs` mounts the right component.
   */
  kind: TerminalTabKind;
  /**
   * Server-side PTY id this tab is currently bound to (claude tabs
   * only). Persisted across page reloads in `localStorage` so a
   * refresh can reattach to the same `claude` REPL instead of
   * spawning a fresh one. May be undefined for a brand-new tab that
   * hasn't received its session id yet, or for any "shell" tab
   * (the non-interactive shell has no persistent server state).
   */
  sessionId?: string;
}

export type TerminalTabKind = "claude" | "shell";

export interface TabsState {
  tabs: TerminalTab[];
  activeId: string;
  /** Monotonic counter used to mint default labels ("Shell 2", "Shell 3" …). */
  nextLabelN: number;
}

/**
 * Hard upper bound on concurrent terminals. Each terminal owns an
 * SSE connection to /api/exec and a scrollback buffer; eight is
 * generous for a single operator and stops a runaway "+" click from
 * exhausting the browser's per-origin connection pool.
 */
export const MAX_TERMINALS = 8;

let idSeq = 0;
function newTabId(): string {
  idSeq += 1;
  return `term-${Date.now().toString(36)}-${idSeq.toString(36)}`;
}

export function initialTabsState(): TabsState {
  // Tab 0 defaults to the interactive Claude PTY so opening the
  // dashboard drops the operator straight into `claude-codex`. The
  // "+ shell" button still creates plain bash tabs.
  const first: TerminalTab = {
    id: newTabId(),
    label: "claude",
    kind: "claude",
  };
  return { tabs: [first], activeId: first.id, nextLabelN: 2 };
}

/** Add a new tab (capped at MAX_TERMINALS) and focus it. Defaults to a shell tab. */
export function addTab(state: TabsState, kind: TerminalTabKind = "shell"): TabsState {
  if (state.tabs.length >= MAX_TERMINALS) return state;
  const tab: TerminalTab = {
    id: newTabId(),
    label: kind === "claude" ? "claude" : `Shell ${state.nextLabelN}`,
    kind,
  };
  return {
    tabs: [...state.tabs, tab],
    activeId: tab.id,
    // Only bump the shell counter so the labels stay sequential
    // even after a "+ claude" insertion.
    nextLabelN: kind === "shell" ? state.nextLabelN + 1 : state.nextLabelN,
  };
}

/**
 * Close `id`. Refuses to close the last remaining tab (the dock
 * always has at least one terminal). When the active tab is closed,
 * focus moves to the neighbour on the right, falling back to the
 * left if the closed tab was the rightmost.
 */
export function closeTab(state: TabsState, id: string): TabsState {
  if (state.tabs.length <= 1) return state;
  const idx = state.tabs.findIndex((t) => t.id === id);
  if (idx === -1) return state;
  const remaining = state.tabs.slice(0, idx).concat(state.tabs.slice(idx + 1));
  let activeId = state.activeId;
  if (state.activeId === id) {
    const nextIdx = idx < remaining.length ? idx : remaining.length - 1;
    activeId = remaining[nextIdx].id;
  }
  return { ...state, tabs: remaining, activeId };
}

/** Make `id` active. No-op if `id` is unknown. */
export function selectTab(state: TabsState, id: string): TabsState {
  if (state.activeId === id) return state;
  if (!state.tabs.some((t) => t.id === id)) return state;
  return { ...state, activeId: id };
}

/**
 * Rename `id`. Empty / whitespace-only input is rejected (the tab
 * keeps its previous label) and labels are capped at 40 chars to
 * stop the tab strip from blowing out horizontally.
 */
export function renameTab(state: TabsState, id: string, label: string): TabsState {
  const clean = label.trim().slice(0, 40);
  if (!clean) return state;
  const tabs = state.tabs.map((t) => (t.id === id ? { ...t, label: clean } : t));
  return { ...state, tabs };
}

/**
 * Attach (or clear) the server-side PTY session id for a tab. Used
 * when {@link import("./ClaudeTerminalView").default} either creates
 * a new session or discovers that its previously-persisted session
 * is gone (so we can fall back to spawning a fresh one).
 */
export function setTabSessionId(
  state: TabsState,
  id: string,
  sessionId: string | undefined,
): TabsState {
  let changed = false;
  const tabs = state.tabs.map((t) => {
    if (t.id !== id) return t;
    if (t.sessionId === sessionId) return t;
    changed = true;
    if (sessionId === undefined) {
      const { sessionId: _drop, ...rest } = t;
      void _drop;
      return rest as TerminalTab;
    }
    return { ...t, sessionId };
  });
  return changed ? { ...state, tabs } : state;
}

/* -------- Persistence (localStorage) ----------------------------- */

/**
 * Storage key for the persisted tab list. Single-user dashboard so
 * one global key is fine; if we ever support multiple workspaces
 * the suffix can carry the workspace root.
 */
export const TABS_STORAGE_KEY = "claude-codex.terminal.tabs";

/**
 * Pure parser for the persisted blob — exported for tests so we can
 * exercise the validation without touching `window`. Drops anything
 * that doesn't look like a {@link TabsState}; never throws.
 */
export function parseTabsState(raw: string | null): TabsState | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const tabsRaw = obj.tabs;
  const activeId = obj.activeId;
  const nextLabelN = obj.nextLabelN;
  if (!Array.isArray(tabsRaw)) return null;
  if (typeof activeId !== "string") return null;
  if (typeof nextLabelN !== "number" || !Number.isFinite(nextLabelN)) return null;
  const tabs: TerminalTab[] = [];
  for (const t of tabsRaw) {
    if (!t || typeof t !== "object") continue;
    const o = t as Record<string, unknown>;
    if (typeof o.id !== "string" || typeof o.label !== "string") continue;
    if (o.kind !== "claude" && o.kind !== "shell") continue;
    const tab: TerminalTab = {
      id: o.id,
      label: o.label.slice(0, 40),
      kind: o.kind,
    };
    if (typeof o.sessionId === "string") tab.sessionId = o.sessionId;
    tabs.push(tab);
  }
  if (tabs.length === 0) return null;
  if (tabs.length > MAX_TERMINALS) tabs.length = MAX_TERMINALS;
  // The persisted activeId must point at a surviving tab; if not,
  // fall back to the first one rather than dropping the whole state.
  const active = tabs.some((t) => t.id === activeId) ? activeId : tabs[0].id;
  return {
    tabs,
    activeId: active,
    nextLabelN: Math.max(2, Math.floor(nextLabelN)),
  };
}

export function loadTabsState(): TabsState | null {
  if (typeof window === "undefined") return null;
  try {
    return parseTabsState(window.localStorage.getItem(TABS_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function saveTabsState(state: TabsState): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(TABS_STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* QuotaExceeded / private mode — degrade silently */
  }
}
