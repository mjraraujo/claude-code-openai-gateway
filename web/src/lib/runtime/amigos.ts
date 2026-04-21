/**
 * Three Amigos AI BDD validation.
 *
 * Static review pass for every Gherkin scenario in the workspace.
 * Each scenario is fanned out to three persona prompts in parallel
 * (Business / Dev / QA); each persona returns a structured verdict,
 * and a pure reducer merges them into a final per-scenario verdict.
 *
 * This module owns the *pure* helpers — Gherkin discovery and
 * parsing, prompt building, the merge reducer, and the JSON parser
 * for model output. The orchestration that talks to the gateway and
 * mutates the runtime store lives in `runAmigos()` (see bottom of
 * file) so the helpers here can be unit-tested without any I/O or
 * network mocking.
 *
 * Design notes:
 *   - Mirrors the lightness of `terminalTabs.ts` — regex-based
 *     Gherkin splitter, no new dep, "good enough" for the static
 *     review use case. Cucumber stays as the executable gate.
 *   - All filesystem walking goes through `safeJoin()` so a bad
 *     `WORKSPACE_ROOT` symlink can't escape the workspace.
 *   - Gateway calls follow the same Anthropic-shaped streaming
 *     pattern as the planner (`livePlan`): POST + SSE + drain via
 *     `consumeAnthropicStream`.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import { getOrCreateSessionApiKey, getValidToken } from "@/lib/auth/storage";
import { consumeAnthropicStream } from "@/lib/gateway/anthropicStream";
import {
  assertInsideWorkspace,
  safeJoin,
  toRelative,
  WORKSPACE_ROOT,
} from "@/lib/fs/workspace";

import { getGatewayUrl } from "./gateway";
import { DEFAULT_MODEL } from "./store";

/* ─── Types ─────────────────────────────────────────────────────────── */

export type AmigoPersona = "business" | "dev" | "qa";
export const AMIGO_PERSONAS: readonly AmigoPersona[] = [
  "business",
  "dev",
  "qa",
];

/** Severity flagged by an individual amigo finding. */
export type FindingSeverity = "blocker" | "concern" | "info";

export interface AmigoFinding {
  persona: AmigoPersona;
  severity: FindingSeverity;
  message: string;
}

/** Aggregate verdict for a single scenario after merging all amigos. */
export type ScenarioVerdict = "pass" | "concerns" | "fail";

export interface AmigoResult {
  persona: AmigoPersona;
  /** True iff the model returned a parseable response (vs. timeout / parse error). */
  ok: boolean;
  /** Free-form summary the model emitted under its `summary` key. */
  summary: string;
  findings: AmigoFinding[];
  /** When `ok` is false this carries the underlying reason. */
  error?: string;
}

export interface ScenarioReport {
  featurePath: string;
  scenarioId: string;
  scenarioName: string;
  verdict: ScenarioVerdict;
  findings: AmigoFinding[];
  amigos: AmigoResult[];
}

export interface AmigosReport {
  startedAt: number;
  endedAt?: number;
  scope: AmigosScope;
  total: number;
  scanned: number;
  pass: number;
  concerns: number;
  fail: number;
  scenarios: ScenarioReport[];
  /** Set on terminal failure (e.g. cap exceeded, aborted). */
  error?: string;
}

export type AmigosScope =
  | { type: "all" }
  | { type: "feature"; path: string }
  | { type: "scenario"; path: string; scenarioId: string };

/* ─── Tunables ─────────────────────────────────────────────────────── */

/** Hard cap on scenarios per run, override via `CLAUDE_CODEX_AMIGOS_MAX`. */
export const DEFAULT_MAX_SCENARIOS = 200;
/** Max scenarios in flight at once. */
export const DEFAULT_CONCURRENCY = 3;
/** Per-persona request timeout (ms). */
export const PER_AMIGO_TIMEOUT_MS = 60_000;
/** Cap on the prompt the model sees (chars). */
const MAX_FEATURE_PROMPT_CHARS = 6_000;
/** Cap on findings per amigo (the model shouldn't dump 100 nits). */
const MAX_FINDINGS_PER_AMIGO = 20;
/** Cap on a single finding message (chars). */
const MAX_FINDING_MESSAGE_CHARS = 600;
/** Max files we'll walk when discovering features (defends against huge trees). */
const MAX_WALK_ENTRIES = 5_000;
/** Directories we never descend into. */
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  "build",
  "out",
  "coverage",
  ".turbo",
  ".venv",
  "venv",
  "target",
]);

export function getMaxScenarios(): number {
  const raw = process.env.CLAUDE_CODEX_AMIGOS_MAX;
  if (!raw) return DEFAULT_MAX_SCENARIOS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_SCENARIOS;
  return Math.min(n, 5_000);
}

/* ─── Discovery ────────────────────────────────────────────────────── */

export interface FeatureFile {
  /** Absolute path on disk, already realpath'd inside the workspace. */
  path: string;
  /** Path relative to `WORKSPACE_ROOT`, POSIX-style separators. */
  relPath: string;
  source: string;
}

/**
 * Walk the workspace and return every `*.feature` file (capped).
 * Symlinks pointing outside the workspace are dropped silently.
 */
export async function discoverFeatures(): Promise<FeatureFile[]> {
  const out: FeatureFile[] = [];
  let visited = 0;

  async function walk(dir: string): Promise<void> {
    if (visited >= MAX_WALK_ENTRIES) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      visited++;
      if (visited >= MAX_WALK_ENTRIES) return;
      if (SKIP_DIRS.has(ent.name)) continue;
      const child = path.join(dir, ent.name);
      // Re-validate every path through safeJoin so a symlink can't
      // smuggle us out of the workspace.
      let safe: string;
      try {
        safe = await safeJoin(toRelative(child));
        assertInsideWorkspace(safe);
      } catch {
        continue;
      }
      if (ent.isDirectory()) {
        await walk(safe);
      } else if (ent.isFile() && safe.endsWith(".feature")) {
        try {
          const source = await fs.readFile(safe, "utf8");
          out.push({
            path: safe,
            relPath: toRelative(safe),
            source,
          });
        } catch {
          // Skip unreadable file.
        }
      }
    }
  }

  await walk(WORKSPACE_ROOT);
  // Stable order so the UI doesn't shuffle between runs.
  out.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return out;
}

/**
 * Read a single feature file by its workspace-relative path.
 * Public so route handlers can scope a run to one feature without
 * re-walking the whole tree.
 */
export async function readFeatureFile(relPath: string): Promise<FeatureFile> {
  const safe = await safeJoin(relPath);
  assertInsideWorkspace(safe);
  if (!safe.endsWith(".feature")) {
    throw new Error("not a feature file");
  }
  const source = await fs.readFile(safe, "utf8");
  return { path: safe, relPath: toRelative(safe), source };
}

/* ─── Gherkin parser ───────────────────────────────────────────────── */

export interface ParsedFeature {
  /** Feature title (text after `Feature:`). Empty if absent. */
  name: string;
  /** Free-form description block between Feature and the first child. */
  description: string;
  /** Verbatim Background block (including the keyword line) or "". */
  background: string;
  scenarios: ParsedScenario[];
}

export interface ParsedScenario {
  /** Stable id derived from the feature path + scenario index + name. */
  id: string;
  /** "Scenario" or "Scenario Outline". */
  keyword: "Scenario" | "Scenario Outline";
  name: string;
  /** Verbatim block (including the keyword line). */
  body: string;
  /** Line number the scenario keyword appears on (1-based). */
  line: number;
}

const KEYWORD_RE =
  /^[ \t]*(Feature|Background|Scenario Outline|Scenario|Rule|Example|Examples)\s*:/;

/**
 * Minimal Gherkin splitter.
 *
 * We don't run the official parser — too heavy for what we need
 * (a list of "here's a scenario block, here's its name") and would
 * pull in a new dep. Instead we walk the file line-by-line, watching
 * for top-level keywords that start a new section. We are aware of
 * the `Scenario Outline` + `Examples` pairing (the Examples table
 * is appended to the outline body) and Doc Strings (`"""` /
 * `` ``` ``) and `# comments` so they don't fool the keyword
 * detector.
 *
 * Returns sections verbatim so the resulting prompt to the model is
 * the operator's actual Gherkin (no normalisation surprises).
 */
export function parseScenarios(source: string): ParsedFeature {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const feature: ParsedFeature = {
    name: "",
    description: "",
    background: "",
    scenarios: [],
  };

  type Section = "preamble" | "description" | "background" | "scenario";
  let section: Section = "preamble";
  let bgLines: string[] = [];
  let curScenario: ParsedScenario | null = null;
  let curScenarioLines: string[] = [];
  let descLines: string[] = [];

  let inDocString: false | '"""' | "```" = false;
  let scenarioIndex = 0;

  const flushScenario = () => {
    if (!curScenario) return;
    curScenario.body = curScenarioLines.join("\n").replace(/\s+$/, "");
    feature.scenarios.push(curScenario);
    curScenario = null;
    curScenarioLines = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Doc-string toggling. Only trigger on lines that *start* with
    // the fence (allowing leading whitespace).
    if (inDocString) {
      if (trimmed === inDocString) inDocString = false;
      // Either way, append the line to whatever section we're in.
      if (section === "background") bgLines.push(line);
      else if (section === "scenario") curScenarioLines.push(line);
      else if (section === "description") descLines.push(line);
      continue;
    }
    if (trimmed === '"""' || trimmed === "```") {
      inDocString = trimmed as '"""' | "```";
      if (section === "background") bgLines.push(line);
      else if (section === "scenario") curScenarioLines.push(line);
      else if (section === "description") descLines.push(line);
      continue;
    }

    // Skip comments at the top level of the file but DO keep them
    // inside scenario / background bodies so the prompt sees the
    // operator's intent.
    const isComment = trimmed.startsWith("#");
    const kwMatch = !isComment ? KEYWORD_RE.exec(line) : null;

    if (kwMatch) {
      const kw = kwMatch[1];
      const colonIdx = line.indexOf(":");
      const title = colonIdx >= 0 ? line.slice(colonIdx + 1).trim() : "";
      switch (kw) {
        case "Feature": {
          feature.name = title;
          section = "description";
          descLines = [];
          continue;
        }
        case "Background": {
          flushScenario();
          section = "background";
          bgLines = [line];
          continue;
        }
        case "Scenario":
        case "Scenario Outline": {
          flushScenario();
          scenarioIndex++;
          section = "scenario";
          curScenario = {
            id: scenarioId(scenarioIndex, title),
            keyword: kw === "Scenario Outline" ? "Scenario Outline" : "Scenario",
            name: title,
            body: "",
            line: i + 1,
          };
          curScenarioLines = [line];
          continue;
        }
        case "Rule": {
          // A Rule keyword resets back to the preamble — we treat it
          // as another descriptive boundary; following Scenarios are
          // captured as usual. We don't model rules separately.
          flushScenario();
          section = "preamble";
          continue;
        }
        case "Examples":
        case "Example": {
          // Examples table belongs to the current Scenario Outline.
          if (section === "scenario" && curScenario) {
            curScenarioLines.push(line);
          }
          continue;
        }
      }
    }

    // Non-keyword line — append to the active section.
    if (section === "background") {
      bgLines.push(line);
    } else if (section === "scenario") {
      curScenarioLines.push(line);
    } else if (section === "description") {
      descLines.push(line);
    }
  }
  flushScenario();

  feature.background = bgLines.join("\n").replace(/\s+$/, "");
  feature.description = descLines.join("\n").trim();
  return feature;
}

function scenarioId(index: number, name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `s${index}${slug ? `-${slug}` : ""}`;
}

/* ─── Prompt building ──────────────────────────────────────────────── */

const PERSONA_BRIEFS: Record<AmigoPersona, string> = {
  business:
    "You are the BUSINESS amigo of a Three Amigos review. Focus on " +
    "clarity, business value, ambiguous acceptance criteria, and " +
    "missing edge cases from a product / customer perspective. Do " +
    "not flag implementation concerns — only spec-level issues.",
  dev:
    "You are the DEV amigo of a Three Amigos review. Focus on " +
    "technical feasibility, hidden assumptions, testability, and " +
    "missing pre/post-conditions. Flag scenarios that are ambiguous " +
    "to implement or that hide complexity. Do not propose code.",
  qa:
    "You are the QA amigo of a Three Amigos review. Focus on " +
    "testability, observability, missing negative paths, missing " +
    "data variants, and non-functional gaps (perf, security, a11y). " +
    "Flag scenarios that cannot be reliably automated.",
};

const RESPONSE_SHAPE = [
  "Respond with strict JSON only, no prose, no code fences. Shape:",
  "{",
  '  "summary": "<one-sentence overall verdict>",',
  '  "findings": [',
  '    { "severity": "blocker" | "concern" | "info", "message": "<short, specific>" },',
  "    ...",
  "  ]",
  "}",
  'Use "blocker" only for issues that should fail the review (e.g. ambiguous Then, missing acceptance criteria). Empty `findings` array means the scenario is good as-is.',
].join("\n");

/**
 * Build the prompt the model sees for one (persona, scenario) pair.
 * Pure helper — exported for tests and snapshot pinning.
 */
export function buildAmigoPrompt(
  persona: AmigoPersona,
  feature: ParsedFeature,
  scenario: ParsedScenario,
  featurePath: string,
): { system: string; user: string } {
  const system = [
    PERSONA_BRIEFS[persona],
    "",
    RESPONSE_SHAPE,
  ].join("\n");

  const blocks: string[] = [`FEATURE FILE: ${featurePath}`];
  if (feature.name) blocks.push(`Feature: ${feature.name}`);
  if (feature.description) {
    blocks.push("Description:", truncate(feature.description, 1000));
  }
  if (feature.background) {
    blocks.push("Background:", truncate(feature.background, 1500));
  }
  blocks.push(`Scenario under review (line ${scenario.line}):`);
  blocks.push(truncate(scenario.body, 3000));

  let user = blocks.join("\n\n");
  if (user.length > MAX_FEATURE_PROMPT_CHARS) {
    user = user.slice(0, MAX_FEATURE_PROMPT_CHARS) + "\n... [truncated]";
  }
  return { system, user };
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "\n... [truncated]" : s;
}

/* ─── JSON parsing of amigo replies ────────────────────────────────── */

/**
 * Parse a single amigo's raw text reply into a structured result.
 * Lenient: strips code fences, recovers the outermost JSON object,
 * coerces unknown severities to "concern", and caps list size /
 * message length so a runaway model can't blow up the report.
 *
 * Always returns a result — never throws — so a single bad reply
 * doesn't tank the whole scenario. `ok=false` signals a parse miss.
 */
export function parseAmigoReply(persona: AmigoPersona, raw: string): AmigoResult {
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  const candidate = extractJsonObject(cleaned) ?? cleaned;
  let obj: unknown;
  try {
    obj = JSON.parse(candidate);
  } catch {
    return {
      persona,
      ok: false,
      summary: "",
      findings: [],
      error: "could not parse amigo reply as JSON",
    };
  }
  if (!obj || typeof obj !== "object") {
    return {
      persona,
      ok: false,
      summary: "",
      findings: [],
      error: "amigo reply was not an object",
    };
  }
  const r = obj as Record<string, unknown>;
  const summary =
    typeof r.summary === "string"
      ? r.summary.slice(0, MAX_FINDING_MESSAGE_CHARS)
      : "";
  const findings: AmigoFinding[] = [];
  if (Array.isArray(r.findings)) {
    for (const item of r.findings) {
      if (findings.length >= MAX_FINDINGS_PER_AMIGO) break;
      if (!item || typeof item !== "object") continue;
      const f = item as Record<string, unknown>;
      const message =
        typeof f.message === "string"
          ? f.message.trim().slice(0, MAX_FINDING_MESSAGE_CHARS)
          : "";
      if (!message) continue;
      const severity = normalizeSeverity(f.severity);
      findings.push({ persona, severity, message });
    }
  }
  return { persona, ok: true, summary, findings };
}

function normalizeSeverity(raw: unknown): FindingSeverity {
  if (raw === "blocker" || raw === "concern" || raw === "info") return raw;
  // Friendly aliases the model might emit.
  if (raw === "fail" || raw === "critical" || raw === "high") return "blocker";
  if (raw === "warning" || raw === "medium" || raw === "low") return "concern";
  return "concern";
}

/** Slice out the outermost balanced `{ … }` from a string. */
export function extractJsonObject(s: string): string | null {
  const start = s.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (escape) escape = false;
      else if (c === "\\") escape = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

/* ─── Verdict reducer ──────────────────────────────────────────────── */

/**
 * Pure reducer: any blocker → "fail"; any concern (or amigo error)
 * → "concerns"; otherwise → "pass".
 *
 * An amigo whose reply failed to parse is treated as a `concern`
 * (not a blocker) — operators usually want to retry rather than
 * block CI on a model hiccup.
 */
export function mergeAmigoVerdicts(
  results: AmigoResult[],
): { verdict: ScenarioVerdict; findings: AmigoFinding[] } {
  const findings: AmigoFinding[] = [];
  let hasBlocker = false;
  let hasConcern = false;

  for (const r of results) {
    if (!r.ok) {
      hasConcern = true;
      findings.push({
        persona: r.persona,
        severity: "concern",
        message: `amigo unavailable: ${r.error ?? "unknown error"}`,
      });
      continue;
    }
    for (const f of r.findings) {
      findings.push(f);
      if (f.severity === "blocker") hasBlocker = true;
      else if (f.severity === "concern") hasConcern = true;
    }
  }

  const verdict: ScenarioVerdict = hasBlocker
    ? "fail"
    : hasConcern
      ? "concerns"
      : "pass";
  return { verdict, findings };
}

/* ─── Gateway client ───────────────────────────────────────────────── */

/**
 * Call the local gateway with one (persona, scenario) prompt and
 * return the parsed amigo result. Times out after
 * `PER_AMIGO_TIMEOUT_MS`; the caller's `signal` aborts immediately.
 *
 * Returns a `concern`-shaped error result rather than throwing so
 * one bad request doesn't tank the surrounding scenario.
 */
export async function callAmigo(input: {
  persona: AmigoPersona;
  feature: ParsedFeature;
  scenario: ParsedScenario;
  featurePath: string;
  model: string;
  signal?: AbortSignal;
}): Promise<AmigoResult> {
  const { persona, feature, scenario, featurePath, model, signal } = input;
  const token = await getValidToken();
  if (!token) {
    return {
      persona,
      ok: false,
      summary: "",
      findings: [],
      error: "no_gateway_token",
    };
  }

  const apiKey = await getOrCreateSessionApiKey();
  const { system, user } = buildAmigoPrompt(
    persona,
    feature,
    scenario,
    featurePath,
  );

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PER_AMIGO_TIMEOUT_MS);
  const onAbort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener("abort", onAbort);
  }

  let res: Response;
  try {
    res = await fetch(getGatewayUrl(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: model || DEFAULT_MODEL,
        system,
        messages: [{ role: "user", content: user }],
        max_tokens: 1024,
        temperature: 0.2,
        stream: true,
      }),
      signal: ctrl.signal,
    });
  } catch (err) {
    return {
      persona,
      ok: false,
      summary: "",
      findings: [],
      error: (err as Error).name === "AbortError" ? "timeout" : (err as Error).message,
    };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }

  if (!res.ok || !res.body) {
    return {
      persona,
      ok: false,
      summary: "",
      findings: [],
      error: `gateway ${res.status}`,
    };
  }

  let parsed;
  try {
    parsed = await consumeAnthropicStream(res.body);
  } catch (err) {
    return {
      persona,
      ok: false,
      summary: "",
      findings: [],
      error: `stream error: ${(err as Error).message}`,
    };
  }
  return parseAmigoReply(persona, parsed.content);
}

/* ─── Run orchestration ────────────────────────────────────────────── */

export interface RunAmigosOptions {
  scope: AmigosScope;
  model: string;
  signal?: AbortSignal;
  /**
   * Concurrency cap (default 3). Lower for cost, raise for speed if
   * the gateway is comfortable.
   */
  concurrency?: number;
  /**
   * Streaming hooks — fired as the run progresses so the SSE route
   * can forward events to the browser. Optional; missing hooks are
   * no-ops.
   */
  onEvent?: (evt: AmigosEvent) => void;
  /**
   * Override the underlying per-amigo call. Used by tests and by
   * the planner integration to swap in a fake gateway.
   */
  amigoFn?: (input: {
    persona: AmigoPersona;
    feature: ParsedFeature;
    scenario: ParsedScenario;
    featurePath: string;
    model: string;
    signal?: AbortSignal;
  }) => Promise<AmigoResult>;
}

export type AmigosEvent =
  | { type: "discovered"; total: number }
  | { type: "scenario_started"; featurePath: string; scenarioId: string; scenarioName: string }
  | { type: "amigo_done"; featurePath: string; scenarioId: string; result: AmigoResult }
  | { type: "scenario_done"; report: ScenarioReport }
  | { type: "summary"; report: AmigosReport }
  | { type: "error"; message: string };

/**
 * Drive a Three Amigos run end-to-end. Pure-ish: side-effects are
 * filesystem reads + gateway calls + the operator-supplied
 * `onEvent`. Does NOT touch the runtime store; the route handler
 * does that with the returned report.
 */
export async function runAmigos(
  opts: RunAmigosOptions,
): Promise<AmigosReport> {
  const startedAt = Date.now();
  const emit = opts.onEvent ?? (() => {});
  const amigoFn = opts.amigoFn ?? callAmigo;

  // 1. Discover the candidate scenarios for this scope.
  let scenarios: Array<{ feature: ParsedFeature; file: FeatureFile; scenario: ParsedScenario }>;
  try {
    scenarios = await collectScopedScenarios(opts.scope);
  } catch (err) {
    const message = (err as Error).message || "discovery_failed";
    emit({ type: "error", message });
    return {
      startedAt,
      endedAt: Date.now(),
      scope: opts.scope,
      total: 0,
      scanned: 0,
      pass: 0,
      concerns: 0,
      fail: 0,
      scenarios: [],
      error: message,
    };
  }

  const cap = getMaxScenarios();
  const total = scenarios.length;
  if (total > cap) {
    const message = `too many scenarios: ${total} > ${cap}`;
    emit({ type: "error", message });
    return {
      startedAt,
      endedAt: Date.now(),
      scope: opts.scope,
      total,
      scanned: 0,
      pass: 0,
      concerns: 0,
      fail: 0,
      scenarios: [],
      error: message,
    };
  }
  emit({ type: "discovered", total });

  // 2. Fan out scenarios with a concurrency cap.
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? DEFAULT_CONCURRENCY, 8));
  const reports: ScenarioReport[] = [];
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < scenarios.length) {
      if (opts.signal?.aborted) return;
      const idx = cursor++;
      const item = scenarios[idx];
      emit({
        type: "scenario_started",
        featurePath: item.file.relPath,
        scenarioId: item.scenario.id,
        scenarioName: item.scenario.name,
      });

      const amigoResults = await Promise.all(
        AMIGO_PERSONAS.map(async (persona) => {
          const r = await amigoFn({
            persona,
            feature: item.feature,
            scenario: item.scenario,
            featurePath: item.file.relPath,
            model: opts.model,
            signal: opts.signal,
          });
          emit({
            type: "amigo_done",
            featurePath: item.file.relPath,
            scenarioId: item.scenario.id,
            result: r,
          });
          return r;
        }),
      );

      const merged = mergeAmigoVerdicts(amigoResults);
      const report: ScenarioReport = {
        featurePath: item.file.relPath,
        scenarioId: item.scenario.id,
        scenarioName: item.scenario.name,
        verdict: merged.verdict,
        findings: merged.findings,
        amigos: amigoResults,
      };
      reports.push(report);
      emit({ type: "scenario_done", report });
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const summary: AmigosReport = {
    startedAt,
    endedAt: Date.now(),
    scope: opts.scope,
    total,
    scanned: reports.length,
    pass: reports.filter((r) => r.verdict === "pass").length,
    concerns: reports.filter((r) => r.verdict === "concerns").length,
    fail: reports.filter((r) => r.verdict === "fail").length,
    scenarios: reports,
    error: opts.signal?.aborted ? "aborted" : undefined,
  };
  emit({ type: "summary", report: summary });
  return summary;
}

/** Merge per-scenario verdicts into a top-level verdict for SDLC gating. */
export function overallVerdict(report: AmigosReport): ScenarioVerdict {
  if (report.fail > 0) return "fail";
  if (report.concerns > 0) return "concerns";
  return "pass";
}

async function collectScopedScenarios(
  scope: AmigosScope,
): Promise<Array<{ feature: ParsedFeature; file: FeatureFile; scenario: ParsedScenario }>> {
  const out: Array<{ feature: ParsedFeature; file: FeatureFile; scenario: ParsedScenario }> = [];
  let files: FeatureFile[];
  if (scope.type === "all") {
    files = await discoverFeatures();
  } else {
    files = [await readFeatureFile(scope.path)];
  }
  for (const file of files) {
    const feature = parseScenarios(file.source);
    for (const scenario of feature.scenarios) {
      if (scope.type === "scenario" && scenario.id !== scope.scenarioId) continue;
      out.push({ feature, file, scenario });
    }
  }
  return out;
}
