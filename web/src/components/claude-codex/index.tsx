"use client";

import { useCallback, useEffect, useState } from "react";

import { useBreakpoint } from "@/lib/hooks/useBreakpoint";

import { AgentsPanel } from "./AgentsPanel";
import { ChatDock } from "./ChatDock";
import { KanbanPanel } from "./KanbanPanel";
import { MobileShell } from "./MobileShell";
import { SplitPane, clampSize } from "./SplitPane";
import { StatusBar } from "./StatusBar";
import { TerminalView } from "./TerminalView";
import { WorkspaceCenter } from "./WorkspaceCenter";

/**
 * Mission Control desktop shell.
 *
 * Layout (desktop, >= lg):
 *   [Kanban rail | Workspace top                 | Right rail]
 *   [(collapsible)| ────────────────────────────── | (Agents/Chat)]
 *                 | Terminal bottom (resizable)   |
 *
 * The MobileShell (single-pane bottom-tab nav) is unchanged at < lg.
 *
 * All split sizes and collapsed flags persist to localStorage under
 * the namespaced keys below so the layout survives reloads.
 */

const LS_KEYS = {
  leftSize: "mc.layout.leftSize",
  leftCollapsed: "mc.layout.leftCollapsed",
  rightSize: "mc.layout.rightSize",
  rightCollapsed: "mc.layout.rightCollapsed",
  rightTab: "mc.layout.rightTab",
  workspaceHeight: "mc.layout.workspaceHeight",
  terminalCollapsed: "mc.layout.terminalCollapsed",
} as const;

const DEFAULTS = {
  leftSize: 280,
  rightSize: 320,
  workspaceHeight: 520,
} as const;

const BOUNDS = {
  leftMin: 200,
  leftMax: 520,
  rightMin: 240,
  rightMax: 560,
  centerTopMin: 200,
  centerTopMax: 2000,
} as const;

const COLLAPSED_RAIL_WIDTH = 28;
const COLLAPSED_TERMINAL_HEIGHT = 28;

type RightTab = "agents" | "chat";

function readNumber(key: string, fallback: number): number {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return fallback;
    const n = Number.parseFloat(raw);
    return Number.isFinite(n) ? n : fallback;
  } catch {
    return fallback;
  }
}

function readBool(key: string, fallback: boolean): boolean {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return fallback;
    return raw === "1" || raw === "true";
  } catch {
    return fallback;
  }
}

function readTab(fallback: RightTab): RightTab {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(LS_KEYS.rightTab);
    return raw === "agents" || raw === "chat" ? raw : fallback;
  } catch {
    return fallback;
  }
}

function writeStorage(key: string, value: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* quota / private mode — ignore */
  }
}

export function ClaudeCodex() {
  // Below the lg (1024px) breakpoint we hand off to the single-pane
  // bottom-tab shell so the dashboard is usable on phones and small
  // tablets. The desktop resizable shell only renders at >=lg.
  const bp = useBreakpoint();
  if (bp === "mobile") {
    return <MobileShell />;
  }
  return <DesktopShell />;
}

function DesktopShell() {
  // We need a render after mount before reading from localStorage so
  // the server-rendered HTML matches the first client paint (we'd
  // otherwise hydrate with whatever the user stored, which the
  // server can't know). Until `hydrated` is true we render with the
  // documented defaults — the layout flips into place on the next
  // commit, which is imperceptible.
  const [hydrated, setHydrated] = useState(false);
  const [leftSize, setLeftSize] = useState<number>(DEFAULTS.leftSize);
  const [leftCollapsed, setLeftCollapsed] = useState<boolean>(false);
  const [rightSize, setRightSize] = useState<number>(DEFAULTS.rightSize);
  const [rightCollapsed, setRightCollapsed] = useState<boolean>(false);
  const [rightTab, setRightTab] = useState<RightTab>("agents");
  const [workspaceHeight, setWorkspaceHeight] = useState<number>(
    DEFAULTS.workspaceHeight,
  );
  const [terminalCollapsed, setTerminalCollapsed] = useState<boolean>(false);

  useEffect(() => {
    setLeftSize(
      clampSize(
        readNumber(LS_KEYS.leftSize, DEFAULTS.leftSize),
        BOUNDS.leftMin,
        BOUNDS.leftMax,
      ),
    );
    setLeftCollapsed(readBool(LS_KEYS.leftCollapsed, false));
    setRightSize(
      clampSize(
        readNumber(LS_KEYS.rightSize, DEFAULTS.rightSize),
        BOUNDS.rightMin,
        BOUNDS.rightMax,
      ),
    );
    setRightCollapsed(readBool(LS_KEYS.rightCollapsed, false));
    setRightTab(readTab("agents"));
    setWorkspaceHeight(
      Math.max(
        BOUNDS.centerTopMin,
        readNumber(LS_KEYS.workspaceHeight, DEFAULTS.workspaceHeight),
      ),
    );
    setTerminalCollapsed(readBool(LS_KEYS.terminalCollapsed, false));
    setHydrated(true);
  }, []);

  const onLeftSize = useCallback((s: number) => {
    setLeftSize(s);
    writeStorage(LS_KEYS.leftSize, String(Math.round(s)));
  }, []);
  const onRightSize = useCallback((s: number) => {
    setRightSize(s);
    writeStorage(LS_KEYS.rightSize, String(Math.round(s)));
  }, []);
  const onWorkspaceHeight = useCallback((s: number) => {
    setWorkspaceHeight(s);
    writeStorage(LS_KEYS.workspaceHeight, String(Math.round(s)));
  }, []);

  const toggleLeft = useCallback(() => {
    setLeftCollapsed((prev) => {
      const next = !prev;
      writeStorage(LS_KEYS.leftCollapsed, next ? "1" : "0");
      return next;
    });
  }, []);
  const toggleRight = useCallback(() => {
    setRightCollapsed((prev) => {
      const next = !prev;
      writeStorage(LS_KEYS.rightCollapsed, next ? "1" : "0");
      return next;
    });
  }, []);
  const toggleTerminal = useCallback(() => {
    setTerminalCollapsed((prev) => {
      const next = !prev;
      writeStorage(LS_KEYS.terminalCollapsed, next ? "1" : "0");
      return next;
    });
  }, []);
  const selectRightTab = useCallback((tab: RightTab) => {
    setRightTab(tab);
    writeStorage(LS_KEYS.rightTab, tab);
  }, []);

  const left = leftCollapsed ? (
    <CollapsedRail label="Tasks · Sprint" onExpand={toggleLeft} side="left" />
  ) : (
    <KanbanColumn onCollapse={toggleLeft} />
  );

  const right = rightCollapsed ? (
    <CollapsedRail
      label={rightTab === "chat" ? "Chat" : "Agents"}
      onExpand={toggleRight}
      side="right"
    />
  ) : (
    <RightColumn
      tab={rightTab}
      onTab={selectRightTab}
      onCollapse={toggleRight}
    />
  );

  // Build the center: workspace on top, terminal on bottom. When the
  // terminal is collapsed it shrinks to a thin clickable bar.
  const center = terminalCollapsed ? (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-hidden">
        <WorkspaceCenter hideTerminal />
      </div>
      <CollapsedTerminalBar onExpand={toggleTerminal} />
    </div>
  ) : (
    <SplitPane
      direction="vertical"
      size={Math.min(workspaceHeight, BOUNDS.centerTopMax)}
      minSize={BOUNDS.centerTopMin}
      maxSize={BOUNDS.centerTopMax}
      onSizeChange={onWorkspaceHeight}
      ariaLabel="Resize workspace and terminal"
    >
      <WorkspaceCenter hideTerminal />
      <TerminalPane onCollapse={toggleTerminal} />
    </SplitPane>
  );

  // Compose the three columns. We use SplitPane only for the *active*
  // (non-collapsed) rails — when a rail is collapsed it becomes a
  // fixed-width strip without a drag handle.
  const leftSized = leftCollapsed ? COLLAPSED_RAIL_WIDTH : leftSize;
  const rightSized = rightCollapsed ? COLLAPSED_RAIL_WIDTH : rightSize;

  return (
    <div className="flex h-screen w-screen flex-col bg-black text-zinc-100">
      <StatusBar />
      <div className="flex min-h-0 flex-1" data-hydrated={hydrated}>
        {/* Left column (Kanban or collapsed rail) */}
        {leftCollapsed ? (
          <div
            style={{ width: leftSized, flexShrink: 0 }}
            className="min-h-0 overflow-hidden border-r border-zinc-900"
          >
            {left}
          </div>
        ) : (
          <SplitPane
            direction="horizontal"
            size={leftSize}
            minSize={BOUNDS.leftMin}
            maxSize={BOUNDS.leftMax}
            onSizeChange={onLeftSize}
            ariaLabel="Resize tasks panel"
          >
            {left}
            <CenterAndRight
              center={center}
              right={right}
              rightCollapsed={rightCollapsed}
              rightSize={rightSized}
              rightSizeUnclamped={rightSize}
              onRightSize={onRightSize}
            />
          </SplitPane>
        )}
      </div>
    </div>
  );
}

interface CenterAndRightProps {
  center: React.ReactNode;
  right: React.ReactNode;
  rightCollapsed: boolean;
  rightSize: number;
  rightSizeUnclamped: number;
  onRightSize: (s: number) => void;
}

/**
 * Center + right column. Factored out so we can render it both as the
 * second child of the left SplitPane and (when the left column is
 * collapsed) directly into the row container without nested splitters.
 *
 * The right column is *always* on the right edge — we model that by
 * giving the SplitPane the *center* as its first (sized) child and
 * the right column as its second (flexes to fill). To keep the right
 * column at a fixed width that the user controls, we instead size
 * the right column explicitly and let the center fill, by using a
 * plain flexbox layout when the right rail is collapsed and a custom
 * "center fills, right fixed" arrangement otherwise.
 */
function CenterAndRight({
  center,
  right,
  rightCollapsed,
  rightSize,
  onRightSize,
  rightSizeUnclamped,
}: CenterAndRightProps) {
  if (rightCollapsed) {
    return (
      <div className="flex h-full min-h-0 w-full">
        <div className="min-h-0 min-w-0 flex-1 overflow-hidden">{center}</div>
        <div
          style={{ width: rightSize, flexShrink: 0 }}
          className="min-h-0 overflow-hidden border-l border-zinc-900"
        >
          {right}
        </div>
      </div>
    );
  }
  // Use a SplitPane where the *right* column is sized — to do that
  // with a left-anchored splitter we put the center first (fills) and
  // the right second. We achieve right-anchored sizing by inverting:
  // give SplitPane the right column first with the desired size, but
  // visually flip via `flex-row-reverse`.
  return (
    <div className="h-full min-h-0 w-full">
      <SplitPane
        direction="horizontal"
        size={rightSizeUnclamped}
        minSize={BOUNDS.rightMin}
        maxSize={BOUNDS.rightMax}
        onSizeChange={onRightSize}
        ariaLabel="Resize agents/chat panel"
        className="flex-row-reverse"
      >
        {right}
        {center}
      </SplitPane>
    </div>
  );
}

/** Kanban column wrapper that adds a collapse chevron in the corner. */
function KanbanColumn({ onCollapse }: { onCollapse: () => void }) {
  return (
    <div className="relative h-full min-h-0">
      <button
        type="button"
        onClick={onCollapse}
        title="Hide tasks panel"
        aria-label="Hide tasks panel"
        className="absolute right-1 top-1 z-10 rounded border border-zinc-800 bg-black/80 px-1.5 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
      >
        ‹‹
      </button>
      <KanbanPanel />
    </div>
  );
}

/**
 * Right column: tabbed Agents / Chat with a collapse chevron.
 *
 * Both panels are *mounted* once visited (we just hide the inactive
 * one with CSS) so SSE subscriptions and any in-flight chat stream
 * survive a tab switch.
 */
function RightColumn({
  tab,
  onTab,
  onCollapse,
}: {
  tab: RightTab;
  onTab: (t: RightTab) => void;
  onCollapse: () => void;
}) {
  const [visited, setVisited] = useState<Set<RightTab>>(() => new Set([tab]));
  useEffect(() => {
    setVisited((prev) => {
      if (prev.has(tab)) return prev;
      const next = new Set(prev);
      next.add(tab);
      return next;
    });
  }, [tab]);

  return (
    <section className="flex h-full min-h-0 flex-col bg-zinc-950">
      <div className="flex items-center gap-1 border-b border-zinc-900 bg-black px-2 py-1.5">
        {(
          [
            { id: "agents" as const, label: "Agents" },
            { id: "chat" as const, label: "Chat" },
          ]
        ).map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => onTab(t.id)}
            className={
              "rounded px-2 py-0.5 text-[11px] uppercase tracking-[0.18em] transition-colors " +
              (tab === t.id
                ? "bg-zinc-900 text-zinc-100"
                : "text-zinc-500 hover:text-zinc-200")
            }
          >
            {t.label}
          </button>
        ))}
        <button
          type="button"
          onClick={onCollapse}
          title="Hide right panel"
          aria-label="Hide right panel"
          className="ml-auto rounded border border-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
        >
          ››
        </button>
      </div>
      <div className="relative min-h-0 flex-1">
        {visited.has("agents") ? (
          <div
            className="absolute inset-0"
            style={{ display: tab === "agents" ? "block" : "none" }}
          >
            <AgentsPanel />
          </div>
        ) : null}
        {visited.has("chat") ? (
          <div
            className="absolute inset-0"
            style={{ display: tab === "chat" ? "block" : "none" }}
          >
            <ChatDock />
          </div>
        ) : null}
      </div>
    </section>
  );
}

/** Bottom Terminal pane with a collapse button in its header. */
function TerminalPane({ onCollapse }: { onCollapse: () => void }) {
  return (
    <div className="relative h-full min-h-0">
      <button
        type="button"
        onClick={onCollapse}
        title="Hide terminal"
        aria-label="Hide terminal"
        className="absolute right-1 top-1 z-10 rounded border border-zinc-800 bg-black/80 px-1.5 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
      >
        ▾
      </button>
      <TerminalView />
    </div>
  );
}

/** Thin clickable strip shown when the terminal is collapsed. */
function CollapsedTerminalBar({ onExpand }: { onExpand: () => void }) {
  return (
    <button
      type="button"
      onClick={onExpand}
      style={{ height: COLLAPSED_TERMINAL_HEIGHT }}
      className="flex w-full items-center justify-between border-t border-zinc-900 bg-black px-3 text-[10px] uppercase tracking-[0.2em] text-zinc-500 hover:bg-zinc-950 hover:text-zinc-300"
    >
      <span>terminal · collapsed</span>
      <span>▴</span>
    </button>
  );
}

/** Vertical strip rendered when a side rail is collapsed. */
function CollapsedRail({
  label,
  onExpand,
  side,
}: {
  label: string;
  onExpand: () => void;
  side: "left" | "right";
}) {
  return (
    <button
      type="button"
      onClick={onExpand}
      title={`Show ${label}`}
      aria-label={`Show ${label}`}
      className="flex h-full w-full flex-col items-center justify-between bg-black py-2 text-zinc-500 hover:bg-zinc-950 hover:text-zinc-200"
    >
      <span className="text-[10px]">{side === "left" ? "›" : "‹"}</span>
      <span
        className="text-[10px] uppercase tracking-[0.2em]"
        style={{ writingMode: "vertical-rl" }}
      >
        {label}
      </span>
      <span className="text-[10px]">{side === "left" ? "›" : "‹"}</span>
    </button>
  );
}

