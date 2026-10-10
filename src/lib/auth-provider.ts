import { getConfig } from "./config";

export type AuthProvider = "local" | "clerk";

export function getAuthProvider(): AuthProvider {
  const value = process.env.NOVA_AUTH_PROVIDER ?? "local";
  if (value !== "local" && value !== "clerk") throw new Error("NOVA_AUTH_PROVIDER must be local or clerk");
  return value;
}

export function getTestAccountUsernames(): string[] {
  const usernames = (process.env.NOVA_TEST_ACCOUNT_USERNAMES ?? "").split(",").map(value => value.trim().toLowerCase()).filter(Boolean);
  if (usernames.some(value => !/^[a-z0-9_.@-]{3,100}$/.test(value))) throw new Error("NOVA_TEST_ACCOUNT_USERNAMES must contain exact usernames");
  return [...new Set(usernames)];
}

export function hasTestAccountLogin(): boolean {
  return getAuthProvider() === "clerk" && getTestAccountUsernames().length > 0;
}

export interface ClerkConfig {
  publishableKey: string;
  secretKey: string;
  issuer: string;
  authorizedParties: string[];
}

// The publishable key is trusted deployment configuration, never a request input.
// Clerk encodes its Frontend API hostname followed by '$' in this key.
export function getClerkConfig(): ClerkConfig {
  const publishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ?? "";
  const secretKey = process.env.CLERK_SECRET_KEY ?? "";
  const match = /^pk_(test|live)_([A-Za-z0-9+/=_-]+)$/.exec(publishableKey);
  if (!match || !secretKey.startsWith(`sk_${match[1]}_`) || secretKey.length <= 8) {
    throw new Error("Matching Clerk publishable and secret keys must be configured");
  }
  const decoded = Buffer.from(match[2], "base64url").toString("utf8");
  if (!decoded.endsWith("$")) throw new Error("Clerk publishable key has an invalid hostname");
  const hostname = decoded.slice(0, -1);
  if (hostname.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/i.test(hostname)) {
    throw new Error("Clerk publishable key has an invalid hostname");
  }
  const issuer = `https://${hostname.toLowerCase()}`;
  const configuredIssuer = process.env.NOVA_CLERK_ISSUER;
  if (configuredIssuer !== undefined && configuredIssuer !== issuer) {
    throw new Error("NOVA_CLERK_ISSUER must match the publishable key origin");
  }
  return { publishableKey, secretKey, issuer, authorizedParties: [getConfig().publicUrl] };
}
