"use client";
import { useEffect, useRef, useState } from "react";

const INVITATION_STORAGE = "nova-pending-invitation";
export function pendingInvitation(): string | null {
  try { const saved = JSON.parse(sessionStorage.getItem(INVITATION_STORAGE) || "null"); if (typeof saved?.token === "string" && saved.token.length <= 256 && Number.isFinite(saved?.expiresAt) && saved.expiresAt > Date.now()) return saved.token; sessionStorage.removeItem(INVITATION_STORAGE); } catch { /* Storage may be unavailable in a private browser. */ }
  return null;
}
export function clearPendingInvitation() { try { sessionStorage.removeItem(INVITATION_STORAGE); } catch { /* The in-memory token is still cleared by navigation. */ } }
export function useLinkToken({ persistForAuthentication = false }: { persistForAuthentication?: boolean } = {}) {
  const [link, setLink] = useState<{ token: string | null; generation: number }>({ token: null, generation: 0 });
  const initialized = useRef(false);
  const generation = useRef(0);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    const pathname = window.location.pathname;
    const read = (restore = false) => {
      if (window.location.pathname !== pathname) return;
      const fragment = new URLSearchParams(window.location.hash.slice(1));
      const query = new URLSearchParams(window.location.search);
      const supplied = fragment.get("token") || query.get("token");
      const token = supplied || (restore && persistForAuthentication ? pendingInvitation() : null) || "";
      if (persistForAuthentication && supplied) { try { sessionStorage.setItem(INVITATION_STORAGE, JSON.stringify({ token: supplied, expiresAt: Date.now() + 30 * 60_000 })); } catch { /* Keep the token in this page even when storage is disabled. */ } }
      setLink({ token, generation: ++generation.current });
      window.history.replaceState(window.history.state, "", pathname);
    };
    const hashChanged = (event: HashChangeEvent) => {
      // A preceding popstate may already have consumed and removed this token.
      if (event.newURL === window.location.href) read();
    };
    const popState = () => read();
    if (!initialized.current) { initialized.current = true; read(true); }
    window.addEventListener("hashchange", hashChanged);
    window.addEventListener("popstate", popState);
    return () => {
      mounted.current = false;
      window.removeEventListener("hashchange", hashChanged);
      window.removeEventListener("popstate", popState);
    };
  }, [persistForAuthentication]);
  return { token: link.token, generation: link.generation, isCurrent: () => mounted.current && generation.current === link.generation };
}
