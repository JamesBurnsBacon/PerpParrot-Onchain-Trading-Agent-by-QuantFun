import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  devIndicators: false,
  // Webpack removes this dev import, but Next's file tracer still lists the raw TSX.
  // Do not package the unused source alongside the production 404.
  outputFileTracingExcludes: { "/parrot/lab": ["./app/parrot/lab/LabClient.tsx"] },
  // `next dev` on its own: the service paths go to the local Bun servers (bun run dev).
  // Production builds have none: vercel.json routes /api/backend and /api/executor.
  async rewrites() {
    if (process.env.NODE_ENV !== "development") return [];
    return [
      { source: "/api/backend/:path*", destination: "http://localhost:8788/:path*" },
      { source: "/api/executor/:path*", destination: "http://localhost:8787/:path*" },
    ];
  },
};
export default config;
