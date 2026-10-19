"use client";

import { Analytics } from "@vercel/analytics/next";

export function WebAnalytics() {
  return <Analytics beforeSend={event => {
    // Links can contain invitation/recovery tokens and family/report IDs.
    const url = new URL(event.url);
    url.search = "";
    url.hash = "";
    return { ...event, url: url.toString() };
  }} />;
}
