"use client";

/**
 * WebGPUView — a sandboxed scratch tab for WebGPU snippets.
 *
 * The user (or, eventually, Claude via a tool call) writes a small
 * HTML/JS snippet that calls into `navigator.gpu`; we render it
 * inside a `srcdoc` iframe with a strict `sandbox` attribute so it
 * can't read the parent page's origin / cookies. WebGPU is feature-
 * detected; on browsers that lack it, we render a clear fallback
 * instead of a broken canvas.
 *
 * Why not run the snippet in the parent page?
 *   - WebGPU contexts can be performance-heavy (and crashy on some
 *     drivers); isolating them stops one bad snippet from taking
 *     down the whole Mission Control session.
 *   - The `sandbox` attribute denies same-origin access, which
 *     means a malicious snippet (think: pasted from chat) can't
 *     read `document.cookie` / `localStorage` from Mission Control.
 *
 * The snippet is wrapped in a tiny HTML scaffold (canvas + adapter
 * boilerplate) so users only need to write the interesting parts;
 * the entire compiled document is then handed to the iframe via
 * `srcdoc` (no network round-trip).
 */

import { useCallback, useEffect, useMemo, useState } from "react";

const STORAGE_KEY = "missionControl.webgpu.snippet.v1";

const DEFAULT_SNIPPET = `// Tiny WebGPU "hello triangle".
// 'device' and 'context' are pre-initialised on a 480×360 canvas.

const shader = device.createShaderModule({ code: \`
  @vertex
  fn vs(@builtin(vertex_index) i : u32) -> @builtin(position) vec4f {
    var p = array<vec2f,3>(vec2f(0,0.6), vec2f(-0.6,-0.6), vec2f(0.6,-0.6));
    return vec4f(p[i], 0, 1);
  }
  @fragment
  fn fs() -> @location(0) vec4f { return vec4f(0.4, 0.9, 0.6, 1); }
\` });

const pipeline = device.createRenderPipeline({
  layout: "auto",
  vertex: { module: shader, entryPoint: "vs" },
  fragment: { module: shader, entryPoint: "fs",
              targets: [{ format: navigator.gpu.getPreferredCanvasFormat() }] },
  primitive: { topology: "triangle-list" }
});

const enc = device.createCommandEncoder();
const pass = enc.beginRenderPass({
  colorAttachments: [{
    view: context.getCurrentTexture().createView(),
    clearValue: { r: 0.05, g: 0.05, b: 0.07, a: 1 },
    loadOp: "clear", storeOp: "store"
  }]
});
pass.setPipeline(pipeline);
pass.draw(3);
pass.end();
device.queue.submit([enc.finish()]);
`;

/**
 * Build the full HTML document that runs inside the sandbox iframe.
 * Keeping it as a function (rather than a constant) makes the
 * scaffold testable / inspectable without touching the DOM.
 *
 * Note: the user snippet is concatenated as a string into a script
 * tag *inside the sandboxed iframe*. The sandbox attribute (set on
 * the parent <iframe>) ensures the script runs with a unique origin
 * and cannot reach Mission Control's cookies / storage. Inside the
 * iframe we still use a CSP that only allows inline scripts so a
 * runaway `fetch("//evil.com")` is blocked at the network layer.
 */
export function buildSandboxDocument(snippet: string): string {
  // Escape any literal `</script` so the user can include it inside
  // a string without prematurely closing the inline script tag.
  const safeSnippet = snippet.replace(/<\/script/gi, "<\\/script");
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:;" />
<style>
  html,body { margin:0; padding:0; background:#0a0a0a; color:#e4e4e7;
              font:12px ui-monospace,monospace; }
  #wrap { display:flex; flex-direction:column; height:100vh; }
  #status { padding:6px 8px; border-bottom:1px solid #27272a;
            background:#000; color:#a1a1aa; }
  canvas { display:block; margin:auto; background:#000; }
  pre#log { margin:0; padding:6px 8px; border-top:1px solid #27272a;
            background:#000; color:#fca5a5; max-height:120px;
            overflow:auto; white-space:pre-wrap; }
</style>
</head>
<body>
<div id="wrap">
  <div id="status">initialising webgpu…</div>
  <canvas id="c" width="480" height="360"></canvas>
  <pre id="log"></pre>
</div>
<script>
(async () => {
  const status = document.getElementById("status");
  const log = document.getElementById("log");
  const canvas = document.getElementById("c");
  const print = (msg) => { log.textContent += msg + "\\n"; };
  try {
    if (!("gpu" in navigator)) {
      status.textContent = "WebGPU not available in this browser.";
      print("navigator.gpu is undefined.");
      return;
    }
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      status.textContent = "No WebGPU adapter available.";
      return;
    }
    const device = await adapter.requestDevice();
    const context = canvas.getContext("webgpu");
    context.configure({
      device,
      format: navigator.gpu.getPreferredCanvasFormat(),
      alphaMode: "opaque"
    });
    status.textContent = "running snippet…";
    // User snippet runs here with 'device', 'context', 'canvas' in scope.
    await (async () => {
      ${safeSnippet}
    })();
    status.textContent = "snippet ran.";
  } catch (err) {
    status.textContent = "snippet error";
    print(String(err && err.stack ? err.stack : err));
  }
})();
</script>
</body>
</html>`;
}

export function WebGPUView() {
  const [snippet, setSnippet] = useState<string>(DEFAULT_SNIPPET);
  // The actively-rendered snippet — separate from the editor draft so
  // typing doesn't re-evaluate on every keystroke.
  const [rendered, setRendered] = useState<string>(DEFAULT_SNIPPET);
  const [supported, setSupported] = useState<boolean | null>(null);
  const [runKey, setRunKey] = useState(0);

  // Hydrate persisted snippet + feature-detect WebGPU.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw && raw.length < 50_000) {
        setSnippet(raw);
        setRendered(raw);
      }
    } catch {
      /* ignore */
    }
    setSupported(typeof navigator !== "undefined" && "gpu" in navigator);
  }, []);

  const run = useCallback(() => {
    setRendered(snippet);
    setRunKey((k) => k + 1);
    try {
      window.localStorage.setItem(STORAGE_KEY, snippet);
    } catch {
      /* ignore */
    }
  }, [snippet]);

  const reset = useCallback(() => {
    setSnippet(DEFAULT_SNIPPET);
    setRendered(DEFAULT_SNIPPET);
    setRunKey((k) => k + 1);
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }, []);

  const srcDoc = useMemo(() => buildSandboxDocument(rendered), [rendered]);

  return (
    <div className="flex h-full w-full flex-col bg-zinc-950">
      <div className="flex items-center justify-between border-b border-zinc-900 bg-black px-3 py-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-500">
          WebGPU sandbox
        </span>
        <div className="flex items-center gap-2">
          {supported === false && (
            <span className="rounded bg-amber-500/20 px-1.5 py-0.5 font-mono text-[10px] text-amber-300">
              not supported in this browser
            </span>
          )}
          <button
            type="button"
            onClick={reset}
            className="rounded border border-zinc-800 px-2 py-1 text-[11px] text-zinc-400 hover:border-zinc-700 hover:text-zinc-200"
          >
            Reset
          </button>
          <button
            type="button"
            onClick={run}
            className="rounded border border-emerald-700/60 bg-emerald-500/10 px-2 py-1 text-[11px] text-emerald-300 hover:border-emerald-600"
          >
            ▶ Run
          </button>
        </div>
      </div>

      <div className="grid flex-1 grid-rows-2 gap-0 overflow-hidden lg:grid-cols-2 lg:grid-rows-1">
        <textarea
          value={snippet}
          onChange={(e) => setSnippet(e.target.value)}
          spellCheck={false}
          aria-label="WebGPU snippet"
          className="h-full w-full resize-none border-zinc-900 bg-black p-3 font-mono text-[11px] leading-5 text-zinc-200 focus:outline-none lg:border-r"
        />
        <div className="h-full w-full bg-black">
          {/*
            Sandboxed: no allow-same-origin → unique origin → cannot
            read parent cookies / storage. We deliberately do NOT
            include allow-top-navigation or allow-modals.
          */}
          <iframe
            key={runKey}
            srcDoc={srcDoc}
            sandbox="allow-scripts"
            title="WebGPU preview"
            className="h-full w-full border-0"
          />
        </div>
      </div>
    </div>
  );
}
