import type { NextConfig } from "next";

const config: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["@prisma/client", "prisma"],
  poweredByHeader: false,
  // REST access to MangoLab's control plane when the app is reached directly on :3000 (SSH tunnel). WebSockets need the gateway.
  async rewrites() {
    const lab = process.env.MANGOLAB_API_URL ?? "http://127.0.0.1:8200";
    return [{ source: "/lab-api/:path*", destination: `${lab}/lab-api/:path*` }];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
  // proxy.ts sits in front of uploads; let bodies up to the upload limit through.
  experimental: { proxyClientMaxBodySize: `${Number(process.env.MAX_UPLOAD_MB ?? 25) + 2}mb` },
};

export default config;
