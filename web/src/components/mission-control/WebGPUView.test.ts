/**
 * Tests for the WebGPU sandbox document builder. The runtime
 * behaviour (actually running WebGPU) lives inside an iframe and
 * isn't testable from node, but the *escaping* of user-supplied
 * snippets very much is — and getting it wrong would let a paste
 * break out of the inline `<script>` tag.
 */

import { describe, expect, it } from "vitest";

import { buildSandboxDocument } from "./WebGPUView";

describe("buildSandboxDocument", () => {
  it("embeds the snippet inside the inline script", () => {
    const html = buildSandboxDocument("console.log('hello');");
    expect(html).toContain("console.log('hello');");
    // Sanity check: the scaffold still wraps with the async IIFE.
    expect(html).toMatch(/\(async \(\) => \{/);
    expect(html).toContain("<canvas");
  });

  it("escapes literal </script tags so a snippet can't break out", () => {
    const evil = "/* break out: </script><img src=x onerror=alert(1)> */";
    const html = buildSandboxDocument(evil);
    // The literal `</script` must not appear unescaped inside the
    // user code we wrote; the only `</script>` in the doc should be
    // the one closing our own inline tag.
    const scriptCloses = html.match(/<\/script/gi) ?? [];
    expect(scriptCloses.length).toBe(1);
    // The escaped form must be present where the user code is.
    expect(html).toContain("<\\/script");
  });

  it("escapes mixed-case </SCRIPT tags too", () => {
    const html = buildSandboxDocument("// </SCRIPT>");
    const scriptCloses = html.match(/<\/script/gi) ?? [];
    // Only the genuine closer remains.
    expect(scriptCloses.length).toBe(1);
  });

  it("includes a strict CSP forbidding remote script / network access", () => {
    const html = buildSandboxDocument("");
    expect(html).toContain("Content-Security-Policy");
    // default-src 'none' means no remote subresource (script-src,
    // connect-src, etc.) can default-allow anything — only the
    // explicit `'unsafe-inline'` script we ship is allowed.
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("script-src 'unsafe-inline'");
  });

  it("does not split the document at the snippet's HTML-looking content", () => {
    // A snippet that *looks* like HTML (in a JS comment) must end up
    // only inside the inline <script>; it must not appear in the
    // body before/after the script tags. We verify that by checking
    // there is exactly one occurrence and that it is positioned
    // inside the script body.
    const snippet = "// <h1>not a heading</h1>";
    const html = buildSandboxDocument(snippet);
    const occurrences = html.split(snippet).length - 1;
    expect(occurrences).toBe(1);
    const scriptStart = html.indexOf("<script>");
    const scriptEnd = html.indexOf("</script>");
    const at = html.indexOf(snippet);
    expect(at).toBeGreaterThan(scriptStart);
    expect(at).toBeLessThan(scriptEnd);
  });
});
