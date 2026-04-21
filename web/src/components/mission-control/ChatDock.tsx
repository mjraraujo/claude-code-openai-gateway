"use client";

/**
 * ChatDock — streaming chat with the local gateway.
 *
 * Lives in the right column of Mission Control as one of two tabs
 * (the other being the existing Agents panel). Posts the conversation
 * to `POST /api/runtime/chat` which forwards it to `bin/gateway.js`
 * (Anthropic Messages-shaped, always streams SSE) and pipes the
 * response back. The model is the same `HarnessState.model` driven by
 * the Agents panel, so changing model in either place takes effect
 * everywhere.
 *
 * State is purely client-side; transcripts are not persisted. The
 * intent matches the Side-by-Side view: a low-stakes scratch surface,
 * so users can experiment without polluting the runtime store.
 *
 * Tool-call wiring (fs read/write, exec) is intentionally left for a
 * follow-up — the current gateway request shape doesn't include the
 * Anthropic `tools` array, so tools would need either gateway changes
 * or client-side prompt-format conventions.
 */

import {
  KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import type { RuntimeState } from "@/lib/runtime";

interface ChatTurn {
  id: number;
  role: "user" | "assistant" | "system";
  content: string;
  /** True while we're still streaming into this turn. */
  streaming?: boolean;
  error?: boolean;
}

const MAX_TURNS = 200;
const DEFAULT_MODEL = "gpt-5.4";

export function ChatDock() {
  const [turns, setTurns] = useState<ChatTurn[]>([
    {
      id: 0,
      role: "system",
      content:
        "Chat streams via the local gateway. Model is shared with the Agents panel — change it there. Conversation is not persisted.",
    },
  ]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [model, setModel] = useState<string>(DEFAULT_MODEL);
  const [workspaceRoot, setWorkspaceRoot] = useState<string | null>(null);

  const turnId = useRef(1);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // Subscribe to runtime state to keep the model in sync with whatever
  // the Agents panel selected. Same SSE source as the rest of Mission
  // Control.
  useEffect(() => {
    const es = new EventSource("/api/runtime/state");
    es.addEventListener("state", (ev) => {
      try {
        const next = JSON.parse((ev as MessageEvent).data) as RuntimeState;
        if (next?.harness?.model) setModel(next.harness.model);
      } catch {
        /* ignore */
      }
    });
    es.onerror = () => {
      // EventSource auto-reconnects.
    };
    return () => es.close();
  }, []);

  // Best-effort: discover the workspace root from the existing tree
  // endpoint so we can mention it in the system prompt. Failures are
  // silent — the chat still works without it.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/fs/tree")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (cancelled || !j) return;
        if (typeof j.root === "string") setWorkspaceRoot(j.root);
      })
      .catch(() => {
        /* ignore */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns]);

  const append = useCallback((turn: Omit<ChatTurn, "id">): number => {
    const id = turnId.current++;
    setTurns((prev) => {
      const next = prev.concat({ ...turn, id });
      return next.length > MAX_TURNS ? next.slice(next.length - MAX_TURNS) : next;
    });
    return id;
  }, []);

  const patch = useCallback((id: number, patcher: (t: ChatTurn) => ChatTurn) => {
    setTurns((prev) => prev.map((t) => (t.id === id ? patcher(t) : t)));
  }, []);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setSending(false);
  }, []);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || sending) return;
      setInput("");

      // Snapshot the conversation we'll send before mutating state so
      // we don't include the assistant placeholder we're about to add.
      const history = turns
        .filter((t) => t.role === "user" || t.role === "assistant")
        .map((t) => ({ role: t.role as "user" | "assistant", content: t.content }))
        .concat({ role: "user", content: trimmed });

      append({ role: "user", content: trimmed });
      const assistantId = append({
        role: "assistant",
        content: "",
        streaming: true,
      });

      setSending(true);
      const ctrl = new AbortController();
      abortRef.current = ctrl;

      const system = buildSystemPrompt(workspaceRoot);

      try {
        const res = await fetch("/api/runtime/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            system,
            messages: history,
            maxTokens: 1024,
          }),
          signal: ctrl.signal,
        });

        if (!res.ok || !res.body) {
          const errText = await res.text().catch(() => "");
          patch(assistantId, (t) => ({
            ...t,
            content: errText || `request failed (${res.status})`,
            streaming: false,
            error: true,
          }));
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let acc = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buffer.indexOf("\n\n")) !== -1) {
            const block = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const delta = parseSseTextDelta(block);
            if (delta) {
              acc += delta;
              const snapshot = acc;
              patch(assistantId, (t) => ({ ...t, content: snapshot }));
            }
          }
        }
        patch(assistantId, (t) => ({ ...t, streaming: false }));
      } catch (err) {
        if ((err as Error).name === "AbortError") {
          patch(assistantId, (t) => ({
            ...t,
            content: t.content || "[cancelled]",
            streaming: false,
          }));
        } else {
          patch(assistantId, (t) => ({
            ...t,
            content: (err as Error).message,
            streaming: false,
            error: true,
          }));
        }
      } finally {
        abortRef.current = null;
        setSending(false);
      }
    },
    [append, model, patch, sending, turns, workspaceRoot],
  );

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      // Enter sends; Shift+Enter inserts a newline. Matches the
      // muscle memory of most chat surfaces.
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void send(input);
      }
    },
    [input, send],
  );

  const clear = useCallback(() => {
    cancel();
    setTurns([
      {
        id: turnId.current++,
        role: "system",
        content: "Conversation cleared.",
      },
    ]);
  }, [cancel]);

  return (
    <section className="flex h-full min-h-0 flex-col bg-zinc-950 text-zinc-100">
      <header className="flex items-center justify-between border-b border-zinc-900 px-3 py-2">
        <div className="flex flex-col">
          <span className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">
            chat · gateway
          </span>
          <span className="text-xs text-zinc-300">model: {model}</span>
        </div>
        <div className="flex items-center gap-2 text-[10px]">
          {sending ? (
            <button
              type="button"
              onClick={cancel}
              className="rounded border border-red-500/50 bg-red-500/10 px-2 py-0.5 text-red-300 hover:bg-red-500/20"
            >
              stop
            </button>
          ) : null}
          <button
            type="button"
            onClick={clear}
            className="rounded border border-zinc-800 px-2 py-0.5 text-zinc-400 hover:bg-zinc-900"
          >
            clear
          </button>
        </div>
      </header>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-3">
        <ul className="flex flex-col gap-3">
          {turns.map((t) => (
            <li key={t.id} className={turnWrapperClass(t.role)}>
              <div className={turnLabelClass(t.role)}>{turnLabel(t.role)}</div>
              <div className={turnBodyClass(t)}>
                {t.content || (t.streaming ? "…" : "")}
                {t.streaming ? <span className="ml-1 animate-pulse">▌</span> : null}
              </div>
            </li>
          ))}
        </ul>
      </div>

      <div className="border-t border-zinc-900 p-2">
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          rows={3}
          spellCheck={false}
          placeholder={
            sending
              ? "streaming… press the stop button to cancel"
              : "Ask the gateway something. Enter to send, Shift+Enter for newline."
          }
          disabled={sending}
          className="w-full resize-none rounded border border-zinc-800 bg-black px-2 py-1.5 font-mono text-xs text-zinc-100 placeholder:text-zinc-700 focus:border-emerald-600 focus:outline-none disabled:opacity-60"
        />
        <div className="mt-1 flex items-center justify-between text-[10px] text-zinc-600">
          <span>workspace: {workspaceRoot ?? "(loading)"}</span>
          <span>{input.length} chars</span>
        </div>
      </div>
    </section>
  );
}

/** Build the system prompt sent on every request. */
function buildSystemPrompt(workspaceRoot: string | null): string {
  const root = workspaceRoot ?? "(unknown)";
  return [
    "You are an assistant embedded in the Mission Control dashboard for the claude-code-openai-gateway repository.",
    `Current workspace root: ${root}.`,
    "Be concise. Prefer code blocks for code. If asked to modify files or run commands, describe the change — execution is not yet wired through this surface.",
  ].join(" ");
}

/**
 * Parse a single SSE block from the Anthropic-shaped gateway and
 * return any text delta it contained (or null).
 *
 * The gateway emits `event: content_block_delta` with a JSON
 * `data:` payload of `{ type: "content_block_delta", delta: { type:
 * "text_delta", text: "..." } }`. We ignore other event types here
 * since the dock only renders accumulated text.
 */
function parseSseTextDelta(block: string): string | null {
  let dataPayload = "";
  for (const rawLine of block.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.startsWith("data:")) {
      const piece = line.slice(5).replace(/^ /, "");
      dataPayload = dataPayload ? `${dataPayload}\n${piece}` : piece;
    }
  }
  if (!dataPayload || dataPayload === "[DONE]") return null;
  let evt: unknown;
  try {
    evt = JSON.parse(dataPayload);
  } catch {
    return null;
  }
  if (!evt || typeof evt !== "object") return null;
  const e = evt as Record<string, unknown>;
  if (e.type !== "content_block_delta") return null;
  const delta = e.delta as { type?: string; text?: string } | undefined;
  if (delta?.type === "text_delta" && typeof delta.text === "string") {
    return delta.text;
  }
  return null;
}

function turnLabel(role: ChatTurn["role"]): string {
  switch (role) {
    case "user":
      return "you";
    case "assistant":
      return "assistant";
    default:
      return "system";
  }
}

function turnLabelClass(role: ChatTurn["role"]): string {
  const base = "text-[10px] uppercase tracking-[0.18em] mb-1";
  switch (role) {
    case "user":
      return `${base} text-emerald-400`;
    case "assistant":
      return `${base} text-sky-400`;
    default:
      return `${base} text-zinc-500`;
  }
}

function turnWrapperClass(role: ChatTurn["role"]): string {
  return role === "system" ? "opacity-70" : "";
}

function turnBodyClass(t: ChatTurn): string {
  const base = "whitespace-pre-wrap break-words font-mono text-[12px] leading-5";
  if (t.error) return `${base} text-red-300`;
  if (t.role === "system") return `${base} text-zinc-500`;
  if (t.role === "user") return `${base} text-zinc-100`;
  return `${base} text-zinc-200`;
}
