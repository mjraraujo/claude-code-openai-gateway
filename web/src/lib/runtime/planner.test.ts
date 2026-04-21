/**
 * Tests for the auto-drive planner.
 *
 * Live mode requires a valid Codex token and the gateway running; the
 * unit tests target the *mock* path which is what runs in sandboxes
 * and the demo experience. We force `getValidToken` to return null
 * via `vi.mock` so `plan()` deterministically takes the mock branch.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

// Stub out the auth storage layer so the planner falls into mock mode.
vi.mock("@/lib/auth/storage", () => ({
  getValidToken: async () => null,
  getOrCreateSessionApiKey: async () => "sk-test",
}));

import { plan, extractJsonObject, buildSystemPrompt } from "./planner";
import type { AutoDriveStep } from "./store";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("planner · mock mode", () => {
  it("starts by reading README.md when there are no prior steps", async () => {
    const p = await plan({
      goal: "explore the repo",
      steps: [],
      maxStepsRemaining: 5,
    });
    expect(p.action.tool).toBe("read_file");
    if (p.action.tool === "read_file") {
      expect(p.action.path).toBe("README.md");
    }
    expect(typeof p.thought).toBe("string");
    expect(p.thought.length).toBeGreaterThan(0);
  });

  it("issues an exec listing once the readme has been read", async () => {
    const steps: AutoDriveStep[] = [
      {
        index: 0,
        at: Date.now(),
        kind: "tool",
        text: "read_file README.md",
        data: { tool: "read_file" },
      },
      {
        index: 1,
        at: Date.now(),
        kind: "tool_result",
        text: "# project",
      },
    ];
    const p = await plan({ goal: "explore", steps, maxStepsRemaining: 4 });
    expect(p.action.tool).toBe("exec");
    if (p.action.tool === "exec") {
      expect(p.action.command).toMatch(/ls/);
    }
  });

  it("terminates with done after the read+exec pair", async () => {
    const steps: AutoDriveStep[] = [
      {
        index: 0,
        at: 1,
        kind: "tool",
        text: "read_file README.md",
        data: { tool: "read_file" },
      },
      { index: 1, at: 2, kind: "tool_result", text: "ok" },
      {
        index: 2,
        at: 3,
        kind: "tool",
        text: "exec ls",
        data: { tool: "exec" },
      },
      { index: 3, at: 4, kind: "tool_result", text: "files…" },
    ];
    const p = await plan({ goal: "explore", steps, maxStepsRemaining: 2 });
    expect(p.action.tool).toBe("done");
    if (p.action.tool === "done") {
      expect(p.action.summary).toMatch(/mock planner done/);
    }
  });
});

describe("planner · extractJsonObject", () => {
  it("returns the lone object when input is exactly one JSON value", () => {
    expect(extractJsonObject('{"a":1}')).toBe('{"a":1}');
  });

  it("recovers the JSON when wrapped in prose before and after", () => {
    const got = extractJsonObject(
      'Here you go:\n{"thought":"hi","action":{"tool":"done","summary":"x"}}\nThanks!',
    );
    expect(got).toBe('{"thought":"hi","action":{"tool":"done","summary":"x"}}');
  });

  it("handles nested objects without truncating", () => {
    const obj =
      '{"thought":"deep","action":{"tool":"write_file","path":"a","content":"b"}}';
    expect(extractJsonObject(`prefix ${obj} suffix`)).toBe(obj);
  });

  it("ignores braces that appear inside string literals", () => {
    // The `}` inside the string must not close the outer object.
    const got = extractJsonObject(
      'noise {"action":{"tool":"exec","command":"echo \\"} not the end\\""}} tail',
    );
    expect(got).toBe(
      '{"action":{"tool":"exec","command":"echo \\"} not the end\\""}}',
    );
  });

  it("returns null when no opening brace is present", () => {
    expect(extractJsonObject("no json here")).toBeNull();
  });

  it("returns null when the object is unbalanced", () => {
    expect(extractJsonObject("{ unclosed")).toBeNull();
  });
});

describe("planner · buildSystemPrompt", () => {
  it("returns the base prompt when no hints are provided", () => {
    const got = buildSystemPrompt({});
    expect(got).toMatch(/Claude Codex auto-drive planner/);
    expect(got).not.toMatch(/Methodology:/);
    expect(got).not.toMatch(/Dev mode:/);
  });

  it("appends a methodology hint when provided", () => {
    const got = buildSystemPrompt({ methodology: "Shape Up" });
    expect(got).toMatch(/Methodology: Shape Up/);
  });

  it("appends both hints when both provided", () => {
    const got = buildSystemPrompt({
      methodology: "Scrum",
      devMode: "Spec Driven",
    });
    expect(got).toMatch(/Methodology: Scrum/);
    expect(got).toMatch(/Dev mode: Spec Driven/);
  });

  it("ignores whitespace-only hints", () => {
    const got = buildSystemPrompt({ methodology: "   ", devMode: "" });
    expect(got).not.toMatch(/Methodology:/);
    expect(got).not.toMatch(/Dev mode:/);
  });
});
