"use client";

/**
 * Hand-rolled resizable split-pane primitive.
 *
 * Used by the Mission Control desktop shell to allow the user to
 * resize the left Kanban rail, the right Agents/Chat rail, and the
 * vertical split between Workspace (top) and Terminal (bottom).
 *
 * Why hand-rolled: keeps `web/package.json` dep count down (no
 * react-resizable-panels). The component is small enough that we own
 * it without much risk, and its pure clamp helper is unit-tested in
 * `SplitPane.test.ts`.
 *
 * Behaviour:
 *   - `direction="horizontal"` resizes the *first* child's width.
 *   - `direction="vertical"`   resizes the *first* child's height.
 *   - The drag handle exposes `role="separator"` and the WAI-ARIA
 *     `aria-valuenow / -valuemin / -valuemax` attributes so screen
 *     readers can announce the position. Arrow keys nudge the size
 *     by `keyboardStepPx`; Home/End jump to min/max.
 *   - Touch (Pointer Events) is supported by using `setPointerCapture`
 *     on the handle and listening for `pointermove` / `pointerup`.
 *   - Size is reported back via `onSizeChange` so the parent can
 *     persist it to localStorage (the SplitPane itself is stateless
 *     about persistence to keep it reusable).
 */

import {
  KeyboardEvent,
  PointerEvent,
  ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

/**
 * Pure clamp helper exported for unit tests. Lives outside the
 * component so it can be exercised without rendering React.
 *
 * Semantics:
 *   - Non-finite inputs collapse to `min`.
 *   - `min` is clamped at >= 0.
 *   - If `max < min`, returns `min` (caller bug, but be defensive).
 */
export function clampSize(value: number, min: number, max: number): number {
  const lo = Math.max(0, min);
  const hi = Math.max(lo, max);
  if (!Number.isFinite(value)) return lo;
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}

export interface SplitPaneProps {
  direction: "horizontal" | "vertical";
  /** Current size of the first pane, in pixels. */
  size: number;
  /** Minimum size in pixels. Defaults to 120. */
  minSize?: number;
  /** Maximum size in pixels. Defaults to 1600. */
  maxSize?: number;
  /** Pixels per arrow-key press for keyboard accessibility. Defaults to 16. */
  keyboardStepPx?: number;
  /** Called with the new clamped size whenever the user resizes. */
  onSizeChange: (size: number) => void;
  /** Optional ARIA label for the drag separator. */
  ariaLabel?: string;
  /** Two children — first is the sized pane, second fills the remainder. */
  children: [ReactNode, ReactNode];
  /** Optional className applied to the outer flex container. */
  className?: string;
}

export function SplitPane({
  direction,
  size,
  minSize = 120,
  maxSize = 1600,
  keyboardStepPx = 16,
  onSizeChange,
  ariaLabel,
  children,
  className,
}: SplitPaneProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const dragStateRef = useRef<{
    pointerId: number;
    startCoord: number;
    startSize: number;
  } | null>(null);
  const [dragging, setDragging] = useState(false);

  const onPointerDown = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      // Only react to primary button / touch / pen contacts. Right-
      // click would otherwise initiate a phantom drag.
      if (e.button !== 0 && e.pointerType === "mouse") return;
      e.preventDefault();
      const coord = direction === "horizontal" ? e.clientX : e.clientY;
      dragStateRef.current = {
        pointerId: e.pointerId,
        startCoord: coord,
        startSize: size,
      };
      // setPointerCapture lets the handle keep receiving move events
      // even if the cursor leaves it (or runs over the iframe-y
      // Monaco editor).
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* some browsers throw if already captured */
      }
      setDragging(true);
    },
    [direction, size],
  );

  const onPointerMove = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      const drag = dragStateRef.current;
      if (!drag || drag.pointerId !== e.pointerId) return;
      const coord = direction === "horizontal" ? e.clientX : e.clientY;
      const next = clampSize(
        drag.startSize + (coord - drag.startCoord),
        minSize,
        maxSize,
      );
      onSizeChange(next);
    },
    [direction, maxSize, minSize, onSizeChange],
  );

  const endDrag = useCallback((e: PointerEvent<HTMLDivElement>) => {
    const drag = dragStateRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    dragStateRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    setDragging(false);
  }, []);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      // Map arrow keys to size deltas. Direction-aware: vertical
      // separators respond to ArrowLeft/Right, horizontal split
      // (workspace/terminal) responds to ArrowUp/Down.
      let delta = 0;
      if (direction === "horizontal") {
        if (e.key === "ArrowLeft") delta = -keyboardStepPx;
        else if (e.key === "ArrowRight") delta = keyboardStepPx;
      } else {
        if (e.key === "ArrowUp") delta = -keyboardStepPx;
        else if (e.key === "ArrowDown") delta = keyboardStepPx;
      }
      if (delta !== 0) {
        e.preventDefault();
        onSizeChange(clampSize(size + delta, minSize, maxSize));
        return;
      }
      if (e.key === "Home") {
        e.preventDefault();
        onSizeChange(clampSize(minSize, minSize, maxSize));
      } else if (e.key === "End") {
        e.preventDefault();
        onSizeChange(clampSize(maxSize, minSize, maxSize));
      }
    },
    [direction, keyboardStepPx, maxSize, minSize, onSizeChange, size],
  );

  // Apply a body-wide cursor + disable text selection while dragging
  // so the cursor doesn't flicker between the resize cursor and the
  // text-cursor as it crosses different children.
  useEffect(() => {
    if (!dragging) return;
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor =
      direction === "horizontal" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
    return () => {
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
    };
  }, [dragging, direction]);

  const isHorizontal = direction === "horizontal";
  const firstStyle = isHorizontal
    ? { width: `${size}px`, flexShrink: 0 }
    : { height: `${size}px`, flexShrink: 0 };

  const handleClass = isHorizontal
    ? "w-1 cursor-col-resize hover:bg-emerald-500/30 active:bg-emerald-500/50"
    : "h-1 cursor-row-resize hover:bg-emerald-500/30 active:bg-emerald-500/50";

  const containerClass = isHorizontal
    ? "flex h-full w-full min-h-0 min-w-0 flex-row"
    : "flex h-full w-full min-h-0 min-w-0 flex-col";

  const [first, second] = children;

  return (
    <div ref={containerRef} className={`${containerClass} ${className ?? ""}`}>
      <div className="min-h-0 min-w-0 overflow-hidden" style={firstStyle}>
        {first}
      </div>
      <div
        role="separator"
        tabIndex={0}
        aria-orientation={isHorizontal ? "vertical" : "horizontal"}
        aria-label={ariaLabel}
        aria-valuemin={minSize}
        aria-valuemax={maxSize}
        aria-valuenow={Math.round(size)}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onKeyDown}
        className={`${handleClass} bg-zinc-900 transition-colors focus:bg-emerald-500/40 focus:outline-none`}
      />
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">{second}</div>
    </div>
  );
}
