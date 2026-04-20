/**
 * Tests for the Anthropic-style SSE accumulator used by the
 * Side-by-Side comparison route (`POST /api/runtime/compare`).
 *
 * Regressions here surface as the original bug:
 *   "Unexpected token 'e', \"event: mes\"... is not valid JSON"
 * because the route was previously calling `res.json()` on the
 * gateway's SSE body.
 */

import { describe, expect, it } from "vitest";

import { consumeAnthropicStream } from "./anthropicStream";

function streamFrom(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

const SAMPLE_EVENTS = [
  'event: message_start\n' +
    'data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"gpt-5.4","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":7,"output_tokens":1}}}\n\n',
  'event: content_block_start\n' +
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
  'event: content_block_delta\n' +
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n',
  'event: content_block_delta\n' +
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":", world!"}}\n\n',
  'event: content_block_stop\n' +
    'data: {"type":"content_block_stop","index":0}\n\n',
  'event: message_delta\n' +
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":12}}\n\n',
  'event: message_stop\n' +
    'data: {"type":"message_stop"}\n\n',
];

describe("consumeAnthropicStream", () => {
  it("accumulates text deltas across events into a single string", async () => {
    const result = await consumeAnthropicStream(streamFrom(SAMPLE_EVENTS));
    expect(result.content).toBe("Hello, world!");
    expect(result.toolCalls).toBe(0);
    expect(result.usage).toEqual({
      prompt_tokens: 7,
      completion_tokens: 12,
      total_tokens: 19,
    });
  });

  it("handles SSE blocks split across chunk boundaries", async () => {
    // Splice every event in half to simulate TCP fragmentation. The
    // parser must buffer until it sees `\n\n`.
    const halves: string[] = [];
    for (const ev of SAMPLE_EVENTS) {
      const mid = Math.floor(ev.length / 2);
      halves.push(ev.slice(0, mid), ev.slice(mid));
    }
    const result = await consumeAnthropicStream(streamFrom(halves));
    expect(result.content).toBe("Hello, world!");
    expect(result.usage?.completion_tokens).toBe(12);
  });

  it("counts tool_use content blocks", async () => {
    const events = [
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":3,"output_tokens":1}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call_1","name":"read_file","input":{}}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"call_2","name":"write_file","input":{}}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":4}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];
    const result = await consumeAnthropicStream(streamFrom(events));
    expect(result.toolCalls).toBe(2);
    expect(result.content).toBe("");
  });

  it("ignores malformed JSON and [DONE] sentinel without throwing", async () => {
    const events = [
      "data: [DONE]\n\n",
      "event: garbage\ndata: {not json\n\n",
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}\n\n',
    ];
    const result = await consumeAnthropicStream(streamFrom(events));
    expect(result.content).toBe("ok");
  });

  it("surfaces gateway error events into the content", async () => {
    const events = [
      'event: error\ndata: {"type":"error","error":{"type":"api_error","message":"upstream 502"}}\n\n',
    ];
    const result = await consumeAnthropicStream(streamFrom(events));
    expect(result.content).toContain("upstream 502");
  });
});
