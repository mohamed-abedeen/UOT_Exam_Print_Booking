"use client";

import { useEffect } from "react";

// Registers public/sw.js so the app can be installed on a phone (PWA, owner 2026-11-27).
export function RegisterServiceWorker() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).catch(() => {});
  }, []);
  return null;
}
