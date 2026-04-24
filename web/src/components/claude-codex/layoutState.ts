import { clampSize } from "./SplitPane";

export interface LayoutState {
  leftSize: number;
  leftCollapsed: boolean;
  rightSize: number;
  rightCollapsed: boolean;
  workspaceHeight: number;
  terminalCollapsed: boolean;
}

export const LAYOUT_STORAGE_KEY = "mc.layout.state";

export const DEFAULT_LAYOUT_STATE: LayoutState = {
  leftSize: 280,
  leftCollapsed: false,
  rightSize: 320,
  rightCollapsed: false,
  workspaceHeight: 520,
  terminalCollapsed: false,
};

export const LAYOUT_BOUNDS = {
  leftMin: 200,
  leftMax: 520,
  rightMin: 240,
  rightMax: 560,
  centerTopMin: 200,
  centerTopMax: 2000,
} as const;

export function parseLayoutState(raw: string | null): LayoutState | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const value = parsed as Record<string, unknown>;
  if (
    typeof value.leftSize !== "number" ||
    typeof value.leftCollapsed !== "boolean" ||
    typeof value.rightSize !== "number" ||
    typeof value.rightCollapsed !== "boolean" ||
    typeof value.workspaceHeight !== "number" ||
    typeof value.terminalCollapsed !== "boolean"
  ) {
    return null;
  }
  return normalizeLayoutState({
    leftSize: value.leftSize,
    leftCollapsed: value.leftCollapsed,
    rightSize: value.rightSize,
    rightCollapsed: value.rightCollapsed,
    workspaceHeight: value.workspaceHeight,
    terminalCollapsed: value.terminalCollapsed,
  });
}

export function normalizeLayoutState(state: LayoutState): LayoutState {
  return {
    leftSize: clampSize(state.leftSize, LAYOUT_BOUNDS.leftMin, LAYOUT_BOUNDS.leftMax),
    leftCollapsed: state.leftCollapsed,
    rightSize: clampSize(state.rightSize, LAYOUT_BOUNDS.rightMin, LAYOUT_BOUNDS.rightMax),
    rightCollapsed: state.rightCollapsed,
    workspaceHeight: Math.max(LAYOUT_BOUNDS.centerTopMin, state.workspaceHeight),
    terminalCollapsed: state.terminalCollapsed,
  };
}

export function loadLayoutState(): LayoutState | null {
  if (typeof window === "undefined") return null;
  try {
    return parseLayoutState(window.localStorage.getItem(LAYOUT_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function saveLayoutState(state: LayoutState): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      LAYOUT_STORAGE_KEY,
      JSON.stringify(normalizeLayoutState(state)),
    );
  } catch {
    // Quota / private mode: ignore persistence failures.
  }
}
