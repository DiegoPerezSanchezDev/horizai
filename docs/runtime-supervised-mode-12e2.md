# Runtime supervised mode and human approval gate (12E.2)

## Scope and operating boundary

This phase integrates the already-applied migration 31 contract into the runtime. It does not edit migrations 30 or 31, create migration 32, call a live model provider, create a real review, approve a real item, publish an article, or enable a recurring schedule. The first real supervised cycle remains a separate, explicitly authorized phase.

Migration 31's server-side RPCs remain the authoritative storage, decision, and single-use publication path. The local JSON package supplies inspectable evidence and checkpoint hashes; the RPC checks the attempt, Critic result, provider accounting, source lineage, review state, and publication payload again before accepting each state change.

## Review package

`buildHumanReviewSnapshot` creates a strict Zod package. Its canonical SHA-256 covers the stable event key, attempt and pipeline-run IDs, draft and draft hash, source/raw-item lineage, six checkpoint hashes, full review evidence, publication payload, and timestamp. The separate manifest hash covers the canonical manifest core. Hashing and equality decisions use the repository's canonical JSON serializer.

The package includes the full Verifier, Translator, Classifier, Geo, Ranker, and Critic outputs; editorial copy; source IDs, raw-item IDs, content hashes, canonical URLs, and registry URLs; and per-stage provider/model/request/token accounting. `eventId` is the stable `eventKey` at this pre-publication stage; a database event UUID does not exist yet. Attribution and uncertainty are explicitly marked for human confirmation. A missing stage, source identity, checkpoint, or settled provider usage fails closed.

The runtime runs the existing deterministic Publisher input validation before creating a review. Its factual/editorial guards and event lineage must pass. Migration 31 then performs final database-side accounting and raw-source lineage checks and changes the attempt to `WAITING_FOR_HUMAN_REVIEW` atomically with review-row creation.

## Critic lifecycle

- `Critic = pass`: persist the canonical review package, call the migration 31 create-review RPC, return `WAITING_FOR_HUMAN_REVIEW`, and stop. The Publisher stage is not called.
- Critic revise/reject, validation failure, unsettled usage, missing lineage, or invalid checkpoints: no publishable review is created; the event is blocked or failed for operator handling.
- The six model stages include the same `pipelineRunId` in their server-side agent-run metadata so migration 31 can correlate all six provider-ledger records with the review attempt.

## Publisher gate and stale approval

`Publisher.publish` rejects real writes without a complete, current APPROVE authorization. The authorization must match event, attempt, pipeline run, draft, package, checkpoints, and source lineage; record settled usage; show Critic PASS plus explicit factual and attribution approvals; remain unconsumed; and fit under the UTC-day publication cap. The regular atomic Publisher RPC is denied. The factual-remediation Publisher route is denied, and supervised orchestration also rejects both factual-remediation entry points.

Immediately before publication, the operator command rereads the review row and local package, checks the expected package SHA, compares database lineage and checkpoint manifest, hashes all six current checkpoint files, confirms APPROVED and unused state, checks settled-usage fields and the fresh UTC-day publication count, and then calls migration 31's atomic `publish_reviewed_article_atomic` RPC. The RPC owns final validation and consumption. A second use is rejected by that RPC. The CLI's day-wide scheduler lease serializes publication commands; a command can request one or two items and is stopped if the fresh daily count would exceed two.

## Operator commands

All commands execute server-side through `scripts/pipeline-human-review.ts`; no service-role credential is exposed in a client bundle.

```text
npm run pipeline:human-review -- status
npm run pipeline:human-review -- list
npm run pipeline:human-review -- inspect <review-uuid>
npm run pipeline:human-review -- approve <review-uuid> --reviewer=<id> --expected-package-sha256=<sha> --facts=pass --attribution=pass --uncertainty=pass --headline=pass --summary=pass --unsupported-claims=pass --source-chain=pass
npm run pipeline:human-review -- hold <review-uuid> --reviewer=<id> --expected-package-sha256=<sha> --facts=pass|fail --attribution=pass|fail --uncertainty=pass|fail --headline=pass|fail --summary=pass|fail --unsupported-claims=pass|fail --source-chain=pass|fail
npm run pipeline:human-review -- reject <review-uuid> --reviewer=<id> --expected-package-sha256=<sha> --facts=pass|fail --attribution=pass|fail --uncertainty=pass|fail --headline=pass|fail --summary=pass|fail --unsupported-claims=pass|fail --source-chain=pass|fail
npm run pipeline:human-review -- publish-approved <review-uuid>[,<review-uuid>] --expected-package-sha256=<sha>[,<sha>]
```

`approve`, `hold`, and `reject` require a reviewer, exact package hash, and all seven explicit review checks. APPROVE requires every check to pass; factual and attribution checks are never defaulted. HOLD and REJECT do not retry model work or publish. `list` displays concise review state and package evidence. `inspect` displays the full editorial, verification, uncertainty, attribution, Critic, classification, ranking, geography, provider-accounting, lineage, and manifest evidence. `status` reports UTC-day candidates and attempts, review state counts, publications/failures, Groq requests and settled tokens, plus active and one-hour-stuck attempts.

## Supervised runtime settings

`mode: "supervised"` is explicit and cannot be inferred from dry-run mode. The manual runner uses a unique UTC-day scheduler trigger, admits at most three candidates/events, and does not allow same-day lease recovery to start another batch. Event model stages run serially. Every production model configuration is transformed before being passed to its stage with `maxRetries = 0` and `allowPaidFallback = false`. The configured production provider remains Groq-only; Cloudflare and Cerebras are not fallback routes. Automatic factual remediation and automatic revision remain disabled. The recurring scheduler remains off.

## Public visibility and isolation

The migration 31 contract keeps WAITING, HOLD, and REJECT non-public; only the reviewed atomic publication path can create or update public content. Existing public reads are unchanged by this code change. No live database operation was performed in 12E.2, so this phase made no real review, approval, article, or provider-accounting writes.

## Local verification

The synthetic end-to-end suite covers strict package/manifest validation, Critic PASS to WAITING with zero Publisher calls, non-pass blocking, explicit operator decisions, current-checkpoint detection, provider-settlement failure, exact authorization identity, daily caps, single-use publication, sequential model execution, actual zero-retry/no-fallback request configuration, and status-report parsing. Migration 29, 30, and 31 fixture suites are local only. The remote 12E.1a one-resume regression is not rerun.

The complete offline suite and build results are recorded in [`artifacts/runtime-supervised-mode-12e2.json`](../artifacts/runtime-supervised-mode-12e2.json).
