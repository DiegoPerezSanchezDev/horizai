export type Theme = "light" | "dark";

export const THEME_STORAGE_KEY = "horizai-theme";

export function getInitialTheme(): Theme {
  if (typeof window === "undefined") return "dark";

  const root = document.documentElement;
  if (root.classList.contains("light")) return "light";
  if (root.classList.contains("dark")) return "dark";

  let savedTheme: string | null = null;
  try {
    savedTheme = window.localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    savedTheme = null;
  }

  if (savedTheme === "light" || savedTheme === "dark") return savedTheme;

  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.classList.toggle("light", theme === "light");
}

export const THEME_INITIALIZER = `(function () {
  var root = document.documentElement;
  var storedTheme = null;

  try {
    storedTheme = localStorage.getItem("${THEME_STORAGE_KEY}");
  } catch (_error) {
    storedTheme = null;
  }

  var theme = storedTheme === "light" || storedTheme === "dark"
    ? storedTheme
    : (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");

  root.classList.toggle("dark", theme === "dark");
  root.classList.toggle("light", theme === "light");
})();`;
