"use client";

import {
  KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

interface Line {
  id: number;
  kind: "command" | "stdout" | "stderr" | "info" | "exit" | "error";
  text: string;
}

const HISTORY_LIMIT = 50;
const LINE_LIMIT = 2000;

export function TerminalView() {
  const [lines, setLines] = useState<Line[]>([
    {
      id: 0,
      kind: "info",
      text: "Mission Control · streaming shell. Commands run via bash -lc in the gateway repo. ⌘K to clear.",
    },
  ]);
  const [running, setRunning] = useState(false);
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyCursor, setHistoryCursor] = useState<number | null>(null);

  const lineId = useRef(1);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const append = useCallback((kind: Line["kind"], text: string) => {
    setLines((prev) => {
      const next = prev.concat({ id: lineId.current++, kind, text });
      return next.length > LINE_LIMIT ? next.slice(next.length - LINE_LIMIT) : next;
    });
  }, []);

  // Append onto the most recent line if it's a streaming chunk of the
  // same kind — keeps long output from exploding into one DOM node per
  // chunk.
  const appendChunk = useCallback(
    (kind: "stdout" | "stderr", chunk: string) => {
      const segments = chunk.split(/(\r?\n)/);
      setLines((prev) => {
        const out = prev.slice();
        let last = out[out.length - 1];
        for (const seg of segments) {
          if (seg === "") continue;
          if (seg === "\n" || seg === "\r\n") {
            last = { id: lineId.current++, kind, text: "" };
            out.push(last);
            continue;
          }
          if (last && last.kind === kind && !last.text.endsWith("\n")) {
            const replaced = { ...last, text: last.text + seg };
            out[out.length - 1] = replaced;
            last = replaced;
          } else {
            last = { id: lineId.current++, kind, text: seg };
            out.push(last);
          }
        }
        return out.length > LINE_LIMIT
          ? out.slice(out.length - LINE_LIMIT)
          : out;
      });
    },
    [],
  );

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setLines([]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setRunning(false);
  }, []);

  const run = useCallback(
    async (command: string) => {
      const trimmed = command.trim();
      if (!trimmed || running) return;

      append("command", `$ ${trimmed}`);
      setHistory((h) =>
        [...h, trimmed].slice(Math.max(0, h.length + 1 - HISTORY_LIMIT)),
      );
      setHistoryCursor(null);
      setRunning(true);

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const res = await fetch("/api/exec", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ command: trimmed }),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          const body = await res.text().catch(() => "");
          append("error", body || `request failed (${res.status})`);
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buffer.indexOf("\n\n")) !== -1) {
            const block = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            handleSseBlock(block, append, appendChunk);
          }
        }
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          append("error", (err as Error).message);
        }
      } finally {
        abortRef.current = null;
        setRunning(false);
      }
    },
    [append, appendChunk, running],
  );

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const cmd = input;
        setInput("");
        void run(cmd);
        return;
      }
      if (e.key === "ArrowUp") {
        if (history.length === 0) return;
        e.preventDefault();
        const next =
          historyCursor === null
            ? history.length - 1
            : Math.max(0, historyCursor - 1);
        setHistoryCursor(next);
        setInput(history[next] ?? "");
        return;
      }
      if (e.key === "ArrowDown") {
        if (historyCursor === null) return;
        e.preventDefault();
        const next = historyCursor + 1;
        if (next >= history.length) {
          setHistoryCursor(null);
          setInput("");
        } else {
          setHistoryCursor(next);
          setInput(history[next] ?? "");
        }
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c" && running) {
        e.preventDefault();
        cancel();
      }
    },
    [cancel, history, historyCursor, input, run, running],
  );

  return (
    <div className="flex h-full flex-col bg-black font-mono text-[12px] leading-5 text-zinc-200">
      <div className="flex items-center justify-between border-b border-zinc-900 px-4 py-2">
        <span className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">
          mission control · gateway shell
        </span>
        <span className="flex items-center gap-2 text-[10px]">
          {running ? (
            <button
              type="button"
              onClick={cancel}
              className="rounded border border-red-500/50 bg-red-500/10 px-2 py-0.5 text-red-300 hover:bg-red-500/20"
            >
              stop
            </button>
          ) : (
            <span className="text-zinc-500">idle</span>
          )}
        </span>
      </div>

      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-4 py-3"
        onClick={() => inputRef.current?.focus()}
      >
        {lines.map((l) => (
          <div key={l.id} className={lineClass(l.kind)}>
            {l.text}
          </div>
        ))}
        {/*
          A single input is rendered in both idle and running states
          (just toggled to readOnly when running) so focus is
          preserved across the transition — important so ⌘C / Ctrl+C
          continues to reach `onKeyDown` immediately after the user
          presses Enter, without requiring a re-click.
        */}
        <div className="mt-1 flex items-center gap-1.5">
          <span
            className={
              running
                ? "animate-pulse text-amber-400"
                : "text-emerald-400"
            }
          >
            {running ? "…" : "$"}
          </span>
          <input
            ref={inputRef}
            value={running ? "" : input}
            readOnly={running}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            className={
              "flex-1 bg-transparent outline-none placeholder:text-zinc-700 " +
              (running
                ? "cursor-default text-zinc-500"
                : "text-zinc-100")
            }
            placeholder={
              running
                ? "running… press ⌘C / Ctrl+C to cancel"
                : "Try: git status   ·   ls -la   ·   npm test"
            }
          />
        </div>
      </div>

      <p className="border-t border-zinc-900 px-4 py-1.5 text-[10px] text-zinc-600">
        Streams via SSE. ⌘K clear · ↑↓ history · ⌘C cancel.
      </p>
    </div>
  );
}

function lineClass(kind: Line["kind"]): string {
  switch (kind) {
    case "command":
      return "text-emerald-400";
    case "stderr":
      return "whitespace-pre-wrap text-orange-300";
    case "info":
      return "text-zinc-500";
    case "error":
      return "text-red-400";
    case "exit":
      return "text-zinc-500";
    default:
      return "whitespace-pre-wrap text-zinc-200";
  }
}

function handleSseBlock(
  block: string,
  append: (kind: Line["kind"], text: string) => void,
  appendChunk: (kind: "stdout" | "stderr", text: string) => void,
) {
  let event = "message";
  let data = "";
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data += line.slice(5).trim();
  }
  if (!data) return;
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(data) as Record<string, unknown>;
  } catch {
    return;
  }
  switch (event) {
    case "stdout":
      if (typeof payload.chunk === "string") appendChunk("stdout", payload.chunk);
      break;
    case "stderr":
      if (typeof payload.chunk === "string") appendChunk("stderr", payload.chunk);
      break;
    case "info":
      if (typeof payload.message === "string") append("info", payload.message);
      break;
    case "error":
      if (typeof payload.message === "string") append("error", payload.message);
      break;
    case "exit": {
      const code = payload.code ?? null;
      const sig = payload.signal ?? null;
      append(
        "exit",
        sig
          ? `[exited via ${sig}]`
          : code === 0
            ? "[exit 0]"
            : `[exit ${code ?? "?"}]`,
      );
      break;
    }
    case "start":
    default:
      break;
  }
}
