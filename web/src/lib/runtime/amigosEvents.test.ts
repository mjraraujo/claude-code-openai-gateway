/**
 * Tests for the pure Three Amigos event helpers (PR 7).
 */

import { describe, expect, it } from "vitest";

import {
  eventToTranscriptEntry,
  featureFilename,
  featureFromConsensus,
  type AmigosEvent,
} from "./amigosEvents";

describe("eventToTranscriptEntry", () => {
  it("drops agent_thinking events (typing indicators are noise on reload)", () => {
    expect(
      eventToTranscriptEntry({ type: "agent_thinking", persona: "dev" }),
    ).toBeNull();
  });

  it("maps agent_message preserving the persona", () => {
    const e: AmigosEvent = {
      type: "agent_message",
      persona: "qa",
      text: "what about the empty list case?",
      at: 1000,
    };
    expect(eventToTranscriptEntry(e)).toEqual({
      at: 1000,
      kind: "agent_message",
      persona: "qa",
      text: "what about the empty list case?",
    });
  });

  it("maps consensus / gherkin_draft / done / error", () => {
    expect(
      eventToTranscriptEntry({ type: "consensus", text: "ok", at: 1 })?.kind,
    ).toBe("consensus");
    expect(
      eventToTranscriptEntry({ type: "gherkin_draft", text: "Feature: x\n", at: 2 })
        ?.kind,
    ).toBe("gherkin_draft");
    expect(eventToTranscriptEntry({ type: "done", summary: "y", at: 3 })?.kind).toBe(
      "done",
    );
    expect(
      eventToTranscriptEntry({ type: "error", message: "boom", at: 4 })?.kind,
    ).toBe("error");
  });
});

describe("featureFromConsensus", () => {
  it("wraps prose as a Feature/Scenario block", () => {
    const out = featureFromConsensus("Login flow", "User logs in with email.");
    expect(out).toMatch(/^Feature: Login flow\n/);
    expect(out).toMatch(/Scenario: Refined story/);
    expect(out).toMatch(/User logs in with email\./);
  });

  it("passes through input that is already Gherkin", () => {
    const gherkin = "Feature: Already done\n\n  Scenario: x\n    Given y\n";
    expect(featureFromConsensus("ignored", gherkin)).toBe(gherkin.trim() + "\n");
  });
});

describe("featureFilename", () => {
  it("slugifies and adds .feature", () => {
    expect(featureFilename("Add Login Flow!")).toBe("add-login-flow.feature");
  });
  it("falls back to 'story' for unprintable input", () => {
    expect(featureFilename("***")).toBe("story.feature");
  });
});
