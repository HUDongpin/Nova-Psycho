import type { NextConfig } from "next";
const config: NextConfig = {
  distDir: process.env.NOVA_DIST_DIR ?? (process.env.VERCEL === "1" ? ".next" : process.env.NOVA_REGION === "HK" ? ".next-hk" : ".next"),
  output: process.env.VERCEL === "1" ? undefined : "standalone",
  serverExternalPackages: ["pg", "playwright", "@sparticuz/chromium"],
  outputFileTracingIncludes: {
    // Next 16.3.8's per-route traces omit this node-environment bootstrap import.
    "/*": ["./node_modules/next/dist/lib/framework/boundary-constants.js"],
    "/api/queues/report": ["./assets/fonts/**/*", "./node_modules/@sparticuz/chromium/bin/**/*", "./node_modules/playwright-core/browsers.json"]
  },
  outputFileTracingExcludes: {
    "/*": ["./work/**/*", "./.env", "./.env.*", "./.git/**/*", "./.vercel/**/*"]
  },
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
