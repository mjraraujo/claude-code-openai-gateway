import { describe, expect, it } from "vitest";

import { clampSize } from "./SplitPane";

describe("clampSize", () => {
  it("returns the value when it sits inside the range", () => {
    expect(clampSize(300, 100, 500)).toBe(300);
  });

  it("clamps values below the min up to the min", () => {
    expect(clampSize(50, 100, 500)).toBe(100);
  });

  it("clamps values above the max down to the max", () => {
    expect(clampSize(800, 100, 500)).toBe(500);
  });

  it("treats min as the lower bound when it is itself negative", () => {
    // We don't allow negative pane sizes — even if a caller passes a
    // negative min, the helper floors the lower bound at 0.
    expect(clampSize(50, -200, 500)).toBe(50);
    expect(clampSize(-10, -200, 500)).toBe(0);
  });

  it("collapses non-finite inputs to the min (safe default)", () => {
    // NaN / ±Infinity all collapse to `min` rather than producing
    // a degenerate layout. This matches the JSDoc on `clampSize`.
    expect(clampSize(Number.NaN, 100, 500)).toBe(100);
    expect(clampSize(Number.POSITIVE_INFINITY, 100, 500)).toBe(100);
    expect(clampSize(Number.NEGATIVE_INFINITY, 100, 500)).toBe(100);
  });

  it("returns min when max is smaller than min (defensive)", () => {
    // Guards against a caller passing inverted bounds — better to
    // pin to min than to silently produce a value outside [min, max].
    expect(clampSize(300, 500, 100)).toBe(500);
  });

  it("allows the boundary values themselves", () => {
    expect(clampSize(100, 100, 500)).toBe(100);
    expect(clampSize(500, 100, 500)).toBe(500);
  });
});
