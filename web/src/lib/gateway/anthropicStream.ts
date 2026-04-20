/**
 * Anthropic-style SSE accumulator.
 *
 * `bin/gateway.js` is an Anthropic Messages-shaped proxy that *always*
 * streams Server-Sent Events (`event: message_start /
 * content_block_delta / message_delta / message_stop`). For surfaces
 * that need a single non-streaming response (e.g. the Side-by-Side
 * comparison route) we drain the stream and accumulate it into one
 * `ParsedStream`.
 *
 * Lives in its own module so it can be unit-tested without dragging
 * in `next/headers` from the route handler.
 */

export interface ParsedStream {
  /** Concatenated `text_delta.text` chunks. */
  content: string;
  /** Number of `content_block_start` events whose block was a tool_use. */
  toolCalls: number;
  /** Token usage in OpenAI shape so the existing UI can render it. */
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

interface Accumulator {
  text: string;
  toolCalls: number;
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * Drains a `text/event-stream` body emitted by `bin/gateway.js` and
 * returns the accumulated assistant text plus token usage / tool call
 * counts.
 */
export async function consumeAnthropicStream(
  body: ReadableStream<Uint8Array>,
): Promise<ParsedStream> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const acc: Accumulator = { text: "", toolCalls: 0 };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        feedBlock(block, acc);
      }
    }
    buf += decoder.decode();
    if (buf.trim()) feedBlock(buf, acc);
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
  return finalize(acc);
}

function feedBlock(block: string, acc: Accumulator): void {
  // An SSE block is one or more `event:` / `data:` lines. We only
  // need the data payload — the gateway always sets `type` inside it.
  // Per the SSE spec, multiple `data:` lines in one event concatenate
  // with newlines; the gateway only emits one but we handle both.
  let dataPayload = "";
  for (const rawLine of block.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.startsWith("data:")) {
      const piece = line.slice(5).replace(/^ /, "");
      dataPayload = dataPayload ? `${dataPayload}\n${piece}` : piece;
    }
  }
  if (!dataPayload || dataPayload === "[DONE]") return;
  let evt: unknown;
  try {
    evt = JSON.parse(dataPayload);
  } catch {
    return;
  }
  if (!evt || typeof evt !== "object") return;
  const e = evt as Record<string, unknown>;
  switch (e.type) {
    case "message_start": {
      const usage = (e.message as { usage?: { input_tokens?: number } })?.usage;
      if (usage && typeof usage.input_tokens === "number") {
        acc.inputTokens = usage.input_tokens;
      }
      return;
    }
    case "content_block_start": {
      const cb = e.content_block as { type?: string } | undefined;
      if (cb?.type === "tool_use") acc.toolCalls += 1;
      return;
    }
    case "content_block_delta": {
      const delta = e.delta as
        | { type?: string; text?: string }
        | undefined;
      if (delta?.type === "text_delta" && typeof delta.text === "string") {
        acc.text += delta.text;
      }
      return;
    }
    case "message_delta": {
      const usage = e.usage as { output_tokens?: number } | undefined;
      if (usage && typeof usage.output_tokens === "number") {
        acc.outputTokens = usage.output_tokens;
      }
      return;
    }
    case "error": {
      // Surface gateway-side errors as readable text rather than
      // silently swallowing the stream. Avoid a leading newline when
      // no prior text has been accumulated.
      const err = e.error as { message?: string } | undefined;
      if (err?.message) {
        const sep = acc.text ? "\n" : "";
        acc.text += `${sep}[gateway error] ${err.message}`;
      }
      return;
    }
    default:
      return;
  }
}

function finalize(acc: Accumulator): ParsedStream {
  const hasUsage =
    acc.inputTokens !== undefined || acc.outputTokens !== undefined;
  return {
    content: acc.text,
    toolCalls: acc.toolCalls,
    usage: hasUsage
      ? {
          prompt_tokens: acc.inputTokens,
          completion_tokens: acc.outputTokens,
          total_tokens:
            (acc.inputTokens ?? 0) + (acc.outputTokens ?? 0) || undefined,
        }
      : undefined,
  };
}
