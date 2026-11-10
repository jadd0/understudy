import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Turbopack does not map a `./x.js` specifier to `x.ts`, so the app resolves the workspace packages to their built
  // `dist` through the tsconfig `paths` (the root `build` and `dev` scripts build the packages first).
  transpilePackages: ["@jadd0/understudy-engine", "@jadd0/understudy-providers"],
};

export default nextConfig;
