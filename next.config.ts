import type { NextConfig } from "next";

const config: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["@prisma/client", "prisma"],
  poweredByHeader: false,
  // proxy.ts sits in front of uploads; let bodies up to the upload limit through.
  experimental: { proxyClientMaxBodySize: `${Number(process.env.MAX_UPLOAD_MB ?? 25) + 2}mb` },
};

export default config;
