import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Standalone output makes Docker images small: Next.js bundles only
  // the runtime needed to serve the build, plus the minimal node_modules
  // tree it actually imports.
  output: "standalone",
};

export default nextConfig;
