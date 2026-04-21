/**
 * Unit tests for the Three Amigos helpers.
 *
 * Covers the pure surface — Gherkin parser, prompt builder,
 * JSON-reply parser, the verdict reducer, and `runAmigos()` driven
 * by an injected fake gateway. No real I/O is performed except for
 * a single feature file written into a temp `WORKSPACE_ROOT` to
 * exercise `discoverFeatures()` end-to-end.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildAmigoPrompt,
  extractJsonObject,
  mergeAmigoVerdicts,
  overallVerdict,
  parseAmigoReply,
  parseScenarios,
  type AmigoResult,
  type AmigosEvent,
} from "./amigos";

const SAMPLE = `
Feature: Login
  As a user I want to sign in
  so that I can access my dashboard.

  Background:
    Given the auth service is up

  Scenario: Successful login with valid creds
    Given a user "alice" exists
    When she submits her password
    Then she lands on the dashboard

  Scenario Outline: Validates field-level errors
    Given an empty <field>
    When the form is submitted
    Then an inline error is shown

    Examples:
      | field    |
      | email    |
      | password |

  # Trailing comment that should not be parsed as a keyword

  Scenario: Logout clears the session
    Given alice is signed in
    """
    Multi-line doc string
    Scenario: this should NOT be a real scenario
    """
    When she clicks "log out"
    Then she lands on the marketing page
`;

describe("parseScenarios", () => {
  it("captures feature name + description + background", () => {
    const f = parseScenarios(SAMPLE);
    expect(f.name).toBe("Login");
    expect(f.description).toContain("As a user");
    expect(f.background).toContain("Background:");
    expect(f.background).toContain("the auth service is up");
  });

  it("splits Scenario / Scenario Outline blocks", () => {
    const f = parseScenarios(SAMPLE);
    expect(f.scenarios).toHaveLength(3);
    expect(f.scenarios[0].keyword).toBe("Scenario");
    expect(f.scenarios[1].keyword).toBe("Scenario Outline");
    expect(f.scenarios[2].keyword).toBe("Scenario");
  });

  it("attaches Examples table to its Scenario Outline", () => {
    const outline = parseScenarios(SAMPLE).scenarios[1];
    expect(outline.body).toContain("Examples:");
    expect(outline.body).toContain("| email    |");
  });

  it("ignores keyword-shaped lines inside doc strings", () => {
    const last = parseScenarios(SAMPLE).scenarios[2];
    // The fake "Scenario:" inside the doc-string must be retained as
    // body content (so the prompt sees it) but not split into a
    // separate scenario entry.
    expect(last.name).toBe("Logout clears the session");
    expect(last.body).toContain("Multi-line doc string");
    expect(parseScenarios(SAMPLE).scenarios).toHaveLength(3);
  });

  it("derives a stable id slug from each scenario name", () => {
    const ids = parseScenarios(SAMPLE).scenarios.map((s) => s.id);
    expect(ids[0]).toMatch(/^s1-/);
    expect(ids).toEqual([...new Set(ids)]); // unique
  });

  it("treats a Rule keyword as a section boundary without crashing", () => {
    const src = `Feature: With rule\n  Rule: a rule\n    Scenario: under rule\n      Given x\n`;
    const f = parseScenarios(src);
    expect(f.scenarios).toHaveLength(1);
    expect(f.scenarios[0].name).toBe("under rule");
  });
});

describe("buildAmigoPrompt", () => {
  it("emits a persona-specific system prompt", () => {
    const f = parseScenarios(SAMPLE);
    const s = f.scenarios[0];
    const biz = buildAmigoPrompt("business", f, s, "features/login.feature");
    const dev = buildAmigoPrompt("dev", f, s, "features/login.feature");
    const qa = buildAmigoPrompt("qa", f, s, "features/login.feature");
    expect(biz.system).toMatch(/BUSINESS amigo/);
    expect(dev.system).toMatch(/DEV amigo/);
    expect(qa.system).toMatch(/QA amigo/);
    expect(biz.system).toMatch(/strict JSON/);
  });

  it("includes the feature path, background, and scenario body", () => {
    const f = parseScenarios(SAMPLE);
    const { user } = buildAmigoPrompt(
      "business",
      f,
      f.scenarios[0],
      "features/login.feature",
    );
    expect(user).toContain("features/login.feature");
    expect(user).toContain("Background:");
    expect(user).toContain("Successful login");
  });
});

describe("parseAmigoReply", () => {
  it("parses a clean reply", () => {
    const r = parseAmigoReply(
      "qa",
      '{"summary":"looks good","findings":[{"severity":"concern","message":"add a negative case"}]}',
    );
    expect(r.ok).toBe(true);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].severity).toBe("concern");
    expect(r.findings[0].persona).toBe("qa");
  });

  it("strips code fences", () => {
    const r = parseAmigoReply("dev", '```json\n{"summary":"x","findings":[]}\n```');
    expect(r.ok).toBe(true);
    expect(r.summary).toBe("x");
  });

  it("recovers the JSON object from surrounding prose", () => {
    const r = parseAmigoReply(
      "business",
      'Here is my review: {"summary":"k","findings":[]} thanks',
    );
    expect(r.ok).toBe(true);
  });

  it("normalizes friendly severity aliases", () => {
    const r = parseAmigoReply(
      "qa",
      '{"summary":"","findings":[{"severity":"critical","message":"boom"},{"severity":"warning","message":"meh"}]}',
    );
    expect(r.findings[0].severity).toBe("blocker");
    expect(r.findings[1].severity).toBe("concern");
  });

  it("returns ok=false on garbage", () => {
    const r = parseAmigoReply("dev", "not json at all");
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it("caps the number of findings", () => {
    const findings = Array.from({ length: 50 }, (_, i) => ({
      severity: "info",
      message: `n${i}`,
    }));
    const r = parseAmigoReply(
      "qa",
      JSON.stringify({ summary: "", findings }),
    );
    expect(r.findings.length).toBeLessThanOrEqual(20);
  });
});

describe("mergeAmigoVerdicts", () => {
  const ok = (
    persona: "business" | "dev" | "qa",
    findings: { severity: "blocker" | "concern" | "info"; message: string }[] = [],
  ): AmigoResult => ({
    persona,
    ok: true,
    summary: "",
    findings: findings.map((f) => ({ persona, ...f })),
  });

  it("pass when all amigos green", () => {
    expect(
      mergeAmigoVerdicts([ok("business"), ok("dev"), ok("qa")]).verdict,
    ).toBe("pass");
  });

  it("concerns when any amigo flags a non-blocker", () => {
    expect(
      mergeAmigoVerdicts([
        ok("business", [{ severity: "concern", message: "x" }]),
        ok("dev"),
        ok("qa"),
      ]).verdict,
    ).toBe("concerns");
  });

  it("fail when any amigo flags a blocker", () => {
    expect(
      mergeAmigoVerdicts([
        ok("business", [{ severity: "concern", message: "x" }]),
        ok("dev", [{ severity: "blocker", message: "missing AC" }]),
        ok("qa"),
      ]).verdict,
    ).toBe("fail");
  });

  it("treats an amigo error as a concern, not a blocker", () => {
    const errored: AmigoResult = {
      persona: "qa",
      ok: false,
      summary: "",
      findings: [],
      error: "timeout",
    };
    const m = mergeAmigoVerdicts([ok("business"), ok("dev"), errored]);
    expect(m.verdict).toBe("concerns");
    expect(m.findings.some((f) => f.message.includes("timeout"))).toBe(true);
  });
});

describe("extractJsonObject", () => {
  it("returns null when no object is present", () => {
    expect(extractJsonObject("nope")).toBeNull();
  });
  it("handles strings with braces inside", () => {
    expect(extractJsonObject('x { "a": "}", "b": 1 } y')).toBe(
      '{ "a": "}", "b": 1 }',
    );
  });
});

describe("runAmigos · with injected fake gateway", () => {
  let tmp: string;

  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "amigos-test-"));
    tmp = await fs.realpath(tmp);
    process.env.CLAUDE_CODEX_WORKSPACE = tmp;
    await fs.mkdir(path.join(tmp, "features"), { recursive: true });
    await fs.writeFile(path.join(tmp, "features", "login.feature"), SAMPLE);
    // A noisy node_modules directory is intentionally created to
    // verify the walker skips it.
    await fs.mkdir(path.join(tmp, "node_modules", "ignored"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(tmp, "node_modules", "ignored", "x.feature"),
      "Feature: should be ignored\n  Scenario: nope\n    Given x\n",
    );
    // Reset modules so workspace.ts re-reads CLAUDE_CODEX_WORKSPACE.
    vi.resetModules();
  });

  afterAll(async () => {
    delete process.env.CLAUDE_CODEX_WORKSPACE;
    await fs.rm(tmp, { recursive: true, force: true });
    vi.resetModules();
  });

  it("walks the workspace, skips node_modules, and produces a per-scenario verdict", async () => {
    const { runAmigos } = await import("./amigos");
    const events: AmigosEvent[] = [];
    const report = await runAmigos({
      scope: { type: "all" },
      model: "test-model",
      onEvent: (e) => events.push(e),
      amigoFn: async ({ persona, scenario }) => {
        // Business is happy, Dev finds a concern, QA finds a blocker
        // on the first scenario only — every other scenario is clean
        // so we can pin the verdict shape.
        if (persona === "qa" && scenario.name.startsWith("Successful")) {
          return {
            persona,
            ok: true,
            summary: "missing negative path",
            findings: [
              {
                persona,
                severity: "blocker",
                message: "no failed-login scenario",
              },
            ],
          };
        }
        if (persona === "dev" && scenario.name.startsWith("Successful")) {
          return {
            persona,
            ok: true,
            summary: "",
            findings: [
              { persona, severity: "concern", message: "what defines 'lands on'?" },
            ],
          };
        }
        return { persona, ok: true, summary: "ok", findings: [] };
      },
    });

    expect(report.scanned).toBe(3); // 3 scenarios in features/login.feature, node_modules ignored
    expect(report.fail).toBe(1);
    expect(report.pass).toBe(2);
    expect(
      report.scenarios.find((s) => s.scenarioName.startsWith("Successful"))
        ?.verdict,
    ).toBe("fail");

    // Streaming events fired in the right rough order.
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("discovered");
    expect(types).toContain("scenario_started");
    expect(types).toContain("scenario_done");
    expect(types[types.length - 1]).toBe("summary");
  });

  it("aborts via signal and reports `aborted`", async () => {
    const { runAmigos } = await import("./amigos");
    const ctrl = new AbortController();
    ctrl.abort();
    const report = await runAmigos({
      scope: { type: "all" },
      model: "test-model",
      signal: ctrl.signal,
      amigoFn: async ({ persona }) => ({
        persona,
        ok: true,
        summary: "",
        findings: [],
      }),
    });
    expect(report.error).toBe("aborted");
  });
});

describe("overallVerdict", () => {
  it("rolls up scenario counts to a single verdict", () => {
    expect(
      overallVerdict({
        startedAt: 0,
        scope: { type: "all" },
        total: 1,
        scanned: 1,
        pass: 1,
        concerns: 0,
        fail: 0,
        scenarios: [],
      }),
    ).toBe("pass");
    expect(
      overallVerdict({
        startedAt: 0,
        scope: { type: "all" },
        total: 1,
        scanned: 1,
        pass: 0,
        concerns: 1,
        fail: 0,
        scenarios: [],
      }),
    ).toBe("concerns");
    expect(
      overallVerdict({
        startedAt: 0,
        scope: { type: "all" },
        total: 1,
        scanned: 1,
        pass: 0,
        concerns: 0,
        fail: 1,
        scenarios: [],
      }),
    ).toBe("fail");
  });
});
