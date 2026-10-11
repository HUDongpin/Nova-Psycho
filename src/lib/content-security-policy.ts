import { randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

export function pageResponseWithCsp(request: NextRequest, clerkIssuer?: string): NextResponse {
  const path = request.nextUrl.pathname;
  if (path === "/api" || path.startsWith("/api/") || path === "/__clerk" || path.startsWith("/__clerk/")) return NextResponse.next();

  const nonce = randomBytes(16).toString("base64");
  const development = process.env.NODE_ENV === "development";
  const scripts = ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'"];
  const connections = ["'self'"];
  const images = ["'self'", "data:", "blob:"];
  const frames = ["'self'"];
  if (development) {
    scripts.push("'unsafe-eval'");
    connections.push(`${request.nextUrl.protocol === "https:" ? "wss:" : "ws:"}//${request.nextUrl.host}`);
  }
  if (clerkIssuer) {
    scripts.push(clerkIssuer, "https://challenges.cloudflare.com", "https://*.protect.clerk.com");
    connections.push(clerkIssuer, "https://clerk-telemetry.com", "https://*.clerk-telemetry.com", "https://img.clerk.com", "https://*.protect.clerk.com:*");
    images.push("https://img.clerk.com");
    frames.push(clerkIssuer, "https://challenges.cloudflare.com", "https://*.protect.clerk.com");
  }
  const policy = [
    "default-src 'self'",
    `script-src ${scripts.join(" ")}`,
    "script-src-attr 'none'",
    // Clerk and the questionnaire render inline styles; this exception does not allow inline scripts.
    "style-src 'self' 'unsafe-inline'",
    `connect-src ${connections.join(" ")}`,
    `img-src ${images.join(" ")}`,
    "font-src 'self' data:",
    `frame-src ${frames.join(" ")}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ].join("; ");
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("content-security-policy", policy);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("content-security-policy", policy);
  return response;
}
