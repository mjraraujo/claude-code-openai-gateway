export type MobileTab = "tasks" | "workspace" | "amigos" | "agents";

export type WorkspaceTab =
  | "terminal"
  | "workspace"
  | "side-by-side"
  | "browser"
  | "amigos";

export type RightTab = "agents" | "chat";

export interface NavigationState {
  mobileTab: MobileTab;
  workspaceTab: WorkspaceTab;
  rightTab: RightTab;
}

export const NAVIGATION_STORAGE_KEY = "mc.navigation.state";

export const DEFAULT_NAVIGATION_STATE: NavigationState = {
  mobileTab: "workspace",
  workspaceTab: "workspace",
  rightTab: "agents",
};

export function parseNavigationState(raw: string | null): NavigationState | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const value = parsed as Record<string, unknown>;
  const mobileTab = value.mobileTab;
  const workspaceTab = value.workspaceTab;
  const rightTab = value.rightTab;
  if (
    mobileTab !== "tasks" &&
    mobileTab !== "workspace" &&
    mobileTab !== "amigos" &&
    mobileTab !== "agents"
  ) {
    return null;
  }
  if (
    workspaceTab !== "terminal" &&
    workspaceTab !== "workspace" &&
    workspaceTab !== "side-by-side" &&
    workspaceTab !== "browser" &&
    workspaceTab !== "amigos"
  ) {
    return null;
  }
  if (rightTab !== "agents" && rightTab !== "chat") return null;
  return {
    mobileTab,
    workspaceTab,
    rightTab,
  };
}

export function loadNavigationState(): NavigationState | null {
  if (typeof window === "undefined") return null;
  try {
    return parseNavigationState(window.localStorage.getItem(NAVIGATION_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function saveNavigationState(state: NavigationState): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(NAVIGATION_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Quota / private mode: ignore persistence failures.
  }
}
