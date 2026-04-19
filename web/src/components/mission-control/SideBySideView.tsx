"use client";

/**
 * Side-by-Side comparison view.
 *
 * Lets the user send the same prompt to multiple models in parallel
 * via `POST /api/runtime/compare` and inspect each response, latency,
 * token usage, and tool-call count side by side.
 *
 * Lanes are configurable: the user can change a lane's model on the
 * fly. The set of lanes is local component state (intentionally not
 * persisted) so users can experiment without polluting the shared
 * runtime store.
 */

import { useCallback, useState } from "react";

interface Lane {
  /** Stable id used for keyed updates and result correlation. */
  id: string;
  label: string;
  model: string;
  tint: string;
}

interface LaneResult {
  id: string;
  model: string;
  ok: boolean;
  latencyMs: number;
  content: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  toolCalls: number;
  error?: string;
}

const DEFAULT_LANES: Lane[] = [
  {
    id: "codex",
    label: "Codex",
    model: "gpt-5.4",
    tint: "border-emerald-500/40",
  },
  {
    id: "claude",
    label: "Claude Code",
    model: "sonnet-4.6",
    tint: "border-orange-500/40",
  },
  {
    id: "openai",
    label: "OpenAI",
    model: "gpt-4o",
    tint: "border-sky-500/40",
  },
];

export function SideBySideView() {
  const [lanes, setLanes] = useState<Lane[]>(DEFAULT_LANES);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Per-lane results keyed by lane id. Cleared on each new run.
  const [results, setResults] = useState<Record<string, LaneResult>>({});

  const updateLaneModel = useCallback((id: string, model: string) => {
    setLanes((prev) => prev.map((l) => (l.id === id ? { ...l, model } : l)));
  }, []);

  const onRun = useCallback(async () => {
    const trimmed = prompt.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    setResults({});
    try {
      const res = await fetch("/api/runtime/compare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: trimmed,
          lanes: lanes.map((l) => ({ id: l.id, model: l.model })),
        }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as {
          error?: string;
          message?: string;
        };
        throw new Error(j.message || j.error || `compare failed (${res.status})`);
      }
      const json = (await res.json()) as { lanes: LaneResult[] };
      const map: Record<string, LaneResult> = {};
      for (const r of json.lanes) map[r.id] = r;
      setResults(map);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [prompt, lanes, busy]);

  return (
    <div className="flex h-full flex-col bg-black">
      <div className="flex flex-col gap-2 border-b border-zinc-900 px-3 py-2.5">
        <div className="flex items-start gap-2">
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              // ⌘+Enter / Ctrl+Enter to send.
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                void onRun();
              }
            }}
            rows={2}
            placeholder="Prompt all lanes — ⌘↵ to run"
            className="min-h-[44px] flex-1 resize-y rounded border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 font-mono text-xs text-zinc-100 placeholder-zinc-600 focus:border-zinc-600 focus:outline-none"
          />
          <button
            type="button"
            disabled={busy || !prompt.trim()}
            onClick={onRun}
            className="rounded border border-emerald-700/60 bg-emerald-500/10 px-4 py-2 text-xs font-medium text-emerald-300 hover:border-emerald-600 hover:bg-emerald-500/20 disabled:opacity-50"
          >
            {busy ? "running…" : "Run all"}
          </button>
        </div>
        {error && (
          <p className="font-mono text-[10px] text-red-400">⚠ {error}</p>
        )}
      </div>

      <div
        className="grid flex-1 gap-px overflow-hidden bg-zinc-900"
        style={{
          gridTemplateColumns: `repeat(${lanes.length}, minmax(0, 1fr))`,
        }}
      >
        {lanes.map((lane) => (
          <LanePane
            key={lane.id}
            lane={lane}
            result={results[lane.id]}
            running={busy}
            onModelChange={(m) => updateLaneModel(lane.id, m)}
          />
        ))}
      </div>
    </div>
  );
}

interface LanePaneProps {
  lane: Lane;
  result: LaneResult | undefined;
  running: boolean;
  onModelChange: (model: string) => void;
}

function LanePane({ lane, result, running, onModelChange }: LanePaneProps) {
  const status = running
    ? "running"
    : result
      ? result.ok
        ? "ok"
        : "error"
      : "idle";
  const statusColor =
    status === "ok"
      ? "text-emerald-400"
      : status === "error"
        ? "text-red-400"
        : status === "running"
          ? "text-amber-300"
          : "text-zinc-500";

  return (
    <div className="flex min-w-0 flex-col bg-black">
      <div
        className={"flex items-center justify-between gap-2 border-b px-3 py-2 " + lane.tint}
      >
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-xs font-medium text-zinc-200">{lane.label}</span>
          <input
            value={lane.model}
            onChange={(e) => onModelChange(e.target.value)}
            placeholder="model"
            disabled={running}
            className="w-32 rounded border border-zinc-800 bg-zinc-950 px-1.5 py-0.5 font-mono text-[10px] text-zinc-300 focus:border-zinc-600 focus:outline-none disabled:opacity-50"
          />
        </div>
        <span className={"font-mono text-[10px] uppercase " + statusColor}>
          {status}
        </span>
      </div>

      {result && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-zinc-900 px-3 py-1.5 font-mono text-[10px] text-zinc-500">
          <span>
            <span className="text-zinc-600">latency:</span>{" "}
            <span className="text-zinc-300">{formatMs(result.latencyMs)}</span>
          </span>
          {result.usage?.total_tokens != null && (
            <span>
              <span className="text-zinc-600">tokens:</span>{" "}
              <span className="text-zinc-300">
                {result.usage.total_tokens}
                {result.usage.prompt_tokens != null &&
                  ` (${result.usage.prompt_tokens}+${result.usage.completion_tokens ?? 0})`}
              </span>
            </span>
          )}
          {result.toolCalls > 0 && (
            <span>
              <span className="text-zinc-600">tools:</span>{" "}
              <span className="text-zinc-300">{result.toolCalls}</span>
            </span>
          )}
        </div>
      )}

      <pre className="flex-1 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-[11px] leading-5 text-zinc-300">
        {running && !result && "▌ thinking…"}
        {!running && !result && (
          <span className="text-zinc-600">
            {`# ${lane.label} (${lane.model})\n> waiting for prompt…`}
          </span>
        )}
        {result?.ok && (result.content || <span className="text-zinc-600">(empty)</span>)}
        {result && !result.ok && (
          <span className="text-red-400">
            {`error: ${result.error ?? "unknown"}`}
          </span>
        )}
      </pre>
    </div>
  );
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}
