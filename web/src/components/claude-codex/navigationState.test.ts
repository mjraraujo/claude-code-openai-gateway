import { describe, expect, it } from "vitest";

import {
  DEFAULT_NAVIGATION_STATE,
  parseNavigationState,
} from "./navigationState";

describe("parseNavigationState", () => {
  it("parses a valid persisted navigation model", () => {
    const raw = JSON.stringify({
      mobileTab: "amigos",
      workspaceTab: "browser",
      rightTab: "chat",
    });

    expect(parseNavigationState(raw)).toEqual({
      mobileTab: "amigos",
      workspaceTab: "browser",
      rightTab: "chat",
    });
  });

  it("returns null when any tab id is invalid", () => {
    const raw = JSON.stringify({
      ...DEFAULT_NAVIGATION_STATE,
      workspaceTab: "unknown",
    });

    expect(parseNavigationState(raw)).toBeNull();
  });

  it("returns null for non-object payloads", () => {
    expect(parseNavigationState("[]")).toBeNull();
    expect(parseNavigationState("not-json")).toBeNull();
  });
});
