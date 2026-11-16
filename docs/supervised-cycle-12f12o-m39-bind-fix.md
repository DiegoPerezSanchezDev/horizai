# FASE 12F.12O — M39 bind fix and single human-revision bind

## Finding

M38's deployed `public.bind_pipeline_human_review_revision(...)` failed with SQLSTATE `42725` (`operator is not unique: unknown - unknown`) before it could validate or store a revision. The cause was the expression:

```sql
(p_corrected_publication_payload->'article' - 'slug')
```

PostgreSQL parses this as `p_corrected_publication_payload -> ('article' - 'slug')`: binary `-` has higher precedence than the JSON navigation operator. Both operands of the inner subtraction are untyped string literals (`unknown`), so the parser cannot select an operator. The other two M38 subtraction expressions subtract a key from a JSONB operand and resolve to JSONB successfully. The function's directly called canonical JSON helper has no subtraction expression.

Read-only expression probes showed the article-key subtraction succeeds, the failing expression raises `42725`, and `((payload->'article') - 'slug'::text)` succeeds. A synthetic review/attempt/critic fixture called the deployed M38 function and reproduced `42725` at the function's initial validation `IF`; the fixture always raises to roll back. No production review was used for diagnosis. PostgreSQL documents operator precedence in [Lexical Structure: Operator Precedence](https://www.postgresql.org/docs/current/sql-syntax-lexical.html).

## Forward fix

Added only `supabase/migrations/20261021120000_human_review_revision_bind_operator_precedence_fix.sql` (M39). It replaces the binding RPC and changes the failing predicate to:

```sql
((p_corrected_publication_payload->'article') - 'slug'::text)
```

A static comparison confirms the function body is otherwise identical to M38 (normalizing `CREATE OR REPLACE` to M38's `CREATE`). The function remains `SECURITY DEFINER` with `search_path = pg_catalog, public, pg_temp`; execute remains granted only to `service_role`. No table grants or policies were added. The revision table remains RLS-enabled with zero policies and no direct SELECT/INSERT privileges for `service_role`, anon, or authenticated users.

The M39 rollback fixture passed: three hash/lineage mismatches were rejected; HOLD and consumed reviews were rejected; a valid corrected revision bound; revision mutation and duplicate insertion were blocked; stale-original approval was rejected; corrected-revision approval was supported only inside a forced rollback. The remote residual query found zero fixture attempts, critic runs, reviews, or revisions.

M39 was applied once via the established direct migration runner. Remote migration history confirms `20261021120000` is the head. The remote ACL probe confirms the function exists, is security-definer with the hardened path, is executable by `service_role`, and is not executable by anon/authenticated/public.

## Single post-fix bind

The existing review was revalidated immediately before the sole M39 bind: review `ebd8acc0-76a2-4977-81d9-60a7f6240084` was `WAITING_FOR_HUMAN_REVIEW`, unconsumed, targeted at ORIGINAL, with no revision. Its completed attempt `4658d5c0-857c-4ed5-b97f-afb133b2bf22` was terminal at `human_review`, with `HUMAN_REVIEW_PENDING`, retry class `NONE`, and no retry-limit charge. The same-attempt M34 Critic proof passed on the original draft. There were no active, deferred, or stuck attempts for the run.

Exactly one bind RPC succeeded and created revision `6fd9fae7-dbc6-4e13-abba-c4c6dfca38d9`, version 1. The corrected draft SHA256 is `69f0d3e350621f86c69a72d2cb1cbf1cb390212d695f932eedb03d325ade2045`; the original SHA256 remains `3e03a0ada667bd6b46be7f99ac06d5c24ca80e82adaa33e85bb090a7b4062b14`; source-lineage SHA256 remains `42c5de597f333d80c31d634f61960181d7f5480201237b9f447d37b651d968dc`.

The review remains `WAITING_FOR_HUMAN_REVIEW`, unconsumed, and now targets `HUMAN_REVISION` with the corrected hash. The stored revision retains the original draft and original critic proof. Publisher-target inspection confirms the corrected publication payload matches the bound revision. Public count remains 2, public article fingerprints are unchanged, provider usage is unchanged, and there were zero provider calls, pipeline runs, or human decisions. Publisher was not run; approval, hold, and reject were not executed.

## Verification

- Passed: M39 source/narrowness and runner unit tests; direct migration runner unit tests; human revision binding and safe RPC error tests; M31/M32/M34 human-review contract tests; supervised human-review unit fixtures (with a workspace-local temp directory); lint; `tsc --noEmit`; safe secret audit (1,020 files, no findings); production build.
- The first sandboxed build attempt hit Windows `EPERM` creating a `.next` prerender directory. The same build passed when rerun with workspace write access. Next emitted the existing warning that `NEXT_PUBLIC_SITE_URL` is missing, so indexing metadata is disabled for that build.
- No M40 migration or second bind was created or attempted.

The review remains pending for the human factual/attribution decision.
