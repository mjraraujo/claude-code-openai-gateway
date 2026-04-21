"use client";

import { useCallback, useState } from "react";
import dynamic from "next/dynamic";

import { TerminalView } from "./TerminalView";
import {
  addTab,
  closeTab,
  initialTabsState,
  MAX_TERMINALS,
  renameTab,
  selectTab,
  type TabsState,
  type TerminalTabKind,
} from "./terminalTabs";

// xterm.js touches `window`/`document` on import, so the Claude PTY
// view is loaded client-side only. `next/dynamic({ ssr: false })`
// keeps the bundle out of the server build.
const ClaudeTerminalView = dynamic(() => import("./ClaudeTerminalView"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center bg-black text-[11px] text-zinc-500">
      loading interactive terminal…
    </div>
  ),
});

/**
 * Multi-terminal dock. Renders a tab strip + N independent terminal
 * panes. Each tab keeps its view mounted (hidden via CSS rather than
 * unmounted) so a long-running `npm test` in one shell doesn't get
 * cancelled when the operator peeks at another shell's history, and
 * the Claude PTY scrollback survives tab switches.
 *
 * Tab 0 defaults to an interactive `claude-codex` PTY (powered by
 * `node-pty` + xterm.js, served via `/api/pty/*`). The "+" button
 * adds a non-interactive shell tab; "+ claude" adds another
 * interactive tab.
 *
 * Pure tab-state lives in `terminalTabs.ts`; this component just
 * wires those helpers into `useState` and renders the chrome.
 */
export function TerminalTabs() {
  const [state, setState] = useState<TabsState>(initialTabsState);
  const [editingId, setEditingId] = useState<string | null>(null);

  const onAdd = useCallback(
    (kind: TerminalTabKind = "shell") =>
      setState((s) => addTab(s, kind)),
    [],
  );
  const onClose = useCallback(
    (id: string) => setState((s) => closeTab(s, id)),
    [],
  );
  const onSelect = useCallback(
    (id: string) => setState((s) => selectTab(s, id)),
    [],
  );
  const onRename = useCallback(
    (id: string, label: string) => setState((s) => renameTab(s, id, label)),
    [],
  );

  const atCap = state.tabs.length >= MAX_TERMINALS;

  return (
    <div className="flex h-full min-h-0 flex-col bg-black">
      <div
        className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-zinc-900 bg-black px-2 py-1"
        role="tablist"
        aria-label="Terminal sessions"
      >
        {state.tabs.map((t) => {
          const active = t.id === state.activeId;
          const isEditing = editingId === t.id;
          return (
            <div
              key={t.id}
              className={
                "group flex shrink-0 items-center gap-1 rounded-md px-2 py-0.5 text-[11px] transition " +
                (active
                  ? "bg-zinc-900 text-zinc-100"
                  : "text-zinc-500 hover:bg-zinc-950 hover:text-zinc-300")
              }
            >
              <span
                aria-hidden
                title={t.kind === "claude" ? "claude-codex PTY" : "shell"}
                className={
                  "h-1.5 w-1.5 shrink-0 rounded-full " +
                  (t.kind === "claude" ? "bg-cyan-400" : "bg-emerald-500")
                }
              />
              {isEditing ? (
                <input
                  autoFocus
                  defaultValue={t.label}
                  onBlur={(e) => {
                    onRename(t.id, e.currentTarget.value);
                    setEditingId(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      onRename(t.id, e.currentTarget.value);
                      setEditingId(null);
                    } else if (e.key === "Escape") {
                      setEditingId(null);
                    }
                  }}
                  className="w-24 bg-transparent text-[11px] outline-none ring-1 ring-zinc-700 rounded px-1"
                  spellCheck={false}
                />
              ) : (
                <button
                  type="button"
                  onClick={() => onSelect(t.id)}
                  onDoubleClick={() => setEditingId(t.id)}
                  className="font-mono"
                  role="tab"
                  aria-selected={active}
                  title="Double-click to rename"
                >
                  {t.label}
                </button>
              )}
              {state.tabs.length > 1 ? (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onClose(t.id);
                  }}
                  aria-label={`Close ${t.label}`}
                  title={`Close ${t.label}`}
                  className="ml-0.5 rounded text-zinc-600 opacity-0 transition group-hover:opacity-100 hover:text-zinc-200"
                >
                  ×
                </button>
              ) : null}
            </div>
          );
        })}
        <button
          type="button"
          onClick={() => onAdd("claude")}
          disabled={atCap}
          aria-label="New claude terminal"
          title={
            atCap
              ? `Limit of ${MAX_TERMINALS} terminals reached`
              : "New interactive claude terminal"
          }
          className="ml-1 shrink-0 rounded-md px-2 py-0.5 text-[11px] text-cyan-400 hover:bg-zinc-900 hover:text-cyan-200 disabled:cursor-not-allowed disabled:opacity-40"
        >
          + claude
        </button>
        <button
          type="button"
          onClick={() => onAdd("shell")}
          disabled={atCap}
          aria-label="New shell"
          title={
            atCap
              ? `Limit of ${MAX_TERMINALS} terminals reached`
              : "New shell tab"
          }
          className="shrink-0 rounded-md px-2 py-0.5 text-[11px] text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-40"
        >
          + shell
        </button>
      </div>

      <div className="relative min-h-0 flex-1">
        {state.tabs.map((t) => (
          <div
            key={t.id}
            className={
              "absolute inset-0 " + (t.id === state.activeId ? "" : "hidden")
            }
          >
            {t.kind === "claude" ? (
              <ClaudeTerminalView kind="claude" />
            ) : (
              <TerminalView />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
