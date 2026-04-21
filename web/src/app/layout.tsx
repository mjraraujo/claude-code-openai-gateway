import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Claude Codex — Gateway Dashboard",
  description:
    "Web dashboard for the claude-codex gateway: tasks, terminal, workspace, and agent runtime that drives the official Claude Code CLI.",
  applicationName: "Claude Codex",
  appleWebApp: {
    capable: true,
    title: "Claude Codex",
    // Match the dashboard chrome so the iOS status bar blends in when
    // the page is added to the home screen.
    statusBarStyle: "black-translucent",
  },
};

// Separate `viewport` export (Next 14+) — covers initial scale, safe-area
// notch handling on iPhone, and a theme-color that matches the dashboard
// chrome so the OS browser UI doesn't flash white.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#000000",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col font-sans">{children}</body>
    </html>
  );
}
