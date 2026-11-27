"use client";
// The theme control: one round glass button that cycles فاتح → داكن → تلقائي. The choice is saved in the browser
// (localStorage "theme"); the script in app/layout.tsx applies it before the first paint and follows the OS while
// it is "system".
import { useSyncExternalStore } from "react";
import { Icon, type IconName } from "@/components/ui/icons";

type Choice = "light" | "dark" | "system";
const ORDER: Choice[] = ["light", "dark", "system"];
const LABEL: Record<Choice, string> = { light: "فاتح", dark: "داكن", system: "تلقائي" };
const ICON: Record<Choice, IconName> = { light: "sun", dark: "moon", system: "display" };

function read(): Choice {
  try {
    const v = localStorage.getItem("theme");
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

const listeners = new Set<() => void>();
function subscribe(cb: () => void) {
  listeners.add(cb);
  window.addEventListener("storage", cb);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("storage", cb);
  };
}

function apply(choice: Choice) {
  const dark = choice === "dark" || (choice === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

export function ThemeButton() {
  // The server and the first client render say "system"; the saved choice follows right after hydration.
  const choice = useSyncExternalStore(subscribe, read, () => "system" as Choice);

  function next() {
    const n = ORDER[(ORDER.indexOf(choice) + 1) % ORDER.length];
    try {
      if (n === "system") localStorage.removeItem("theme");
      else localStorage.setItem("theme", n);
    } catch {
      // storage blocked: the choice still applies to this page view
    }
    apply(n);
    listeners.forEach((l) => l());
  }

  return (
    <button
      type="button"
      onClick={next}
      aria-label={`المظهر: ${LABEL[choice]}`}
      title={`المظهر: ${LABEL[choice]}`}
      className="lg flex size-11 items-center justify-center rounded-full"
    >
      <Icon name={ICON[choice]} variant="line" strokeWidth={1.8} className="size-5" />
    </button>
  );
}
