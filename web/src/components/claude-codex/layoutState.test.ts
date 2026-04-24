import { describe, expect, it } from "vitest";

import {
  DEFAULT_LAYOUT_STATE,
  LAYOUT_BOUNDS,
  parseLayoutState,
} from "./layoutState";

describe("parseLayoutState", () => {
  it("parses and clamps a valid persisted layout model", () => {
    const raw = JSON.stringify({
      ...DEFAULT_LAYOUT_STATE,
      leftSize: 999,
      rightSize: 1,
      workspaceHeight: 50,
    });

    expect(parseLayoutState(raw)).toEqual({
      ...DEFAULT_LAYOUT_STATE,
      leftSize: LAYOUT_BOUNDS.leftMax,
      rightSize: LAYOUT_BOUNDS.rightMin,
      workspaceHeight: LAYOUT_BOUNDS.centerTopMin,
    });
  });

  it("returns null when any field has the wrong type", () => {
    const raw = JSON.stringify({
      ...DEFAULT_LAYOUT_STATE,
      leftCollapsed: "1",
    });

    expect(parseLayoutState(raw)).toBeNull();
  });

  it("returns null for invalid JSON/object shape", () => {
    expect(parseLayoutState("[]")).toBeNull();
    expect(parseLayoutState("not-json")).toBeNull();
  });
});
