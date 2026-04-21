/**
 * Shared model preset list.
 *
 * Single source of truth for the model picker shown in the Agents
 * panel, the ChatDock, and (later) any settings drawer. Keeping
 * this in one place stops the surfaces from drifting — historically
 * the AgentsPanel had its own `MODELS` const while the ChatDock
 * displayed `harness.model` raw, which made it confusing when an
 * operator picked a model that one surface knew about and the other
 * didn't.
 *
 * The list is *not* a security boundary — `/api/runtime/harness`
 * accepts any matching `^[\w.\-:/]+$` string, and per-agent
 * overrides do the same. The presets are a UX nicety: nicer labels
 * + a hint at which gateway backend will receive the request.
 */

export interface ModelPreset {
  /** Free-form id sent to the gateway. */
  id: string;
  /** Human-friendly label for the dropdown. */
  label: string;
  /** Short hint at which backend route the gateway maps this to. */
  route: string;
}

export const MODEL_PRESETS: readonly ModelPreset[] = [
  { id: "gpt-5.4", label: "gpt-5.4", route: "claude-codex backend" },
  { id: "gpt-4o", label: "gpt-4o", route: "OpenAI Chat Completions" },
  { id: "sonnet-4.6", label: "claude-sonnet-4.6", route: "Anthropic" },
  { id: "haiku-4.5", label: "claude-haiku-4.5", route: "Anthropic" },
] as const;

export const DEFAULT_MODEL_ID: string = MODEL_PRESETS[0].id;

/** Look up a preset by id, or return undefined for custom values. */
export function findPreset(id: string | undefined | null): ModelPreset | undefined {
  if (!id) return undefined;
  return MODEL_PRESETS.find((m) => m.id === id);
}
