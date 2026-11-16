# Scheduler safety repair — 14A.2

## Status and scope

This phase repairs the local M40 scheduler lease migration and introduces a platform-neutral supervised scheduler orchestrator with a guarded CLI and an inactive GitHub Actions template. M40 was **not applied remotely**. The workflow was not activated, pushed, or copied into `.github/workflows`. No scheduler run, pipeline, provider request, remote write, deferred-attempt resume, publication, billing change, or GitHub configuration write was performed. The deferred attempt `f794f73c-ce15-4167-beac-cb54bd6312af` was left untouched.

The runner uses the existing resume-first and capacity policies, the existing M40 lease/idempotency contract, bounded stage execution, heartbeat/fencing checks, and terminal finalization. The CLI rejects execution unless the caller supplies exactly `--execute-supervised` and `SCHEDULER_WORKER_ENABLED=true`; an enabled invocation derives its UTC trigger from the execution start time and calls the orchestrator once.

## M40 NULL defect and repair

In SQL three-valued logic, `NULL NOT BETWEEN 60 AND 1020` evaluates to `NULL`, and a PL/pgSQL `IF` does not take its branch for that value. A NULL lease TTL could therefore pass the range guard and produce a NULL expiry. The local M40 migration now explicitly rejects NULL TTLs in both claim and heartbeat before mutation. Heartbeat and finish also reject NULL required identity/state inputs; optional usage metrics remain optional but must be nonnegative when present.

The migration adds a constraint that prevents an owned, unreleased lease from having a NULL expiry. A claim encountering an already-active owner with ambiguous NULL expiry returns `ALREADY_RUNNING` rather than taking over. Resume claim/release validate required event identity and stage, and resume claim explicitly rejects a NULL stop reason before checking the allowed terminal reasons. The M40 deferred-capacity wrappers retain M35's explicit NULL checks; worker-budget validation uses NULL-distinguishing comparisons.

The focused regression is a local static SQL-contract and state-model test. It proves that NULL TTL and identity inputs fail closed, failed operations preserve owner/fence/expiry, boundary TTLs remain accepted, and an ambiguous existing lease is not taken over. It does not substitute for applying and validating M40 against the remote database. The migration's service-role ACL and fixed `search_path` contract are covered by the local migration test and static audit.

## GitHub remote inventory and plan

Read-only inspection found the remote `DiegoPerezSanchezDev/horizai` under a personal GitHub Free account. The repository is public but showed GitHub's Quick setup/empty-repository view: no default branch/content and no existing Actions workflows. The Actions usage view showed no activity rows for the Actions filter; the UI did not expose a raw account-wide included-minute balance. Budget settings did not finish loading, so budget configuration remains unknown. No payment information was surfaced, and no billing data was changed.

For the selected configuration—public repository plus standard `ubuntu-latest` GitHub-hosted runners—the official GitHub documentation states that standard runners are free and unlimited for public repositories. That makes the selected job's runner charge **$0**; this does not claim that arbitrary future configurations are free. Larger runners, self-hosted infrastructure, or changing the repository to private are outside this gate and require a new cost check. GitHub Free's included private-repository minute allotment is not the basis for the public-runner decision.

Sources: [GitHub-hosted runner choices](https://docs.github.com/en/actions/how-tos/write-workflows/choose-where-workflows-run/choose-the-runner-for-a-job), [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions), [workflow schedule events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows), [workflow troubleshooting and schedule delays](https://docs.github.com/en/actions/how-tos/troubleshoot-workflows), [GitHub Actions secrets](https://docs.github.com/en/code-security/reference/secret-security/secret-types).

## Zero-cost capacity model

The public standard-runner gate passes for this configuration. Approximate runner-minute scenarios at 30 scheduled runs per month are:

| Average run | Approximate monthly runner minutes |
| --- | ---: |
| 61 seconds | 31 |
| 13 minutes | 390 |
| 15 minutes | 450 |

These scenarios are planning estimates only. Public standard runner usage is free/unlimited under the cited policy. The empty Actions usage view means there is no observed prior Actions workload in this repository, not that account-wide raw usage was measured.

## Platform-neutral host and inactive workflow

The shared orchestrator is `lib/agents/pipeline/scheduler/supervised-scheduler-orchestrator.ts`; it is not tied to Netlify's Background Functions. The Netlify scheduler-specific worker and kickoff Background Function files were removed. The older `netlify/functions/scheduler-trigger.ts` remains an HTTP preflight route and does not execute the scheduler pipeline.

The GitHub template is at `ops/github-actions/horizai-supervised-scheduler.yml`, outside GitHub's workflow discovery directory. `.github/workflows` does not exist, so the template is inactive. If separately activated after the required remote gates, it specifies:

- `17 5 * * *` (05:17 UTC), with manual dispatch also subject to the explicit enable variable;
- `ubuntu-latest`, Node 22, `npm ci`, no package-manager cache, no artifact upload, and a 30-minute job timeout;
- concurrency group `horizai-supervised-scheduler`, `cancel-in-progress: false`, and read-only `contents` permission;
- one call to `npm run pipeline:supervised:scheduled -- --execute-supervised`;
- an exact-repository and `SCHEDULER_WORKER_ENABLED == 'true'` job guard.

GitHub scheduled events use UTC, run only from the default branch, and may be delayed under load. Since the event payload does not provide a reliable intended-day key, the runner uses the UTC date at invocation start, matching the M40 canonical trigger. A delivery delayed across UTC midnight can claim the invocation date on which it actually starts; M40's one-trigger-per-day idempotency still applies, but a very late delivery could consume the next day's trigger early. This behavior is documented rather than hidden behind parsing the cron event text.

## Secret model

The workflow names only these required secrets: `SUPABASE_SECRET_KEY` and `AGENT_API_KEY`. Required non-secret variables are `NEXT_PUBLIC_SUPABASE_URL`, `AGENT_API_URL`, and the opt-in `SCHEDULER_WORKER_ENABLED`; the provider selector is fixed to `groq`. Secrets are scoped only to the execution step, not dependency installation. No secret values are in the template, tests, or artifact. No direct database URL, scheduler internal token, Cloudflare credential, or Cerebras credential is passed by this template.

## Tests and verification

Passed offline suites included scheduler host, M40 NULL lease regression, scheduler safety, scheduler unit/simulation/wiring/execution, capacity defer/resume (including M33 and M35 fixtures), durable checkpoints, 12F.10, provider budget/Groq capacity/policy/full-path/token budget, Cloudflare accounting baseline, runtime reservation/telemetry, pipeline unit/wiring/attempts/boundaries/finalization/throughput, human review, migrations 31/32/34/39, and human-review revision binding/RPC error suites. `npm.cmd run lint`, `npx.cmd tsc --noEmit`, the secret audit, and `git diff --check` passed. The secret audit found no findings and confirmed `.env.local` is ignored.

The original OneDrive workspace build compiled and passed TypeScript, then **failed** twice during static prerender of `/contacto` with Windows `EPERM` creating `.next/server/app/contacto.segments/contacto`. Phase 14A.2b copied the current source state to a clean non-OneDrive local workspace, installed the locked dependencies with `npm ci`, and ran the same canonical `next build --webpack`: compile, TypeScript, and all 19 static pages passed, including static prerender of `/contacto`. The isolated build had no `.env.local`, no private runtime credentials, and no `NEXT_PUBLIC_SITE_URL`; the expected noindex fallback was logged. This isolates the original failure to the OneDrive-backed workspace filesystem. No application or Next configuration change was needed.

The Windows operational command for a future separately authorized execution remains `npm.cmd run pipeline:supervised:run -- --execute-supervised`. The new host CLI package entry is `npm run pipeline:supervised:scheduled -- --execute-supervised`; it is guarded and has not been executed against a real pipeline.

## Readiness and blockers

- **M40 local repair / remote-apply package:** ready for a separately authorized remote-application phase; remote status remains unapplied.
- **Zero-cost GitHub standard-runner gate:** PASS for the public repository and `ubuntu-latest` configuration only.
- **14A.2 implementation:** PASS after isolated build verification. Use a non-sync local workspace when local build artifact reliability is required; the original OneDrive workspace remains unsuitable for this build operation.
- **Scheduler activation / real GitHub QA:** NOT READY. The remote repository has no default branch/content, M40 is not applied remotely, and secrets and enable variable are not configured. GitHub's Linux runner is not inside local OneDrive, but that fact alone does not prove a future workflow run.
- **Workflow template:** inactive, as required.
- **Spend and mutations in this phase:** provider calls 0; pipeline executions 0; remote writes 0; billing changes 0; workflow activations 0; cost $0.
