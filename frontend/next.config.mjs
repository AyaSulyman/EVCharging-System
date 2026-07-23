import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Pin the workspace root to this application. Without it, Next.js walks up looking
  // for a lockfile, finds a stray one in the user's home directory, and infers the
  // whole home folder as the root — so file tracing and watching then scan Desktop,
  // Downloads and everything else, which pins CPU and RAM on startup.
  outputFileTracingRoot: __dirname,
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "commons.wikimedia.org" },
      { protocol: "https", hostname: "upload.wikimedia.org" },
    ],
  },
};
export default nextConfig;
