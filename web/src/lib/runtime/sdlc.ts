/**
 * SDLC state machine for the v2 auto-drive.
 *
 * The "endless" multi-agent loop walks through five gates in order
 * before declaring a goal **delivered**. Each gate has a predicate
 * that the loop can run between planner steps; the loop only advances
 * when the current gate passes. A planner that emits `done` while a
 * gate is still red is treated as "this stage is complete" and the
 * machine advances; the loop refuses to terminate while any gate is
 * still red, so endless mode keeps planning until either delivery
 * completes or the operator hits the kill switch.
 *
 * The helpers in this file are pure (no I/O) so the state machine
 * can be unit-tested without spinning up the full runtime. The
 * concrete gate predicates that DO touch disk live in `drive-v2.ts`.
 */

export const SDLC_STAGES = [
  "spec",
  "bdd",
  "impl",
  "test",
  "deploy",
] as const;

export type SdlcStage = (typeof SDLC_STAGES)[number];
/** Terminal "all gates green" state. */
export type SdlcDelivered = "delivered";
export type SdlcPosition = SdlcStage | SdlcDelivered;

/** Gate result for a single stage. */
export type GateStatus = "pending" | "green" | "red";

export type SdlcGates = Record<SdlcStage, GateStatus>;

export interface SdlcState {
  stage: SdlcPosition;
  gates: SdlcGates;
}

export const INITIAL_SDLC_STATE: SdlcState = {
  stage: "spec",
  gates: {
    spec: "pending",
    bdd: "pending",
    impl: "pending",
    test: "pending",
    deploy: "pending",
  },
};

/** Stage immediately after `s`, or `"delivered"` if `s` is the last. */
export function nextStage(s: SdlcStage): SdlcPosition {
  const i = SDLC_STAGES.indexOf(s);
  if (i < 0) return "spec";
  if (i === SDLC_STAGES.length - 1) return "delivered";
  return SDLC_STAGES[i + 1];
}

/** True once every stage has flipped to "green". */
export function isDelivered(state: SdlcState): boolean {
  if (state.stage !== "delivered") return false;
  return SDLC_STAGES.every((s) => state.gates[s] === "green");
}

/**
 * Mark the current stage's gate (`status`) and, on green, advance to
 * the next stage. `red` keeps the position so the loop can retry.
 *
 * Returns the new state — pure, never mutates the input.
 */
export function recordGate(state: SdlcState, status: GateStatus): SdlcState {
  if (state.stage === "delivered") return state;
  const gates: SdlcGates = { ...state.gates, [state.stage]: status };
  if (status !== "green") {
    return { stage: state.stage, gates };
  }
  return { stage: nextStage(state.stage), gates };
}

/**
 * Hint shown to the planner so it knows *which* SDLC stage it is
 * working on. Surfaced verbatim in the system prompt by drive-v2.
 */
export function stagePromptHint(stage: SdlcPosition): string {
  switch (stage) {
    case "spec":
      return "STAGE: spec — clarify the goal in writing (e.g. SPEC.md). Read existing specs first; write or refine the spec.";
    case "bdd":
      return "STAGE: bdd — capture the acceptance criteria as Gherkin in features/*.feature. Use the `feature_file` tool.";
    case "impl":
      return "STAGE: impl — implement the smallest change that satisfies the spec + features. Prefer write_file/exec.";
    case "test":
      return "STAGE: test — run the test suite. Use the `cucumber` tool to verify the BDD specs and `exec npm test` for unit tests. Iterate until green.";
    case "deploy":
      return "STAGE: deploy — once tests are green, invoke the `deploy` tool.";
    case "delivered":
      return "STAGE: delivered — all gates are green. Emit `done`.";
  }
}

/**
 * Pure helper: which personas should run this step in round-robin
 * order. The endless loop alternates personas on every step so all
 * three perspectives (core/impl/review) get airtime over the run.
 */
export const PERSONA_ROTATION = ["core", "impl", "review"] as const;
export type PersonaRotationId = (typeof PERSONA_ROTATION)[number];

export function personaForStep(stepIndex: number): PersonaRotationId {
  const i =
    ((stepIndex % PERSONA_ROTATION.length) + PERSONA_ROTATION.length) %
    PERSONA_ROTATION.length;
  return PERSONA_ROTATION[i];
}
