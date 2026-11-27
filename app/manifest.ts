import type { MetadataRoute } from "next";

// PWA manifest (owner 2026-11-27): install only, no offline cache; icons are made from the logo by scripts/make-icons.mjs.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "حجز طباعة الامتحانات",
    short_name: "طباعة الامتحانات",
    description: "حجز مواعيد تصوير الأوراق الامتحانية في مركز الطباعة بجامعة طرابلس",
    lang: "ar",
    dir: "rtl",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#f5f7f9",
    theme_color: "#007aff",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
