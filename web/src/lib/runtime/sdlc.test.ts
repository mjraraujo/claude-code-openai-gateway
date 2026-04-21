import { describe, expect, it } from "vitest";

import {
  INITIAL_SDLC_STATE,
  isDelivered,
  nextStage,
  PERSONA_ROTATION,
  personaForStep,
  recordGate,
  SDLC_STAGES,
  stagePromptHint,
} from "./sdlc";

describe("sdlc · nextStage", () => {
  it("advances through the canonical order", () => {
    expect(nextStage("spec")).toBe("bdd");
    expect(nextStage("bdd")).toBe("impl");
    expect(nextStage("impl")).toBe("test");
    expect(nextStage("test")).toBe("deploy");
  });
  it("advances past the last stage to 'delivered'", () => {
    expect(nextStage("deploy")).toBe("delivered");
  });
});

describe("sdlc · recordGate", () => {
  it("advances on green", () => {
    const after = recordGate(INITIAL_SDLC_STATE, "green");
    expect(after.stage).toBe("bdd");
    expect(after.gates.spec).toBe("green");
  });

  it("stays put on red", () => {
    const after = recordGate(INITIAL_SDLC_STATE, "red");
    expect(after.stage).toBe("spec");
    expect(after.gates.spec).toBe("red");
  });

  it("never mutates the input state", () => {
    const before = structuredClone(INITIAL_SDLC_STATE);
    recordGate(INITIAL_SDLC_STATE, "green");
    expect(INITIAL_SDLC_STATE).toEqual(before);
  });

  it("delivered is a no-op", () => {
    const delivered = {
      stage: "delivered" as const,
      gates: {
        spec: "green",
        bdd: "green",
        impl: "green",
        test: "green",
        deploy: "green",
      } as const,
    };
    expect(recordGate(delivered, "green")).toBe(delivered);
  });

  it("walks all the way to delivered when each gate flips green", () => {
    let s = INITIAL_SDLC_STATE;
    for (let i = 0; i < SDLC_STAGES.length; i++) {
      s = recordGate(s, "green");
    }
    expect(s.stage).toBe("delivered");
    expect(isDelivered(s)).toBe(true);
  });
});

describe("sdlc · isDelivered", () => {
  it("is false until every gate is green", () => {
    expect(isDelivered(INITIAL_SDLC_STATE)).toBe(false);
  });
  it("is false when stage is delivered but a gate is red", () => {
    const s = {
      stage: "delivered" as const,
      gates: {
        spec: "green",
        bdd: "green",
        impl: "green",
        test: "red",
        deploy: "green",
      } as const,
    };
    expect(isDelivered(s)).toBe(false);
  });
});

describe("sdlc · personaForStep", () => {
  it("rotates through core/impl/review", () => {
    expect(personaForStep(0)).toBe("core");
    expect(personaForStep(1)).toBe("impl");
    expect(personaForStep(2)).toBe("review");
    expect(personaForStep(3)).toBe("core");
  });

  it("handles negative indexes without throwing", () => {
    expect(PERSONA_ROTATION).toContain(personaForStep(-1));
    expect(PERSONA_ROTATION).toContain(personaForStep(-7));
  });
});

describe("sdlc · stagePromptHint", () => {
  it("returns a non-empty hint for every stage", () => {
    for (const s of SDLC_STAGES) {
      expect(stagePromptHint(s)).toMatch(/STAGE:/);
    }
    expect(stagePromptHint("delivered")).toMatch(/delivered/);
  });
});
