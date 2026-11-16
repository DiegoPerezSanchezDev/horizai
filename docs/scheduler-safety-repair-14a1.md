# 14A.1 — M40 validation and Netlify Free credit gate

## Result

**`M40_REMOTE_VALIDATION_FAILED` — `READY FOR 14B = NO`.** The static review found a lease-safety defect before any remote database query or migration attempt. M40 was not applied. Scheduler functions were not deployed, no cron was configured, and no pipeline or provider was invoked. Cost for this phase: **€0**.

## M40 static review

M40 is forward-only and uses one transaction. Its DDL creates the scheduler lease table and invocation-claim table, seeds only the singleton lease row, adds a nullable `scheduler_defer_reason` column, and creates service-role RPCs. It does not directly update article, review, or attempt rows, consume a trigger, or create an invocation row. It adds new M40 RPC names rather than rewriting M31–M39 functions. The new functions revoke execution from `public`, `anon`, `authenticated`, and initially `service_role`, then grant only the intended RPCs to `service_role`; direct table privileges are revoked.

The planned rollback fixtures would have validated existing-row compatibility and the Postgres behavior. They were not run because the static gate failed first.

### Blocking defect: nullable lease TTL

In [`20261022120000_scheduler_safety_repair_m40.sql`](../supabase/migrations/20261022120000_scheduler_safety_repair_m40.sql), `claim_supervised_scheduler_invocation_m40` checks `p_lease_ttl_seconds NOT BETWEEN 60 AND 1020` (line 70) without rejecting `NULL`. In PostgreSQL, that expression evaluates to `NULL`; a PL/pgSQL `IF` does not enter its branch for a null condition. The function can then write a null `expires_at` and return `ACQUIRED`.

`heartbeat_supervised_scheduler_lease_m40` has the same nullable check (line 113). With a valid active lease and a null TTL, it can set `expires_at` to null and return success. The lease table permits a null expiry. A later claim for a different UTC day sees neither `expires_at > p_now` nor `expires_at <= p_now` as true and can replace the active owner. This violates the required active-lease and fencing contract.

Per the phase instructions, M40 was not edited or hotfixed, and all remote M40 work stopped at this finding.

## Remote baseline and migration

| Check | Result |
| --- | --- |
| Direct DB URL present | Yes; value not read into output |
| Explicit project target comparison | Matched `NEXT_PUBLIC_SUPABASE_URL`; host/ref not recorded |
| Canonical CLI | Local Supabase CLI 2.120.0 is installed |
| Remote migration history | Not read; stopped after static defect |
| Remote pre-migration baseline | Not run |
| M40 dry validation | Not run |
| M40 applied | No |
| Post-apply validation / ACL / lease tests | Not run |
| Remote writes | 0 |

The existing direct-migration wrapper still rejects M40 as an unexpected migration after M39. No wrapper changes were retained in this phase. That tooling guard is an additional precondition for a future, separately authorized M40 validation after the migration defect is addressed.

## Netlify Free plan and actual credit balance

Read-only inspection of the existing Netlify account session showed a **Credit-based Free** plan with a **300-credit** monthly allotment. The current cycle runs **2026-10-11 through 2026-11-10**, with credits expiring/resetting **2026-11-11**.

At inspection time:

- Used: **108.8 credits**
- Remaining: **191.2 credits**
- Breakdown: 7 production deploys / 105 credits; 9,553 web requests / 1.9 credits; compute / 0.3 credits; bandwidth / 1.7 credits; AI inference / 0 credits.
- The dashboard rounds each breakdown line to one decimal, so the displayed rounded components sum to 108.9; the authoritative total shown by the dashboard is 108.8.
- The Free plan has no auto-recharge option. The dashboard showed no payment method saved; Netlify documents that Free usage has a hard limit and projects pause at exhaustion.
- This phase did not change the plan, payment settings, or deployment state.

## Credit model and forecast

No function memory override was found in the project configuration. Netlify's documented default is 1,024 MB (1 GB); background functions have a 15-minute execution limit. Netlify documents 10 credits per GB-hour and 15 credits per production deploy.

Formula: `credits = (total runtime seconds / 3600) × memory GB × 10`. The estimate uses 30 days, a daily kickoff upper bound of 8 seconds, and 1 GB memory.

| Scenario | Per-day runtime modeled | Monthly scheduler compute |
| --- | ---: | ---: |
| Realistic | 60.852-second worker + 8-second kickoff | **5.74 credits** |
| Conservative | 13-minute worker + 8-second kickoff | **65.67 credits** |
| Platform maximum | 15-minute worker + 8-second kickoff | **75.67 credits** |

The team has used 108.8 credits over 12 elapsed days of the current cycle. Linear continuation of that observed whole-team pace projects **272.0 credits** for a 30-day cycle. This is a forecast, not a claim that usage will remain constant; the observed usage already includes 7 production deploys. Adding one production QA deploy (15 credits) yields:

| Scenario | Projected total | Headroom vs. 300 |
| --- | ---: | ---: |
| Realistic + one QA production deploy | **292.74** | **7.26** |
| Conservative + one QA production deploy | **352.67** | **−52.67** |
| Platform maximum + one QA production deploy | **362.67** | **−62.67** |

For the **18 days remaining in this actual billing cycle**, continuation of the observed team pace adds an estimated 163.2 other-use credits. From the current 108.8 already used, one QA production deploy, and daily scheduler compute for those remaining 18 days, the projected cycle-end totals are 290.44 realistic, 326.40 conservative, and 332.40 at the platform maximum. The conservative and maximum cases exceed the 300-credit limit by 26.40 and 32.40 credits, respectively.

The realistic projection leaves no material safety margin, and both conservative cases exceed the Free allotment. Thus `FREE_TIER_FIT = NO` under the required whole-team safety gate. Free deploy previews are not billed as production deploys, but they do not resolve the compute and whole-team usage margin.

**Safe 14B budget at current observed usage:** 0 production QA deploys and 0 background QA invocations. A nonzero allowance would depend on reducing/controlling the rest of the team's usage and obtaining a fresh balance and forecast first.

## Terminal state, tests, and readiness

- Remote M40 baseline, dry validation, apply, ACL checks, and non-destructive contract tests: **not run**, blocked by the static M40 defect.
- Offline migration/scheduler regression suites, lint, TypeScript, build, secret audit: **not run** after the stop condition.
- `git diff --check`: **failed on an existing unrelated working-tree change**, `tsconfig.json:45` (`+}` with trailing carriage return). That file was already modified before this phase and was left untouched. The two new report files passed a separate trailing-whitespace check.
- Scheduler deployed by this phase: **No**.
- Cron configured by this phase: **No**.
- Real kickoff / worker invocations / daily production triggers / pipeline runs / provider calls: **0**.
- Current M40 remote state: **not applied and not remotely inspected**.
- `FREE_TIER_FIT`: **NO**.
- `READY FOR 14B DEPLOYED SCHEDULER QA`: **NO**.

Netlify billing references: [How credits work](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/how-credits-work/), [Credit-based pricing plans](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/credit-based-pricing-plans/), and [Function configuration defaults](https://docs.netlify.com/build/functions/configuration/).
