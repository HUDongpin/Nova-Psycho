import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";
import { getAuthProvider, getClerkConfig } from "./lib/auth-provider";
import { pageResponseWithCsp } from "./lib/content-security-policy";

const clerkProxy = clerkMiddleware((_auth, request) => pageResponseWithCsp(request, getClerkConfig().issuer), () => {
  const { publishableKey, authorizedParties } = getClerkConfig();
  return { publishableKey, authorizedParties };
});

export default function proxy(request: NextRequest, event: NextFetchEvent) {
  const path = request.nextUrl.pathname;
  if (getAuthProvider() === "local") return pageResponseWithCsp(request);
  if (path === "/api/liveness" || path.startsWith("/api/queues/") || path.startsWith("/api/cron/")) return NextResponse.next();
  return clerkProxy(request, event);
}

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|map)).*)",
    "/sign-in/:path*",
    "/sign-up/:path*",
    "/api/(.*)",
    "/__clerk/:path*",
  ],
};
