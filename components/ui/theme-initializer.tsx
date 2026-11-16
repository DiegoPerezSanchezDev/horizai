"use client";

import { useLayoutEffect, useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";

import { applyTheme, getInitialTheme, THEME_INITIALIZER } from "@/lib/theme";

const subscribe = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;

export function ThemeInitializer() {
  const pathname = usePathname();
  const hydrated = useSyncExternalStore(subscribe, clientSnapshot, serverSnapshot);

  useLayoutEffect(() => {
    applyTheme(getInitialTheme());
    const root = document.documentElement;
    const observer = new MutationObserver(() => {
      if (!root.classList.contains("light") && !root.classList.contains("dark")) {
        applyTheme(getInitialTheme());
      }
    });
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, [pathname, hydrated]);

  // Emit the existing bootstrap before visible server HTML. Client navigation
  // restores the preference without inserting an inert React script tag.
  return hydrated ? null : (
    <script id="horizai-theme" type="text/javascript" dangerouslySetInnerHTML={{ __html: THEME_INITIALIZER }} />
  );
}
