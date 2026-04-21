import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Standalone output makes Docker images small: Next.js bundles only
  // the runtime needed to serve the build, plus the minimal node_modules
  // tree it actually imports.
  output: "standalone",
  // `node-pty` is a native Node addon. Keep it external so Next/Turbopack
  // doesn't try to bundle the .node binding (which would fail) and so
  // the standalone output's tracer copies the real package over.
  serverExternalPackages: ["node-pty"],
};

export default nextConfig;
