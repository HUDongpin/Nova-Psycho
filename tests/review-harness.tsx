"use client";
import { useState, useSyncExternalStore } from "react";
import InvitePage from "@/app/invite/page";
import RecoverPage from "@/app/recover/page";

function requestedView(): "invite" | "recover" {
  return new URL(window.location.href).searchParams.get("view") === "recover" ? "recover" : "invite";
}
function subscribeToLocation(): () => void {
  return () => undefined;
}

// Copy only into an isolated development checkout for lifecycle tests, never a release.
export default function ReviewHarness() {
  const requested = useSyncExternalStore(subscribeToLocation, requestedView, () => "invite" as const);
  const [dismissed, setDismissed] = useState(false);
  const view = dismissed ? null : requested;
  return <><button id="review-unmount" onClick={() => setDismissed(true)}>Unmount tested component</button><div id="review-sentinel">Independent host remains mounted</div>{view === "invite" ? <InvitePage /> : <RecoverPage />}</>;
}
