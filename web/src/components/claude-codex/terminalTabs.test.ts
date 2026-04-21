import { describe, expect, it } from "vitest";

import {
  addTab,
  closeTab,
  initialTabsState,
  MAX_TERMINALS,
  renameTab,
  selectTab,
} from "./terminalTabs";

describe("terminalTabs state", () => {
  it("starts with exactly one focused tab", () => {
    const s = initialTabsState();
    expect(s.tabs).toHaveLength(1);
    expect(s.activeId).toBe(s.tabs[0].id);
    expect(s.tabs[0].label).toBe("Shell 1");
  });

  it("addTab appends and focuses the new tab with monotonic label", () => {
    let s = initialTabsState();
    s = addTab(s);
    s = addTab(s);
    expect(s.tabs.map((t) => t.label)).toEqual(["Shell 1", "Shell 2", "Shell 3"]);
    expect(s.activeId).toBe(s.tabs[2].id);
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
});
