import type { NextConfig } from "next";
const config: NextConfig = {
  distDir: process.env.NOVA_DIST_DIR ?? (process.env.NOVA_REGION === "HK" ? ".next-hk" : ".next"),
  output: "standalone",
  serverExternalPackages: ["pg", "playwright"],
  poweredByHeader: false,
  agentRules: false,
  devIndicators: false,
  logging: { incomingRequests: { ignore: [/\/api\/invite/] } },
  async headers() {
    return [{ source: "/:path*", headers: [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "no-referrer" },
      { key: "X-Frame-Options", value: "SAMEORIGIN" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" }
    ] }];
  }
};
export default config;
