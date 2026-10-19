"use client";
import { useEffect, useState } from "react";
import InvitePage from "@/app/invite/page";
import RecoverPage from "@/app/recover/page";

// Copy only into an isolated development checkout for lifecycle tests, never a release.
export default function ReviewHarness() {
  const [view, setView] = useState<"invite" | "recover" | null>(null);
  useEffect(() => { setView(new URL(window.location.href).searchParams.get("view") === "recover" ? "recover" : "invite"); }, []);
  return <><button id="review-unmount" onClick={() => setView(null)}>Unmount tested component</button><div id="review-sentinel">Independent host remains mounted</div>{view === "invite" ? <InvitePage /> : view === "recover" ? <RecoverPage /> : null}</>;
}
