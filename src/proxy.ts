import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";
import { getAuthProvider, getClerkConfig } from "./lib/auth-provider";

const clerkProxy = clerkMiddleware(() => undefined, () => {
  const { publishableKey, authorizedParties } = getClerkConfig();
  return { publishableKey, authorizedParties };
});

export default function proxy(request: NextRequest, event: NextFetchEvent) {
  const path = request.nextUrl.pathname;
  if (getAuthProvider() === "local" || path === "/api/liveness" || path.startsWith("/api/queues/") || path.startsWith("/api/cron/")) return NextResponse.next();
  return clerkProxy(request, event);
}

export const config = {
  matcher: ["/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|map)).*)", "/api/(.*)", "/__clerk/:path*"],
};
