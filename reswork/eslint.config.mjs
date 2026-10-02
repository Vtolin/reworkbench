// ESLint flat config (ESLint 9 + Next.js 16).
//
// Imports only declared dependencies (`eslint-config-next`) plus
// `eslint/config` (bundled with ESLint itself) — no transitive-only imports,
// so the config keeps working after a clean reinstall.
//
// Layers:
// - Next.js `core-web-vitals` + `typescript` presets for framework correctness.
// - Violation classification overrides (warn, not error) for pre-existing
//   patterns reviewed during the hardening pass — see comments below.
// - Architectural boundary rules mirror `src/architecture.test.ts` so
//   regressions fail `npm run lint` as well as `npm test`:
//     lib/**            -> no runtime imports from UI layers or React
//                        (type-only imports allowed, e.g. context types)
//     app/api/**        -> never the browser Supabase client
//     browser code      -> never server-only modules (service-role client,
//                        BYOK key crypto)
// Keep the boundary list small: it guards load-bearing seams, not style.
import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const UI_LAYERS_MSG =
  "Architectural boundary: lib/** must not depend on UI layers at runtime. " +
  "Move shared types to lib/ or use `import type` (allowed).";

const BROWSER_CLIENT_MSG =
  "Architectural boundary: API routes must use the server Supabase client " +
  "(@/lib/supabase/server), never the browser client.";

const SERVER_ONLY_MSG =
  "Architectural boundary: browser code must never import server-only " +
  "modules (service-role key / BYOK crypto stay server-side).";

export default defineConfig([
  globalIgnores([
    ".next/**",
    "node_modules/**",
    "supabase/**",
    "next-env.d.ts",
  ]),
  ...nextVitals,
  ...nextTs,
  // Violation classification (lint baseline, verified by inspection):
  // - `@typescript-eslint/no-explicit-any` (132 pre-existing sites): warn, not
  //   error. A mechanical `unknown`-migration across 20 working UI files is
  //   broad cosmetic churn with real behavior risk; `as any` growth is still
  //   blocked by the per-file ratchet in src/architecture.test.ts. New code
  //   should still prefer precise types — warnings keep that visible.
  // - `react-hooks/set-state-in-effect` (fetch-on-mount loaders with
  //   cancellation guards) and `react-hooks/purity` (transient Date.now() /
  //   Math.random() ids in event handlers): warn. The codebase has no
  //   Suspense data layer; restructuring every loader to satisfy the
  //   compiler-era rules would redesign working systems for no behavior gain.
  //   Each flagged site was reviewed: no render-phase side effects.
  // - `window.location.href` for internal navigation (2 sites): left as the
  //   preset's warning — the full reload is intentional (fresh server state
  //   after delete / workspace switch; router.push could render stale data).
  {
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/purity": "warn",
      "@typescript-eslint/no-unused-vars": ["warn", { ignoreRestSiblings: true, argsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["src/lib/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "react", message: UI_LAYERS_MSG, allowTypeImports: true },
          ],
          patterns: [
            { group: ["@/app/*"], message: UI_LAYERS_MSG, allowTypeImports: true },
            { group: ["@/components/*"], message: UI_LAYERS_MSG, allowTypeImports: true },
            { group: ["@/contexts/*"], message: UI_LAYERS_MSG, allowTypeImports: true },
          ],
        },
      ],
    },
  },
  {
    files: ["src/app/api/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        { paths: [{ name: "@/lib/supabase/client", message: BROWSER_CLIENT_MSG }] },
      ],
    },
  },
  {
    files: ["src/app/**/*.{ts,tsx}", "src/components/**/*.{ts,tsx}", "src/contexts/**/*.{ts,tsx}"],
    ignores: ["src/app/api/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "@/lib/supabase/server", message: SERVER_ONLY_MSG },
            { name: "@/lib/ai/keys", message: SERVER_ONLY_MSG },
          ],
        },
      ],
    },
  },
]);
