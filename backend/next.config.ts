import path from "path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactCompiler: true,
  turbopack: {
    // Pin the workspace root to this application. Without it Next.js walks up looking
    // for a lockfile, finds one in the user's home directory, and infers that as the
    // root — which produces a startup warning and can make file tracing resolve
    // against the wrong tree.
    root: path.resolve(__dirname),
  },
};

export default nextConfig;
