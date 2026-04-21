"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  PersistedAmigosReport,
  PersistedScenarioReport,
  PersistedAmigoFinding,
} from "@/lib/runtime";

/**
 * Three Amigos AI BDD validation panel.
 *
 * Discovers every `*.feature` in the workspace and runs each
 * scenario through three AI personas (Business / Dev / QA) in
 * parallel. Lives as a tab in `WorkspaceCenter` so operators can
 * pull up the static review without leaving the workspace.
 *
 * State flow:
 *   - On mount, GET `/api/runtime/amigos/report` to rehydrate the
 *     last persisted run.
 *   - "Run on all suites" POSTs `/api/runtime/amigos`; we read the
 *     SSE response and accumulate per-scenario verdicts as they
 *     arrive, so the UI is live.
 *   - "Stop" sends `DELETE /api/runtime/amigos` and aborts the
 *     local `fetch`.
 */

type Verdict = "pass" | "concerns" | "fail";

interface RunningState {
  startedAt: number;
  total: number | null;
  scenarios: Map<string, PersistedScenarioReport>;
  active: Set<string>;
  errors: string[];
}

const VERDICT_STYLES: Record<Verdict, string> = {
  pass: "bg-emerald-900/40 text-emerald-300 border-emerald-700/60",
  concerns: "bg-amber-900/40 text-amber-300 border-amber-700/60",
  fail: "bg-red-900/40 text-red-300 border-red-700/60",
};

const PERSONA_LABELS: Record<"business" | "dev" | "qa", { letter: string; tone: string }> =
  {
    business: { letter: "B", tone: "bg-sky-900/60 text-sky-200" },
    dev: { letter: "D", tone: "bg-violet-900/60 text-violet-200" },
    qa: { letter: "Q", tone: "bg-emerald-900/60 text-emerald-200" },
  };

export function AmigosPanel() {
  const [report, setReport] = useState<PersistedAmigosReport | null>(null);
  const [running, setRunning] = useState<RunningState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const abortRef = useRef<AbortController | null>(null);

  // Initial load of last persisted report.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/runtime/amigos/report");
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as { report: PersistedAmigosReport | null };
        if (!cancelled) setReport(data.report);
      } catch {
        /* ignore — panel still works without a prior report */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Stop any in-flight stream when the component unmounts so we
  // don't leak the fetch / abort controller.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const startRun = useCallback(
    async (scope: { type: "all" } | { type: "feature"; path: string }) => {
      if (running) return;
      setError(null);
      setRunning({
        startedAt: Date.now(),
        total: null,
        scenarios: new Map(),
        active: new Set(),
        errors: [],
      });

      const ctrl = new AbortController();
      abortRef.current = ctrl;
      try {
        const res = await fetch("/api/runtime/amigos", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(scope),
          signal: ctrl.signal,
        });
        if (!res.ok || !res.body) {
          const msg = await safeErrorBody(res);
          throw new Error(msg);
        }
        await consumeSse(res.body, (type, data) => {
          if (type === "discovered") {
            setRunning((s) =>
              s ? { ...s, total: (data as { total: number }).total } : s,
            );
          } else if (type === "scenario_started") {
            const d = data as { scenarioId: string; featurePath: string };
            const key = `${d.featurePath}::${d.scenarioId}`;
            setRunning((s) => {
              if (!s) return s;
              const active = new Set(s.active);
              active.add(key);
              return { ...s, active };
            });
          } else if (type === "scenario_done") {
            const d = data as { report: PersistedScenarioReport };
            const key = `${d.report.featurePath}::${d.report.scenarioId}`;
            setRunning((s) => {
              if (!s) return s;
              const active = new Set(s.active);
              active.delete(key);
              const scenarios = new Map(s.scenarios);
              scenarios.set(key, d.report);
              return { ...s, scenarios, active };
            });
          } else if (type === "summary") {
            const d = data as { report: PersistedAmigosReport };
            setReport(d.report);
          } else if (type === "error") {
            const msg = (data as { message?: string }).message ?? "unknown error";
            setRunning((s) =>
              s ? { ...s, errors: [...s.errors, msg] } : s,
            );
          }
        });
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          setError((err as Error).message || "run failed");
        }
      } finally {
        abortRef.current = null;
        setRunning(null);
      }
    },
    [running],
  );

  const stopRun = useCallback(async () => {
    abortRef.current?.abort();
    try {
      await fetch("/api/runtime/amigos", { method: "DELETE" });
    } catch {
      /* ignore */
    }
  }, []);

  // Active list overrides the persisted report so live updates show
  // up immediately while the stream is in flight.
  const liveScenarios = useMemo(() => {
    if (!running) return null;
    return Array.from(running.scenarios.values()).sort((a, b) =>
      `${a.featurePath}::${a.scenarioId}`.localeCompare(
        `${b.featurePath}::${b.scenarioId}`,
      ),
    );
  }, [running]);

  const visibleReport: PersistedAmigosReport | null =
    running && liveScenarios
      ? {
          startedAt: running.startedAt,
          scope: { type: "all" },
          total: running.total ?? liveScenarios.length,
          scanned: liveScenarios.length,
          pass: liveScenarios.filter((s) => s.verdict === "pass").length,
          concerns: liveScenarios.filter((s) => s.verdict === "concerns").length,
          fail: liveScenarios.filter((s) => s.verdict === "fail").length,
          scenarios: liveScenarios,
        }
      : report;

  const grouped = useMemo(
    () => groupByFeature(visibleReport?.scenarios ?? []),
    [visibleReport],
  );

  const toggleFeature = useCallback((path: string) => {
    setExpanded((prev) => ({ ...prev, [path]: !prev[path] }));
  }, []);

  return (
    <section
      className="flex h-full min-h-0 w-full flex-col bg-zinc-950 text-zinc-200"
      data-testid="amigos-panel"
    >
      {/* Header / actions */}
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-zinc-900 bg-black px-3 py-2">
        <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-zinc-400">
          Three Amigos · BDD Review
        </span>
        <div className="ml-auto flex items-center gap-2">
          {running ? (
            <button
              type="button"
              onClick={stopRun}
              className="rounded border border-red-700 bg-red-900/40 px-2 py-1 text-[11px] font-medium text-red-200 hover:bg-red-900/60"
            >
              ■ Stop
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void startRun({ type: "all" })}
              className="rounded border border-emerald-700 bg-emerald-900/40 px-2 py-1 text-[11px] font-medium text-emerald-200 hover:bg-emerald-900/60"
            >
              ▶ Run on all suites
            </button>
          )}
        </div>
      </header>

      {/* Verdict summary strip */}
      {visibleReport ? (
        <SummaryStrip report={visibleReport} running={!!running} />
      ) : null}

      {error ? (
        <div className="shrink-0 border-b border-red-900/60 bg-red-950/40 px-3 py-1.5 text-[11px] text-red-200">
          {error}
        </div>
      ) : null}

      {/* Findings tree */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!visibleReport ? (
          <EmptyState onRun={() => void startRun({ type: "all" })} />
        ) : (
          <ul className="divide-y divide-zinc-900">
            {grouped.map(([feature, scenarios]) => {
              const featureVerdict = rollupVerdict(scenarios);
              const isOpen = expanded[feature] ?? true;
              return (
                <li key={feature}>
                  <button
                    type="button"
                    onClick={() => toggleFeature(feature)}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] hover:bg-zinc-900/50"
                  >
                    <span
                      aria-hidden
                      className="font-mono text-zinc-500"
                    >
                      {isOpen ? "▾" : "▸"}
                    </span>
                    <span
                      className={`rounded border px-1.5 py-0.5 text-[10px] font-mono uppercase tracking-wider ${VERDICT_STYLES[featureVerdict]}`}
                    >
                      {featureVerdict}
                    </span>
                    <span className="flex-1 truncate text-zinc-200">
                      {feature}
                    </span>
                    <span className="text-[10px] text-zinc-500">
                      {scenarios.length} scenario{scenarios.length === 1 ? "" : "s"}
                    </span>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        void startRun({ type: "feature", path: feature });
                      }}
                      disabled={!!running}
                      className="rounded border border-zinc-800 bg-black/60 px-1.5 py-0.5 text-[10px] text-zinc-400 hover:border-zinc-700 hover:text-zinc-100 disabled:opacity-40"
                      title="Re-run amigos on this feature"
                    >
                      ↻
                    </button>
                  </button>
                  {isOpen ? (
                    <ul className="border-t border-zinc-900 bg-zinc-950">
                      {scenarios.map((s) => (
                        <ScenarioRow
                          key={`${s.featurePath}::${s.scenarioId}`}
                          scenario={s}
                          isActive={
                            !!running &&
                            running.active.has(
                              `${s.featurePath}::${s.scenarioId}`,
                            )
                          }
                        />
                      ))}
                    </ul>
                  ) : null}
                </li>
              );
            })}
            {/* Inline pending placeholders for in-flight scenarios. */}
            {running
              ? Array.from(running.active)
                  .filter(
                    (key) =>
                      !visibleReport.scenarios.find(
                        (s) => `${s.featurePath}::${s.scenarioId}` === key,
                      ),
                  )
                  .map((key) => (
                    <li
                      key={`pending-${key}`}
                      className="flex items-center gap-2 px-3 py-1.5 text-[11px] text-zinc-500"
                    >
                      <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-amber-400" />
                      <span className="truncate font-mono">{key}</span>
                    </li>
                  ))
              : null}
          </ul>
        )}
      </div>
    </section>
  );
}

function SummaryStrip({
  report,
  running,
}: {
  report: PersistedAmigosReport;
  running: boolean;
}) {
  const total = report.total || report.scenarios.length;
  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-zinc-900 bg-zinc-950 px-3 py-2 text-[11px] text-zinc-400">
      <span>
        {report.scanned} / {total} scenarios
      </span>
      <span className="text-emerald-300">{report.pass} pass</span>
      <span className="text-amber-300">{report.concerns} concerns</span>
      <span className="text-red-300">{report.fail} fail</span>
      {running ? (
        <span className="ml-auto inline-flex items-center gap-1 text-amber-300">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-amber-400" />
          running…
        </span>
      ) : report.endedAt ? (
        <span className="ml-auto text-zinc-500">
          last run · {formatRelative(report.endedAt)}
        </span>
      ) : null}
    </div>
  );
}

function ScenarioRow({
  scenario,
  isActive,
}: {
  scenario: PersistedScenarioReport;
  isActive: boolean;
}) {
  const [open, setOpen] = useState(scenario.verdict !== "pass");
  return (
    <li className="border-t border-zinc-900/60">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-5 py-1.5 text-left text-[12px] hover:bg-zinc-900/40"
      >
        <span
          className={`rounded border px-1.5 py-0.5 text-[10px] font-mono uppercase tracking-wider ${VERDICT_STYLES[scenario.verdict]}`}
        >
          {scenario.verdict}
        </span>
        <span className="flex-1 truncate text-zinc-300">
          {scenario.scenarioName || scenario.scenarioId}
        </span>
        <PersonaChips scenario={scenario} />
        {isActive ? (
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-amber-400" />
        ) : null}
      </button>
      {open ? (
        <div className="space-y-1 border-t border-zinc-900/60 bg-black/30 px-7 py-2">
          {scenario.findings.length === 0 ? (
            <p className="text-[11px] italic text-zinc-500">
              No findings — all amigos approved.
            </p>
          ) : (
            scenario.findings.map((f, i) => (
              <FindingRow key={i} finding={f} />
            ))
          )}
        </div>
      ) : null}
    </li>
  );
}

function PersonaChips({ scenario }: { scenario: PersistedScenarioReport }) {
  const byPersona: Record<"business" | "dev" | "qa", PersistedAmigoFinding[]> =
    { business: [], dev: [], qa: [] };
  for (const f of scenario.findings) byPersona[f.persona].push(f);
  return (
    <span className="flex gap-1">
      {(["business", "dev", "qa"] as const).map((p) => {
        const flagged = byPersona[p];
        const blocker = flagged.some((f) => f.severity === "blocker");
        const concern = flagged.some((f) => f.severity === "concern");
        const cls = blocker
          ? "ring-1 ring-red-500"
          : concern
            ? "ring-1 ring-amber-400"
            : "";
        return (
          <span
            key={p}
            className={`inline-flex h-4 w-4 items-center justify-center rounded text-[10px] font-mono ${PERSONA_LABELS[p].tone} ${cls}`}
            title={`${p}: ${flagged.length} finding${flagged.length === 1 ? "" : "s"}`}
          >
            {PERSONA_LABELS[p].letter}
          </span>
        );
      })}
    </span>
  );
}

function FindingRow({ finding }: { finding: PersistedAmigoFinding }) {
  const sevColor =
    finding.severity === "blocker"
      ? "text-red-300"
      : finding.severity === "concern"
        ? "text-amber-300"
        : "text-zinc-400";
  return (
    <p className="text-[11px] leading-snug">
      <span
        className={`mr-2 inline-flex h-3.5 w-3.5 items-center justify-center rounded text-[9px] font-mono uppercase ${PERSONA_LABELS[finding.persona].tone}`}
      >
        {PERSONA_LABELS[finding.persona].letter}
      </span>
      <span className={`mr-2 font-mono uppercase tracking-wider ${sevColor}`}>
        {finding.severity}
      </span>
      <span className="text-zinc-200">{finding.message}</span>
    </p>
  );
}

function EmptyState({ onRun }: { onRun: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-zinc-500">
        No review yet
      </p>
      <p className="max-w-xs text-[12px] text-zinc-400">
        Run the Three Amigos to scan every <code>*.feature</code> file in the
        workspace and get Business / Dev / QA feedback per scenario.
      </p>
      <button
        type="button"
        onClick={onRun}
        className="rounded border border-emerald-700 bg-emerald-900/40 px-3 py-1.5 text-[11px] font-medium text-emerald-200 hover:bg-emerald-900/60"
      >
        ▶ Run on all suites
      </button>
    </div>
  );
}

/* ─── helpers ──────────────────────────────────────────────────────── */

function rollupVerdict(scenarios: PersistedScenarioReport[]): Verdict {
  if (scenarios.some((s) => s.verdict === "fail")) return "fail";
  if (scenarios.some((s) => s.verdict === "concerns")) return "concerns";
  return "pass";
}

function groupByFeature(
  scenarios: PersistedScenarioReport[],
): Array<[string, PersistedScenarioReport[]]> {
  const map = new Map<string, PersistedScenarioReport[]>();
  for (const s of scenarios) {
    const arr = map.get(s.featurePath);
    if (arr) arr.push(s);
    else map.set(s.featurePath, [s]);
  }
  return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
}

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

async function safeErrorBody(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as { error?: string };
    return j.error || `gateway ${res.status}`;
  } catch {
    return `gateway ${res.status}`;
  }
}

/**
 * Minimal SSE parser tailored to the events emitted by
 * `/api/runtime/amigos`. Splits on `\n\n` event boundaries, picks
 * out `event:` / `data:` lines, and forwards JSON-decoded payloads
 * to the consumer. Tolerant of partial chunks and trailing whitespace.
 */
async function consumeSse(
  body: ReadableStream<Uint8Array>,
  onEvent: (type: string, data: unknown) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        dispatchBlock(block, onEvent);
      }
    }
    buf += decoder.decode();
    if (buf.trim()) dispatchBlock(buf, onEvent);
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
}

function dispatchBlock(
  block: string,
  onEvent: (type: string, data: unknown) => void,
): void {
  let event = "message";
  let data = "";
  for (const rawLine of block.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      const piece = line.slice(5).replace(/^ /, "");
      data = data ? `${data}\n${piece}` : piece;
    }
  }
  if (!data || data === "[DONE]") return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return;
  }
  onEvent(event, parsed);
}
