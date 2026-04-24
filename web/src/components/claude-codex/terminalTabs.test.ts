import { describe, expect, it } from "vitest";

import {
  addTab,
  closeTab,
  initialTabsState,
  MAX_TERMINALS,
  parseTabsState,
  renameTab,
  selectTab,
  setTabSessionId,
} from "./terminalTabs";

describe("terminalTabs state", () => {
  it("starts with exactly one focused tab — the interactive claude PTY", () => {
    const s = initialTabsState();
    expect(s.tabs).toHaveLength(1);
    expect(s.activeId).toBe(s.tabs[0].id);
    expect(s.tabs[0].label).toBe("claude");
    expect(s.tabs[0].kind).toBe("claude");
  });

  it("addTab appends a shell tab by default with monotonic label", () => {
    let s = initialTabsState();
    s = addTab(s);
    s = addTab(s);
    expect(s.tabs.map((t) => t.label)).toEqual(["claude", "Shell 2", "Shell 3"]);
    expect(s.tabs.map((t) => t.kind)).toEqual(["claude", "shell", "shell"]);
    expect(s.activeId).toBe(s.tabs[2].id);
  });

  it("addTab(state, 'claude') adds an interactive claude tab without bumping the shell counter", () => {
    let s = initialTabsState();
    s = addTab(s, "claude");
    s = addTab(s); // shell — should still be "Shell 2"
    expect(s.tabs.map((t) => t.label)).toEqual(["claude", "claude", "Shell 2"]);
    expect(s.tabs.map((t) => t.kind)).toEqual(["claude", "claude", "shell"]);
  });

  it("addTab is a no-op once MAX_TERMINALS is reached", () => {
    let s = initialTabsState();
    for (let i = 0; i < MAX_TERMINALS + 5; i++) s = addTab(s);
    expect(s.tabs).toHaveLength(MAX_TERMINALS);
  });

  it("closeTab refuses to remove the last remaining tab", () => {
    const s = initialTabsState();
    const after = closeTab(s, s.tabs[0].id);
    expect(after).toBe(s);
    expect(after.tabs).toHaveLength(1);
  });

  it("closeTab removes the named tab and keeps focus elsewhere", () => {
    let s = initialTabsState();
    s = addTab(s);
    s = addTab(s);
    const middleId = s.tabs[1].id;
    const before = s.activeId;
    s = closeTab(s, middleId);
    expect(s.tabs.map((t) => t.id)).not.toContain(middleId);
    expect(s.activeId).toBe(before); // active was the third tab, untouched
  });

  it("closing the active tab focuses the right neighbour", () => {
    let s = initialTabsState();
    s = addTab(s);
    s = addTab(s);
    // Focus the middle tab and close it.
    const middle = s.tabs[1];
    const right = s.tabs[2];
    s = selectTab(s, middle.id);
    s = closeTab(s, middle.id);
    expect(s.activeId).toBe(right.id);
  });

  it("closing the rightmost active tab falls back to the left neighbour", () => {
    let s = initialTabsState();
    s = addTab(s);
    s = addTab(s);
    const last = s.tabs[2];
    const prev = s.tabs[1];
    s = selectTab(s, last.id);
    s = closeTab(s, last.id);
    expect(s.activeId).toBe(prev.id);
  });

  it("closeTab on an unknown id is a no-op", () => {
    const s = addTab(initialTabsState());
    const after = closeTab(s, "nope");
    expect(after).toBe(s);
  });

  it("selectTab ignores unknown ids and is a no-op when already active", () => {
    let s = initialTabsState();
    s = addTab(s);
    const before = s;
    expect(selectTab(s, "nope")).toBe(before);
    expect(selectTab(s, s.activeId)).toBe(before);
  });

  it("renameTab trims, caps at 40 chars, rejects empty input", () => {
    let s = initialTabsState();
    s = renameTab(s, s.tabs[0].id, "  build server  ");
    expect(s.tabs[0].label).toBe("build server");
    s = renameTab(s, s.tabs[0].id, "x".repeat(100));
    expect(s.tabs[0].label).toHaveLength(40);
    const before = s;
    expect(renameTab(s, s.tabs[0].id, "   ")).toBe(before);
  });

  it("setTabSessionId attaches and clears the persisted PTY id", () => {
    let s = initialTabsState();
    const id = s.tabs[0].id;
    s = setTabSessionId(s, id, "pty-abc");
    expect(s.tabs[0].sessionId).toBe("pty-abc");
    // Idempotent — setting the same id is a no-op (same reference).
    expect(setTabSessionId(s, id, "pty-abc")).toBe(s);
    s = setTabSessionId(s, id, undefined);
    expect(s.tabs[0]).not.toHaveProperty("sessionId");
  });

  it("setTabSessionId on an unknown tab is a structural no-op", () => {
    const s = initialTabsState();
    expect(setTabSessionId(s, "ghost", "x")).toBe(s);
  });
});

describe("parseTabsState", () => {
  it("returns null for null / empty / non-JSON / wrong shape", () => {
    expect(parseTabsState(null)).toBeNull();
    expect(parseTabsState("")).toBeNull();
    expect(parseTabsState("not json")).toBeNull();
    expect(parseTabsState("[]")).toBeNull();
    expect(parseTabsState(JSON.stringify({ tabs: "x" }))).toBeNull();
  });

  it("round-trips a valid persisted blob", () => {
    const raw = JSON.stringify({
      tabs: [
        { id: "term-1", label: "claude", kind: "claude", sessionId: "pty-1" },
        { id: "term-2", label: "Shell 2", kind: "shell" },
      ],
      activeId: "term-2",
      nextLabelN: 3,
    });
    const out = parseTabsState(raw);
    expect(out).toEqual({
      tabs: [
        { id: "term-1", label: "claude", kind: "claude", sessionId: "pty-1" },
        { id: "term-2", label: "Shell 2", kind: "shell" },
      ],
      activeId: "term-2",
      nextLabelN: 3,
    });
  });

  it("falls back to the first tab when activeId is stale", () => {
    const raw = JSON.stringify({
      tabs: [{ id: "term-1", label: "claude", kind: "claude" }],
      activeId: "ghost",
      nextLabelN: 2,
    });
    const out = parseTabsState(raw);
    expect(out?.activeId).toBe("term-1");
  });

  it("drops malformed tabs but keeps the rest", () => {
    const raw = JSON.stringify({
      tabs: [
        { id: "ok", label: "claude", kind: "claude" },
        { id: 5, label: "x", kind: "shell" },
        { id: "bad-kind", label: "x", kind: "elixir" },
      ],
      activeId: "ok",
      nextLabelN: 2,
    });
    const out = parseTabsState(raw);
    expect(out?.tabs.map((t) => t.id)).toEqual(["ok"]);
  });

  it("returns null when no valid tabs survive validation", () => {
    const raw = JSON.stringify({
      tabs: [{ id: 1, label: "x", kind: "shell" }],
      activeId: "ok",
      nextLabelN: 2,
    });
    expect(parseTabsState(raw)).toBeNull();
  });
});
