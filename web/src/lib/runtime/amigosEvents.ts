/**
 * Pure helpers around the Three Amigos transcript event model.
 *
 * The end-state per the plan (PR 7) is a chat-room layout where
 * each amigo persona streams its own messages and the team
 * converges on a refined story. The runtime store already carries
 * the `amigosTranscript` field on `Task` (see
 * `AmigosTranscriptEntry` in `./store`); this module exposes:
 *
 *   - The `AmigosEvent` discriminated union — what a streaming
 *     amigos run yields, ready to mirror over SSE.
 *   - `eventToTranscriptEntry()` — pure mapper that turns an event
 *     into the persisted form so reloading a card shows history.
 *   - `featureFromConsensus()` — pure helper that builds the
 *     `<feature>.feature` Gherkin file written under
 *     `<workspace>/features/` on consensus.
 *
 * Keeping these pure and stateless mirrors the project convention
 * (see `terminalTabs.ts`, `webhook.ts`, `drive.ts`): the I/O
 * orchestration lives elsewhere; the helpers stay easy to test.
 */

import type { AmigosTranscriptEntry } from "./store";

/** Streamed event vocabulary for a Three Amigos run. */
export type AmigosEvent =
  | { type: "agent_thinking"; persona: string; at?: number }
  | { type: "agent_message"; persona: string; text: string; at?: number }
  | { type: "consensus"; text: string; at?: number }
  | { type: "gherkin_draft"; text: string; at?: number }
  | { type: "done"; summary: string; at?: number }
  | { type: "error"; message: string; at?: number };

/**
 * Coerce a streaming event into the persisted transcript entry
 * shape. Returns null for events we deliberately don't keep
 * (currently `agent_thinking` — typing indicators are noise on
 * reload).
 */
export function eventToTranscriptEntry(
  ev: AmigosEvent,
): AmigosTranscriptEntry | null {
  const at = ev.at ?? Date.now();
  switch (ev.type) {
    case "agent_thinking":
      return null;
    case "agent_message":
      return { at, kind: "agent_message", persona: ev.persona, text: ev.text };
    case "consensus":
      return { at, kind: "consensus", text: ev.text };
    case "gherkin_draft":
      return { at, kind: "gherkin_draft", text: ev.text };
    case "done":
      return { at, kind: "done", text: ev.summary };
    case "error":
      return { at, kind: "error", text: ev.message };
  }
}

/**
 * Build a minimal `Feature: …` document from a free-form consensus
 * summary. The summary is wrapped as a single Scenario so the file
 * is syntactically valid Gherkin even when the model returns prose
 * rather than structured Given/When/Then. Callers that already
 * have proper Gherkin should pass it through unchanged.
 */
export function featureFromConsensus(title: string, body: string): string {
  const safeTitle = title.replace(/\s+/g, " ").trim().slice(0, 120) || "Refined story";
  // If the body already looks like Gherkin, use it as-is so the
  // model can emit proper structure when it wants to.
  if (/^\s*Feature:/m.test(body)) return body.trim() + "\n";
  const indented = body
    .split(/\r?\n/)
    .map((line) => "    " + line)
    .join("\n");
  return `Feature: ${safeTitle}\n\n  Scenario: Refined story\n${indented}\n`;
}

/** Slugify a card title into a safe `<feature>.feature` filename. */
export function featureFilename(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${slug || "story"}.feature`;
}
