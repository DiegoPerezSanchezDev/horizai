# 12F.4E.1 — cierre de observabilidad de extracción

## Resultado histórico reconstruido

La lectura privada read-only del 12F.4 original sí conserva evidencia durable para las tres extracciones seleccionadas y para las 45 filas de candidato. La reconstrucción usa `scheduler_runs`, `raw_items` y el código de discovery/extraction; no repite el pipeline ni vuelve a descargar feeds o artículos.

El scheduler run es `55aa2f13-77c8-458c-9170-501a6f16da4e`, el pipeline run es `579a63e9-62cf-4756-9ff6-fbd2683cf44b`, y `startedAt` de pipeline es `2026-10-10T12:20:01.345Z`.

| Orden de extracción | Candidate ID | Fuente | `raw_item_id` | Outcome persistido |
| ---: | --- | --- | --- | --- |
| 1 | `0afa63dc-7420-49b5-bd1e-ccbb2c6d7cb4:c55e260fb8ccbe0a26320a117e8eb620` | EL PAÍS Tecnología | `0b2d7f8f-0c02-49df-995b-a1d4c6215b95` | `FETCH_BLOCKED`, `error_code=blocked`, attempts 1 |
| 2 | `0afa63dc-7420-49b5-bd1e-ccbb2c6d7cb4:c50d75eca2e258494ce07e1b41f26828` | EL PAÍS Tecnología | `adb57da2-068c-4ed0-b251-1d673ee51c3b` | `FETCH_BLOCKED`, `error_code=blocked`, attempts 1 |
| 3 | `0afa63dc-7420-49b5-bd1e-ccbb2c6d7cb4:d58b804bbdfc8ed161902392a2c0f623` | EL PAÍS Tecnología | `6325b3b7-8002-4a09-866e-4ece9c2e3531` | `FETCH_BLOCKED`, `error_code=blocked`, attempts 1 |

Candidate IDs are the stored source-item IDs (source UUID plus the repository's canonical-URL hash). No article title, URL, or body is included.

### Evidencia del orden

`getActiveDiscoverySources()` orders the source registry by descending priority then ascending name. `discoverFromSources()` retains that source order while flattening each source's feed records, deduplicates in first-seen order, and `persistCandidates()` inserts the surviving candidates sequentially. The supervised orchestrator passes the first three candidates to extraction, and production extraction calls `extractCandidate()` serially in that order. The 45 `raw_items` rows with `discovered_at=2026-10-10T12:20:01.345Z` have unique source-item IDs and sequential `created_at` values. The first three inserted rows are the three IDs above. All three have persisted `extraction_failed` rows with one processing attempt and `error_code=blocked`.

Therefore candidate #3 is **known** and its terminal extraction outcome is **FETCH_BLOCKED**. The exact HTTP status is not needed to establish that outcome.

## Reconciliación 45 → 44

There is no unmatched 45th candidate. A read by the exact discovery timestamp returns 45 distinct `raw_items` rows. The earlier diagnostic counted 44 rows in the bounded run window because the third selected row's server-side `updated_at` is `2026-10-10T12:20:15.304637Z`, 40.637 ms after the application pipeline's `completedAt=2026-10-10T12:20:15.264Z`. That row was created at `12:20:02.832844Z`, during discovery; its extraction update crossed the application/server clock boundary. The row is the third EL PAÍS candidate above, not a missing discovery record.

The persisted final candidate in insertion order is Xataka, source-item ID `573f5906-53fd-49fb-b9bb-2b98b2503ac3:ac01e4a62e8ea1616ed469920cae33d8`, raw item `4d7bdb4e-7c14-4452-b2c3-7c5486e28136`. It also has a row at the exact discovery timestamp. The former 45→44 discrepancy is resolved as a timestamp-window counting error, not a dedupe or persistence failure.

The original remote scheduler history remains as recorded: `run_status=succeeded`, `final_decision=allowed`, `scheduler_decision=COMPLETED`, `stop_reason=null`. No remote historical row was changed.

## Counter contract

| Counter | Exact meaning |
| --- | --- |
| `discoveryCandidates` | Valid discovery records before URL/content-hash deduplication (`DiscoveryRunResult.candidatesDiscovered`). |
| `candidatesAfterDeduplication` | Candidate list remaining after deterministic first-seen deduplication. |
| `rawItemsTouched` | Distinct raw-item IDs with a confirmed mapping in the run's discovery or extraction persistence traces. A mapping/reuse is not itself a write. |
| `rawItemsInserted` | Successful new-row inserts across discovery and extraction persistence. |
| `rawItemsUpdated` | Successful update operations on existing rows, across discovery and extraction persistence. |
| `rawItemsReused` | Successful mappings to existing rows that this operation did not update. |
| `rawItemPersistenceErrors` | Discovery plus extraction persistence failures; individual selected candidates carry a typed failed mapping. |
| `extractionCandidatesSelected` | Exact candidates passed by the orchestrator to extraction. In supervised mode this is the first three post-dedup candidates. |
| `extractionAttempts` | Selected candidates for which extraction produced an attempted terminal result. |
| `extractionSucceeded` | Attempted candidates whose extraction status is `success` and produced an item. |
| `extractionFailed` | Attempted candidates whose extraction status is `blocked` or `failed`. |
| `extractionSkipped` | Selected candidates without an attempted terminal result. A positive count makes a zero-item run unresolved. |
| `extractedItems` | Non-null extracted items returned for the selected set; metadata-only items are still items. |

These are separate dimensions. `45 discovered / 3 selected / 0 extracted` means at most three fetch attempts, never 45 extraction attempts.

## Future-run observability fix

The supervised production orchestrator now uses the existing `agent_runs`/`agent_logs` pipeline persistence. It stores the pipeline run ID in the parent run config and writes the final safe discovery/extraction summary into `agent_runs.stats`.

The persisted extraction summary records, for each selected candidate, only:

- candidate ID, source ID, and mapped `raw_item_id`;
- discovery and extraction persistence mapping outcomes;
- attempted flag, fetch outcome, extraction outcome, failure code, parser outcome, quality-gate outcome, and typed terminal outcome.

It also records the aggregate counters above, duplicate/invalid discovery counts, and unexpected/missing extraction results. It does not persist candidate titles, URLs, excerpts, raw bodies, or error messages. A missing result is explicitly `NOT_ATTEMPTED` or `RUNTIME_ERROR_UNRESOLVED`; it cannot disappear from the selected set.

Raw persistence reports `created`, `updated`, `reused`, `failed`, and `not_requested` separately. The existing `action` field remains available to callers; the additional `updated` flag distinguishes an actual update from a reused row that was skipped because it was already processed.

## Zero-item terminal semantics

`NO_ELIGIBLE_EXTRACTED_ITEMS` is emitted only when:

- every selected candidate has one attempted, typed terminal outcome;
- selected and attempted counts match, with zero skipped or unexpected results;
- all terminal outcomes are known non-editorial fetch/content outcomes (`FETCH_BLOCKED`, `FETCH_FAILED`, `EMPTY_BODY`) and error codes are on the existing safe allowlist;
- parser and persistence failures are absent and all selected mappings are accounted for;
- `extractedItems=0`.

A missing terminal result, parser error, unknown error code, or persistence error remains `TECHNICAL_FAILURE / EXTRACTION_OUTCOME_UNRESOLVED`.

## Verificaciones

Offline regressions cover 45 discovered/3 selected with 2 blocked + 1 failed; 3 blocked; 1 success; created/reused raw-item mapping; a selected candidate without mapping; a missing selected terminal result; parser failure; and persistence failure. They also assert that the selected set is not replenished from the remaining 42 candidates and that the persisted summary has no content fields.

La reconstrucción histórica y el baseline READ ONLY están registrados en [artifacts/extraction-observability-closure-12f4e1.json](../artifacts/extraction-observability-closure-12f4e1.json). No se ejecutó el pipeline real, no se creó una ejecución de scheduler, no hubo escrituras remotas y no hubo llamadas a proveedores.
