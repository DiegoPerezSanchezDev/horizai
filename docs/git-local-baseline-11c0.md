# 11C.0 — Git baseline and local development readiness

Audit date: 2026-09-28

## INITIAL GIT STATE

- Repository root: `C:/Users/Diego/OneDrive/Desktop/horizai/horizai`
- Branch: `main`
- Tracked files before the baseline: `0`
- Commit history before the baseline: none; `main` had no commits.
- Remote: `origin` was already configured for fetch and push. It was not changed and no push was made.
- Initial non-ignored untracked files: `499`, including nine local Supabase CLI state files. After correcting ignore coverage, the safe candidate set was `490` files.

## GITIGNORE

`.gitignore` covers environment files (`.env*`, with `.env.example` allowed), `node_modules`, `.next`, generated MapLibre workers, TypeScript build state, Netlify local state, Supabase CLI state under `supabase/.temp/`, logs, temporary files, common OS/editor files, and existing generated cluster/verifier reports. The audit added the missing local-state, log, temporary-file, and editor-state rules. No source or required project files are ignored.

`.env.local` exists and is ignored. There was no `.netlify` directory. Local Netlify configuration and functions remain ordinary project files; no Netlify command or remote action was run.

## SECRET AUDIT

- Result: **PASS** for commit candidates.
- Candidate scan: all `492` non-ignored files staged for the baseline, plus explicit inspection of `.env.local` and local Supabase CLI state.
- Live credential matches in commit candidates: `0`.
- Scanner matches were environment-variable reads/references in provider and Supabase client code, a placeholder in setup documentation, request-header handling code, and unit-test fixture strings. None were live credentials. Docs and artifacts had no credential values, private-key blocks, bearer credentials, or database URLs with embedded passwords.
- `.env.local` contains local credential values and remains ignored. No values are copied into this report. No Supabase elevated-key/JWT credential was found in the commit candidates, including the old rotated-credential patterns checked during this audit.

## FILE CLASSIFICATION

**TRACK:** application source, tests, package files, configuration, `AGENTS.md`, product and technical documentation, migrations, intentional QA images, and benchmark/report artifacts used as project evidence or reproducible benchmark inputs. The 34 pipeline checkpoint JSON files and the supervised-candidate snapshot are referenced by the local Cloudflare benchmark and are retained as inputs.

**IGNORE:** `.env.local`, `node_modules`, `.next`, `public/maplibre/`, `tsconfig.tsbuildinfo`, `supabase/.temp/`, local Netlify/editor/cache/log/temp state, and the generated `artifacts/cluster-report.json` and `artifacts/verifier-report.json` outputs covered by the existing ignore rules. These files were not deleted.

**REVIEW_REQUIRED:** none after the audit.

## LARGE FILES

- `docs/references/hero-approved.png`: `2,057,405` bytes. This is the intentional approved visual reference and is retained.
- `artifacts/cluster-report.json`: `715,897` bytes. This generated report is already ignored and remains local.
- No other non-generated file exceeded `1 MiB`. Build output and the generated MapLibre worker are ignored.

## MIGRATIONS

The local migration directory contains migrations numbered `00000` through `00026`, including `20260927000026_cloudflare_quality_benchmark_authorization.sql`. No migration 27 exists or was created; no migration was modified.

## TESTS

- Local contract and unit scripts: **52/52 PASS** (the `:unit` package scripts plus `agents:contracts:test`).
- `npm run lint`: **PASS**.
- `npx tsc --noEmit`: **PASS**.
- `npm run build`: **PASS** using process-scoped offline Supabase/provider placeholders. Routes compiled with the home and article routes dynamic.
- Provider calls: `0`.
- Supabase writes: `0`.

The tests exercised local deterministic/unit code only. No provider or Supabase write test was run.

## BASELINE ACTION

After the candidate list, ignore rules, and staged content passed the secret review, one initial commit was created:

- Message: `chore: establish HorizAI local development baseline`
- Push: no.
- Remote changes: none.
- The staged diff review found five existing whitespace findings across four files: three Markdown hard-break lines, one TypeScript trailing space, and one blank line at the end of a SQL file. They were left unchanged as unrelated formatting; `git diff --cached --check` reports them.

The JSON artifact records `commitHash: null` because a root commit cannot contain its own hash without changing the commit contents and therefore changing that hash. The exact hash is reported from `git log` after commit creation; no second commit or history rewrite was used to work around this self-reference.

## FINAL GIT STATE

- Tracked files after baseline: `492`.
- Untracked files remaining: `0`.
- Working tree: clean.
- `.env.local` tracked: no.
- Secrets tracked: no.
- Git push: no.
- Netlify touched: no.

## LOCAL COMMANDS

- Development: `npm run dev`
- Production-like local build: `npm run build`
- Serve the production build locally: `npm run start`

No persistent server was started for this audit.

## NEXT STEP

`12A — Supervised real content pilot` is the next phase. It was not started as part of 11C.0. Netlify remains parked until October 8.
