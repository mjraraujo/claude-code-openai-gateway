import { describe, expect, it } from "vitest";

import { breakpointFromWidth, LG_BREAKPOINT_PX } from "./useBreakpoint";

describe("breakpointFromWidth", () => {
  it("returns mobile below the lg breakpoint", () => {
    expect(breakpointFromWidth(320)).toBe("mobile"); // small phone
    expect(breakpointFromWidth(390)).toBe("mobile"); // iPhone 14
    expect(breakpointFromWidth(768)).toBe("mobile"); // tablet portrait
    expect(breakpointFromWidth(LG_BREAKPOINT_PX - 1)).toBe("mobile");
  });

  it("returns desktop at and above the lg breakpoint", () => {
    expect(breakpointFromWidth(LG_BREAKPOINT_PX)).toBe("desktop");
    expect(breakpointFromWidth(1280)).toBe("desktop");
    expect(breakpointFromWidth(1920)).toBe("desktop");
  });

  it("uses 1024 as the cutoff (matches Tailwind v4 lg default)", () => {
    expect(LG_BREAKPOINT_PX).toBe(1024);
  });
});
