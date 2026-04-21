import { describe, expect, it } from "vitest";

import {
  DEFAULT_BREAKER,
  detectCircuitBreaker,
  planSignature,
} from "./drive";
import type { AutoDriveStep } from "./store";

function plan(sig: string, text = "thought"): AutoDriveStep {
  return { index: 0, at: 0, kind: "plan", text, data: { sig } };
}
function toolResult(ok: boolean): AutoDriveStep {
  return { index: 0, at: 0, kind: "tool_result", text: ok ? "ok" : "err", data: { ok } };
}
function info(text = "info"): AutoDriveStep {
  return { index: 0, at: 0, kind: "info", text };
}

describe("planSignature", () => {
  it("collapses whitespace differences in exec commands", () => {
    expect(planSignature({ tool: "exec", command: "ls   -la" })).toBe(
      planSignature({ tool: "exec", command: "ls -la" }),
    );
  });

  it("treats different read paths as different signatures", () => {
    expect(planSignature({ tool: "read_file", path: "a.txt" })).not.toBe(
      planSignature({ tool: "read_file", path: "b.txt" }),
    );
  });

  it("treats write_file with same path+length+ends as same signature", () => {
    const a = planSignature({ tool: "write_file", path: "x", content: "hello world" });
    const b = planSignature({ tool: "write_file", path: "x", content: "hello world" });
    expect(a).toBe(b);
  });

  it("write_file with different content produces different signature", () => {
    const a = planSignature({ tool: "write_file", path: "x", content: "hello" });
    const b = planSignature({ tool: "write_file", path: "x", content: "world" });
    expect(a).not.toBe(b);
  });

  it("done summary trimmed", () => {
    expect(planSignature({ tool: "done", summary: "  ok  " })).toBe(
      planSignature({ tool: "done", summary: "ok" }),
    );
  });
});

describe("detectCircuitBreaker", () => {
  it("does not trip on empty history", () => {
    expect(detectCircuitBreaker([])).toEqual({ tripped: false });
  });

  it("does not trip on a normal varied run", () => {
    const steps: AutoDriveStep[] = [
      plan("read_file::a"),
      toolResult(true),
      plan("write_file::a::5::hi::hi"),
      toolResult(true),
      plan("exec::ls"),
      toolResult(true),
    ];
    expect(detectCircuitBreaker(steps)).toEqual({ tripped: false });
  });

  it("trips on N consecutive identical plans (default 3)", () => {
    const sig = "exec::npm test";
    const steps: AutoDriveStep[] = [
      plan(sig),
      toolResult(false),
      plan(sig),
      toolResult(false),
      plan(sig),
    ];
    const v = detectCircuitBreaker(steps);
    expect(v.tripped).toBe(true);
    if (v.tripped) expect(v.reason).toMatch(/3 consecutive identical plans/);
  });

  it("does not trip when the streak is broken by a different plan", () => {
    const steps: AutoDriveStep[] = [
      plan("exec::a"),
      toolResult(false),
      plan("exec::b"),
      toolResult(false),
      plan("exec::a"),
    ];
    expect(detectCircuitBreaker(steps).tripped).toBe(false);
  });

  it("trips on N consecutive failed tool_results (default 4)", () => {
    const steps: AutoDriveStep[] = [
      plan("exec::a"),
      toolResult(false),
      plan("exec::b"),
      toolResult(false),
      plan("exec::c"),
      toolResult(false),
      plan("exec::d"),
      toolResult(false),
    ];
    const v = detectCircuitBreaker(steps);
    expect(v.tripped).toBe(true);
    if (v.tripped) expect(v.reason).toMatch(/4 consecutive tool failures/);
  });

  it("a single successful tool_result resets the failure streak", () => {
    const steps: AutoDriveStep[] = [
      plan("exec::a"),
      toolResult(false),
      plan("exec::b"),
      toolResult(true), // resets
      plan("exec::c"),
      toolResult(false),
      plan("exec::d"),
      toolResult(false),
    ];
    expect(detectCircuitBreaker(steps).tripped).toBe(false);
  });

  it("info/error housekeeping steps do not break the streaks", () => {
    const sig = "exec::npm test";
    const steps: AutoDriveStep[] = [
      plan(sig),
      info("noise"),
      plan(sig),
      info("more noise"),
      plan(sig),
    ];
    expect(detectCircuitBreaker(steps).tripped).toBe(true);
  });

  it("custom config overrides defaults", () => {
    const sig = "exec::a";
    const steps: AutoDriveStep[] = [plan(sig), plan(sig)];
    expect(detectCircuitBreaker(steps, { ...DEFAULT_BREAKER, maxRepeatedPlans: 2 }).tripped).toBe(true);
    expect(detectCircuitBreaker(steps).tripped).toBe(false);
  });

  it("falls back to tool+text for legacy plan steps without sig", () => {
    const legacy = (tool: string, text: string): AutoDriveStep => ({
      index: 0, at: 0, kind: "plan", text, data: { tool },
    });
    const steps: AutoDriveStep[] = [
      legacy("exec", "run tests"),
      legacy("exec", "run tests"),
      legacy("exec", "run tests"),
    ];
    expect(detectCircuitBreaker(steps).tripped).toBe(true);
  });
});
