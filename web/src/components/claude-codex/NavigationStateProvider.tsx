"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import {
  DEFAULT_NAVIGATION_STATE,
  loadNavigationState,
  saveNavigationState,
  type MobileTab,
  type NavigationState,
  type RightTab,
  type WorkspaceTab,
} from "./navigationState";

interface NavigationStateContextValue {
  state: NavigationState;
  setMobileTab: (tab: MobileTab) => void;
  setWorkspaceTab: (tab: WorkspaceTab) => void;
  setRightTab: (tab: RightTab) => void;
}

const NavigationStateContext =
  createContext<NavigationStateContextValue | null>(null);

export function NavigationStateProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<NavigationState>(DEFAULT_NAVIGATION_STATE);

  useEffect(() => {
    const persisted = loadNavigationState();
    if (persisted) {
      setState(persisted);
    }
  }, []);

  const updateState = useCallback((updater: (prev: NavigationState) => NavigationState) => {
    setState((prev) => {
      const next = updater(prev);
      if (next === prev) return prev;
      saveNavigationState(next);
      return next;
    });
  }, []);

  const setMobileTab = useCallback(
    (tab: MobileTab) => {
      updateState((prev) =>
        prev.mobileTab === tab
          ? prev
          : {
              ...prev,
              mobileTab: tab,
            },
      );
    },
    [updateState],
  );

  const setWorkspaceTab = useCallback(
    (tab: WorkspaceTab) => {
      updateState((prev) =>
        prev.workspaceTab === tab
          ? prev
          : {
              ...prev,
              workspaceTab: tab,
            },
      );
    },
    [updateState],
  );

  const setRightTab = useCallback(
    (tab: RightTab) => {
      updateState((prev) =>
        prev.rightTab === tab
          ? prev
          : {
              ...prev,
              rightTab: tab,
            },
      );
    },
    [updateState],
  );

  const value = useMemo(
    () => ({ state, setMobileTab, setWorkspaceTab, setRightTab }),
    [setMobileTab, setRightTab, setWorkspaceTab, state],
  );

  return (
    <NavigationStateContext.Provider value={value}>
      {children}
    </NavigationStateContext.Provider>
  );
}

export function useNavigationStateContext(): NavigationStateContextValue {
  const ctx = useContext(NavigationStateContext);
  if (!ctx) {
    throw new Error(
      "useNavigationStateContext must be used inside NavigationStateProvider",
    );
  }
  return ctx;
}
