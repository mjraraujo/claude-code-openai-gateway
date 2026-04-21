import { describe, expect, it } from "vitest";

import { ENDLESS_BREAKER, planSignatureV2 } from "./drive-v2";

describe("drive-v2 · ENDLESS_BREAKER", () => {
  it("uses larger thresholds than the bounded default", () => {
    expect(ENDLESS_BREAKER.maxRepeatedPlans).toBeGreaterThanOrEqual(5);
    expect(ENDLESS_BREAKER.maxConsecutiveFailures).toBeGreaterThanOrEqual(5);
  });
});

describe("drive-v2 · planSignatureV2", () => {
  it("distinguishes the new tools", () => {
    const a = planSignatureV2({ tool: "feature_file", path: "features/x.feature", content: "Feature: x" });
    const b = planSignatureV2({ tool: "cucumber", path: "features" });
    const c = planSignatureV2({ tool: "deploy", environment: "staging" });
    const d = planSignatureV2({ tool: "deploy" });
    expect(new Set([a, b, c, d]).size).toBe(4);
  });

  it("collapses identical exec calls regardless of internal whitespace", () => {
    const a = planSignatureV2({ tool: "exec", command: "npm   test" });
    const b = planSignatureV2({ tool: "exec", command: "npm test" });
    expect(a).toBe(b);
  });

  it("write_file signature uses length + head + tail rather than full content", () => {
    const big = "x".repeat(50_000);
    const sig = planSignatureV2({
      tool: "write_file",
      path: "src/foo.ts",
      content: big,
    });
    // Should NOT contain the full content.
    expect(sig.length).toBeLessThan(500);
    expect(sig).toContain("50000");
  });
});
