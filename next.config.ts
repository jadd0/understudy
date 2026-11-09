import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The engine package ships TypeScript source; Next compiles it with the app.
  transpilePackages: ["@understudy/engine", "@understudy/providers"],
};

export default nextConfig;
