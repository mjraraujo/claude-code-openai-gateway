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
}

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
  const first: TerminalTab = { id: newTabId(), label: "Shell 1" };
  return { tabs: [first], activeId: first.id, nextLabelN: 2 };
}

/** Add a new tab (capped at MAX_TERMINALS) and focus it. */
export function addTab(state: TabsState): TabsState {
  if (state.tabs.length >= MAX_TERMINALS) return state;
  const tab: TerminalTab = {
    id: newTabId(),
    label: `Shell ${state.nextLabelN}`,
  };
  return {
    tabs: [...state.tabs, tab],
    activeId: tab.id,
    nextLabelN: state.nextLabelN + 1,
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
