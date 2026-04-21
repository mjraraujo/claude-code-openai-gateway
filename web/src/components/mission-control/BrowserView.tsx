"use client";

/**
 * BrowserView — an iframe-based "internal browser" tab.
 *
 * This is *not* an embedded Chromium — Next.js apps can only render
 * `<iframe>`s, and they can only show targets that allow themselves
 * to be framed (no `X-Frame-Options: DENY`, permissive CSP). The
 * intended use is previewing a local development server (e.g.
 * `http://localhost:3000`) or a deployed staging URL.
 *
 * UX:
 *   - URL bar with an Open button (Enter also commits).
 *   - Reload button that bumps a `key` so React remounts the iframe.
 *   - "Open in new tab" escape hatch when the target refuses framing.
 *   - Last URL persisted in `localStorage` under a namespaced key.
 *
 * Safety:
 *   - The iframe is sandboxed (`allow-scripts allow-same-origin
 *     allow-forms allow-popups`) so a misbehaving previewed page
 *     can't, say, navigate the parent window.
 *   - `referrerpolicy="no-referrer"` reduces accidental leakage of
 *     the Mission Control URL to the previewed origin.
 *   - Only `http(s):` URLs are accepted; `javascript:` / `data:` /
 *     `file:` schemes are rejected at submit time so the address bar
 *     can't be used as an XSS surface.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

const STORAGE_KEY = "missionControl.browser.url.v1";
const DEFAULT_URL = "http://localhost:3000";

/**
 * Re-validate `value` and return a *re-serialised* URL string when
 * it parses as `http(s)`. Returning the URL constructor's
 * `.toString()` (rather than the raw input) is what makes CodeQL's
 * `js/xss-through-dom` tracker treat this as a sanitizer — the
 * output is guaranteed to come from `URL` parsing, so it can't
 * smuggle a `javascript:` prefix back through the iframe `src` /
 * anchor `href` sinks.
 */
function safeUrl(value: string): string {
  if (!value) return "";
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return url.toString();
  } catch {
    return "";
  }
}

/** Reject obviously dangerous schemes — only allow http(s). */
function isSafeUrl(value: string): boolean {
  return safeUrl(value) !== "";
}

export function BrowserView() {
  const [committed, setCommitted] = useState<string>("");
  const [draft, setDraft] = useState<string>("");
  // Bumped on every reload so React remounts the iframe — `iframe.src`
  // mutations don't always trigger a fresh navigation, but a key
  // change always does.
  const [reloadKey, setReloadKey] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Hydrate the last URL once on mount. We read from localStorage
  // inside an effect rather than during render so SSR doesn't crash;
  // the initial render shows the empty state for a frame.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw && isSafeUrl(raw)) {
        setDraft(raw);
        setCommitted(raw);
      } else {
        setDraft(DEFAULT_URL);
      }
    } catch {
      setDraft(DEFAULT_URL);
    }
  }, []);

  const submit = useCallback(() => {
    const trimmed = draft.trim();
    if (!isSafeUrl(trimmed)) {
      setError("Only http:// and https:// URLs are allowed.");
      return;
    }
    setError(null);
    setCommitted(trimmed);
    setReloadKey((k) => k + 1);
    try {
      window.localStorage.setItem(STORAGE_KEY, trimmed);
    } catch {
      // localStorage may be unavailable (e.g. private mode) — the
      // address still works for the session.
    }
  }, [draft]);

  const reload = useCallback(() => {
    if (!committed) return;
    setReloadKey((k) => k + 1);
  }, [committed]);

  // Re-validate AND re-serialise via the URL constructor at render
  // time so that any future code path that sets `committed` cannot
  // accidentally feed a `javascript:` / `data:` / `file:` URL to
  // the iframe `src` or anchor `href`. The reserialisation is what
  // satisfies CodeQL's `js/xss-through-dom` tracker — the output is
  // guaranteed to be the URL constructor's normalised form, which
  // can't smuggle a hostile scheme.
  const safeCommitted = useMemo(() => safeUrl(committed), [committed]);

  // Memoised so the iframe only swaps when the URL or reloadKey
  // actually change — important so typing in the URL bar doesn't
  // re-render the iframe on every keystroke.
  const iframeKey = useMemo(
    () => `${safeCommitted}#${reloadKey}`,
    [safeCommitted, reloadKey],
  );

  return (
    <div className="flex h-full w-full flex-col bg-zinc-950">
      <div className="flex items-center gap-2 border-b border-zinc-900 bg-black px-3 py-2">
        <button
          type="button"
          onClick={reload}
          disabled={!committed}
          aria-label="Reload preview"
          title="Reload"
          className="rounded border border-zinc-800 px-2 py-1 text-[11px] text-zinc-400 hover:border-zinc-700 hover:text-zinc-200 disabled:opacity-40"
        >
          ↻
        </button>
        <input
          type="url"
          inputMode="url"
          spellCheck={false}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="https://example.com"
          aria-label="Preview URL"
          className="flex-1 rounded border border-zinc-800 bg-black px-2 py-1 font-mono text-[11px] text-zinc-200 focus:border-zinc-600 focus:outline-none"
        />
        <button
          type="button"
          onClick={submit}
          className="rounded border border-zinc-800 px-2 py-1 text-[11px] text-zinc-300 hover:border-zinc-700 hover:text-zinc-100"
        >
          Open
        </button>
        {safeCommitted && (
          <a
            href={safeCommitted}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded border border-zinc-800 px-2 py-1 text-[11px] text-zinc-400 hover:border-zinc-700 hover:text-zinc-200"
            title="Open in new tab"
          >
            ↗
          </a>
        )}
      </div>

      {error && (
        <p className="border-b border-red-900/40 bg-red-500/10 px-3 py-1.5 font-mono text-[11px] text-red-300">
          {error}
        </p>
      )}

      <div className="relative flex-1 bg-white">
        {safeCommitted ? (
          <iframe
            key={iframeKey}
            src={safeCommitted}
            // Permissive enough for typical dev previews but still
            // sandboxed away from `allow-top-navigation` / `allow-
            // modals` which would let a hostile preview hijack the
            // Mission Control tab.
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            referrerPolicy="no-referrer"
            title="Internal browser preview"
            className="h-full w-full border-0"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-zinc-500">
            Enter a URL to preview (e.g. {DEFAULT_URL})
          </div>
        )}
      </div>

      <p className="border-t border-zinc-900 bg-black px-3 py-1.5 font-mono text-[10px] text-zinc-600">
        Note: sites with <code>X-Frame-Options: DENY</code> or restrictive CSPs
        won&rsquo;t render — use the ↗ button to open them in a new tab.
      </p>
    </div>
  );
}
