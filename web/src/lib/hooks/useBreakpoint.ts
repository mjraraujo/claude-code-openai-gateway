"use client";

import { useEffect, useState } from "react";

/**
 * Tailwind v4 default `lg` breakpoint. We treat anything below this as
 * the single-pane mobile shell — phones (<640) and small tablets
 * (640–1023) both get the bottom-tab nav. The full 3-column desktop
 * grid only renders at >=1024.
 */
export const LG_BREAKPOINT_PX = 1024;

export type Breakpoint = "mobile" | "desktop";

/**
 * Pure helper so the breakpoint policy is unit-testable without a DOM.
 * Exported separately from the React hook below.
 */
export function breakpointFromWidth(width: number): Breakpoint {
  return width >= LG_BREAKPOINT_PX ? "desktop" : "mobile";
}

/**
 * Reactive viewport breakpoint hook.
 *
 * Returns `"desktop"` initially on both server and client to avoid a
 * hydration mismatch (SSR has no `window`, and assuming "mobile" would
 * cause the desktop user's first paint to flash the wrong shell). The
 * effect then upgrades to the real value on mount and on every resize.
 *
 * Uses `matchMedia` rather than `resize` listeners so we only re-render
 * when crossing the breakpoint boundary, not on every pixel change.
 */
export function useBreakpoint(): Breakpoint {
  const [bp, setBp] = useState<Breakpoint>("desktop");

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia(`(min-width: ${LG_BREAKPOINT_PX}px)`);
    const apply = () => setBp(mql.matches ? "desktop" : "mobile");
    apply();
    // Modern API; fall back to the deprecated addListener for old WebKit.
    if (typeof mql.addEventListener === "function") {
      mql.addEventListener("change", apply);
      return () => mql.removeEventListener("change", apply);
    }
    mql.addListener(apply);
    return () => mql.removeListener(apply);
  }, []);

  return bp;
}
