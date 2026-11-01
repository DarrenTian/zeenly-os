import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // @zeenly-os/core ships TypeScript source.
  transpilePackages: ["@zeenly-os/core"],
  // The embedded database is WebAssembly and the Postgres driver opens
  // sockets: both run as plain Node modules, not through the bundler.
  serverExternalPackages: ["@electric-sql/pglite", "postgres"],
};

export default nextConfig;
