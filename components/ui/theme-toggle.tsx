"use client";

import { useLayoutEffect, useState, useSyncExternalStore } from "react";

import { applyTheme, getInitialTheme, THEME_STORAGE_KEY, type Theme } from "@/lib/theme";
import { cn } from "./utils";

function subscribeToThemePreference(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributeFilter: ["class"],
  });
  queueMicrotask(onChange);

  return () => observer.disconnect();
}

function getServerTheme(): Theme {
  return "dark";
}

function SunIcon() {
  return (
    <svg aria-hidden="true" className="size-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg aria-hidden="true" className="size-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a7 7 0 1 0 10.5 10.5Z" />
    </svg>
  );
}

export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const preferredTheme = useSyncExternalStore(
    subscribeToThemePreference,
    getInitialTheme,
    getServerTheme,
  );
  const [overrideTheme, setOverrideTheme] = useState<Theme | null>(null);
  const theme = overrideTheme ?? preferredTheme;

  useLayoutEffect(() => {
    applyTheme(getInitialTheme());
  }, []);

  function toggleTheme() {
    const nextTheme = theme === "dark" ? "light" : "dark";
    setOverrideTheme(nextTheme);
    window.localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
    applyTheme(nextTheme);
  }

  return (
    <button
      type="button"
      className={cn("icon-button h-11", compact ? "w-11" : "gap-2 px-3 text-xs font-medium")}
      suppressHydrationWarning
      aria-label={`Cambiar a tema ${theme === "dark" ? "claro" : "oscuro"}`}
      aria-pressed={theme === "dark"}
      onClick={toggleTheme}
    >
      <span aria-hidden="true" suppressHydrationWarning className="inline-flex">
        {theme === "dark" ? <SunIcon /> : <MoonIcon />}
      </span>
      {compact ? null : theme === "dark" ? "Oscuro" : "Claro"}
    </button>
  );
}
