import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the workspace root explicitly: a stray lockfile elsewhere on the
  // machine (outside this repo) would otherwise make Next.js guess wrong.
  turbopack: {
    root: path.join(__dirname, "..", ".."),
  },
};

export default nextConfig;
