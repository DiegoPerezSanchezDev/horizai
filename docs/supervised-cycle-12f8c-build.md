# 12F.8C — Build Toolchain Closure and Same-Day 12F.9 Gate

## Readiness

The repository build and required local regression gates pass after adopting Next's supported Webpack build mode. The same-day 12F.9 run was **not started**: a read-only candidate preflight discovered 52 extracted events and zero eligible events. Without an eligible candidate, the pre-run candidate gate is not satisfied.

12F.9 invocations: **0**. Provider calls: **0**. Remote writes: **0**.

## Build diagnosis

Before any build-related change, `npm run build` failed with 18 Turbopack resolution errors. The error family was `next/font/google` resolving `@vercel/turbopack-next/internal/font/google/font` from `app/layout.tsx`.

The same application completed `next build --webpack`, including TypeScript validation and static generation. The evidence classifies the defect as `TURBOPACK_RESOLUTION_BUG`: the installed application and font imports build with the officially supported Webpack mode, without dependency or font changes.

## Package and toolchain

- Node: `v22.14.0`
- npm: `10.9.2`
- Next expected by `package.json`: `16.3.4`
- Next locked in `package-lock.json`: `16.3.4`
- Next installed: `16.3.4`
- React / React DOM: `19.2.8`
- No duplicate or conflicting Next installation was found.
- The expected Turbopack font internal module was not present as a top-level or compiled package module.
- Installed Next matched the lockfile. No dependency versions or lockfile entries were changed for this fix.

## Fonts and UI contract

`app/layout.tsx` imports Inter, Manrope, and JetBrains Mono through `next/font/google`. Their configuration follows the installed Next version's font guide and the existing approved typography contract. No font, layout, or visual design change was made. The home, map, and article routes were smoke-tested locally; the approved E hero typography rendered.

## Generated cache inspection

The build failure was reproduced before changing the build script. `.next` was identified as generated output; `.turbo` was absent. No source files were removed. The attempted `.next` cleanup was rejected by the shell's recursive-removal policy, so no cache was deleted. The successful Webpack build and repeated Turbopack-specific error support the classification above; a clean-cache comparison was not obtained.

## Bundler comparison and fix

| Command | Result |
| --- | --- |
| Original `npm run build` using default Turbopack | Failed: missing `@vercel/turbopack-next/internal/font/google/font` resolution |
| `next build --webpack` | Passed compilation, TypeScript, static generation, and route output |
| Canonical `npm run build` after the fix | Passed using the repository build contract |

The smallest proven fix was changing the package build script from `next build` to `next build --webpack`. This intentionally adopts Next's supported Webpack build mode as the repository's normal build contract. No deployment was performed. Netlify has no custom build bundler override and uses the repository's `npm run build` output.

The build emitted warnings that `NEXT_PUBLIC_SITE_URL` was missing or invalid in this local environment; the build still passed and indexing metadata was disabled there.

## Frontend smoke

The local production server was started on `127.0.0.1:3117` because existing listeners occupied the usual ports; those unrelated processes were left running. The temporary server was stopped after the smoke check. Home, approved E hero/fonts, map, and article route rendered. No remote app mutations or provider requests occurred.

## Local tests and gates

The following checks passed:

- `npm run lint`
- `npx tsc --noEmit`
- canonical `npm run build`
- `git diff --check`
- `node scripts/safe-secret-audit.mjs` (785 files scanned, zero findings; `.env.local` ignored)
- Verifier compaction and `VERIFIER_INPUT_TOO_LARGE`
- M35 first-stage capacity defer and fresh-process same-attempt Verifier resume
- same-attempt capacity resume; M33 lifecycle and migration guard
- Editor capacity continuation and Editor grounding
- Groq capacity, token budget, full-path, router, and provider budget offline gates
- runtime reservation and telemetry; Cloudflare accounting baseline
- supervised throughput, three-attempt and 18-request caps, safe rejection and no replacement
- supervised finalization, scheduler mapping/execution/wiring
- migration 31 human-review gate; Critic and durable checkpoint; migration 34 same-attempt Critic proof
- migration 32 human-review read path

All listed pipeline and provider checks were offline. Provider requests and tokens: `0 / 0`.

## UTC trigger and remote baseline

The runner's exact UTC date expression, `new Date().toISOString().slice(0, 10)`, returned `2026-10-15`. The trigger was `supervised-candidates:2026-10-15`. A read-only PostgREST check returned HTTP 200 and found no existing run; it was available at the time checked.

The read-only baseline matched the requested values:

- Remote migration head `20261014120000`; M35 present.
- M32 status/list: PASS; total, waiting, and listed review rows `0/0/0`.
- Attempts: `16`; active/deferred/stuck: `0/0/0`.
- Public articles: `2`.
- Astra: archived.
- Unknown reservations: `0`.
- Current UTC-day Groq, Cloudflare, and Cerebras reservations and dispatch/token counters: `0`.
- Established public fingerprints matched:
  - Article `6203559f-413a-4f06-9346-1720bbeb0e7a`: `73c601cf62d3663ac3f18566cc67f2529acb663dcabdfc3a679b8d8d90966b64`
  - Article `7415c685-04ed-4956-a77a-4bc372c9b060`: `728f67672214de59791a44e10c83359353f28f97b81d81e4750cf47c5894200b`

## Candidate eligibility preflight

A read-only 24-hour discovery/extraction/clustering preflight ran with `persistTraceability: false`. Network access was restricted to GET/HEAD. It found 58 discovery candidates, 52 successful extractions, 3 extraction failures, and 52 clustered events. It performed zero raw-item writes and ran no provider stages. The attempt eligibility lookup marked zero events eligible; therefore no candidate could be verified as admissible before provider execution. The per-event eligibility reasons were not retained by that preflight summary, so this record does not attribute the result to a specific reason.

This unmet candidate gate is the reason 12F.9 was not invoked, even though the trigger and baseline checks were clean. No scheduler run was created by this preflight, and the daily trigger was not consumed.

## Historical hash evidence

The authoritative current fingerprints match the established 12F.2d–12F.7 baseline shown above. An older 12F.8 artifact records a one-character discrepancy for Article 2 (`...e10e833...` rather than `...e10c833...`). This is recorded as `HISTORICAL_ARTIFACT_DISCREPANCY`; no historical artifact was rewritten.

## Final status

- Build toolchain closure: **PASS**
- Local and offline regression gates: **PASS**
- Trigger at read time: **AVAILABLE**
- Candidate eligibility gate: **NOT SATISFIED (0 eligible events)**
- 12F.9: **NOT RUN**
- Publisher: **NOT RUN**
- Public articles/fingerprints: unchanged at baseline check
- Provider calls / remote writes: **0 / 0**
- READY FOR NEXT STEP: **NO**

Stop here. Re-run 12F.9 only after a fresh read-only preflight identifies at least one eligible candidate and all required gates are revalidated.
