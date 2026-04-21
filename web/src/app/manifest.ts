import type { MetadataRoute } from "next";

/**
 * PWA manifest so Mission Control can be added to a phone's home
 * screen and launched standalone (no browser chrome).
 *
 * No service worker is registered yet — the dashboard is online-only
 * (live SSE from the gateway), and a stale offline shell would do
 * more harm than good. This manifest is just the install hook.
 *
 * Icons are intentionally inline SVGs so we don't need to ship binary
 * assets through the repo for v1; iOS/Android both accept SVG via the
 * `purpose: "any"` slot.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Mission Control — Claude Code Gateway",
    short_name: "Mission Control",
    description:
      "Web dashboard for the claude-code-openai-gateway proxy: tasks, terminal, workspace, and agent runtime.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: "#000000",
    theme_color: "#000000",
    icons: [
      {
        src: "/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any",
      },
      {
        src: "/icon-maskable.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "maskable",
      },
    ],
  };
}
