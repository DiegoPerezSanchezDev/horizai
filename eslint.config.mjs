import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    ".netlify/**",
    ".auth-01-local/**",
    "next-env.d.ts",
    "public/maplibre/**",
  ]),
  {
    files: ["app/**/*.{js,jsx,ts,tsx}", "components/**/*.{js,jsx,ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [{
          group: ["**/supabase/server-client", "**/supabase/server-client.ts", "**/agents/runtime/**", "**/agents/pipeline/**"],
          message: "Privileged Supabase and pipeline modules are server-only; access them through a protected server boundary.",
        }],
      }],
    },
  },
]);

export default eslintConfig;
