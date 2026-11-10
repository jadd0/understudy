import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The engine package ships TypeScript source; Next compiles it with the app.
  transpilePackages: ["@jadd0/understudy-engine", "@jadd0/understudy-providers"],
};

export default nextConfig;
