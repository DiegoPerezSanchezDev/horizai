# 12C.2 — Unpublish, Audit and Reprocess from Verifier

## Purpose

Prepare a narrowly scoped correction of the published Astra 6.1 article. Preserve the current published version as evidence, stop public exposure before replacement, restore source attribution and uncertainty from the Verifier stage, and require a fresh Critic pass before republication.

This document defines the next phase only. It does not execute an unpublish, model call, article update, or publication.

## Incident identity

- Article: 756b0ee0-b5e6-4153-846f-278a12c9afe3
- Event: 5138e509-f4c3-4020-9d13-6a6efac99a39
- eventKey: event-30f226d1b8ba5c9eb8af2b65c46db512
- Slug: openai-suspende-el-lanzamiento-del-modelo-astra-6-1-por-cuestiones-de-seguridad
- Source: TechCrunch AI, https://techcrunch.com/2026/09/28/openai-reportedly-ditches-model-over-safety-concerns
- Current incident record: docs/published-factual-incident-12c1.md
- Current machine-readable evidence: artifacts/published-factual-incident-12c1.json

## Required outcome

Keep the article out of the public contract until a source-aware replacement has completed Verifier, Translator, Editor, Classifier, Ranker, and Critic. Preserve the attribution chain accurately: TechCrunch reports the release decision and attributes the schedule and specific testing findings to The Wall Street Journal. Keep the source uncertainty visible in the headline and any repeated factual claims.

If the source evidence cannot support a corrected claim, leave the article archived and record why. Do not invent internal review details, mitigation conclusions, software vulnerabilities, or an absent alternative date.

## Phase steps

1. Re-read the incident report and checkpoint hashes. Read the article again through public_published_articles and verify articleId, eventId, slug, text, status, and current publication timestamp before any write.
2. Create a phase-specific before/after correction record referencing the 12C.1 snapshot hash, raw item ID and hashes, source URL, checkpoint files, human reviewer, reason for the correction, and each changed field. Do not copy the source article body into the record.
3. Resolve the missing operational path before changing production: confirm how an authorized, audited archive operation is performed; confirm the public contract stops returning the article after archive; and confirm that the existing canonical pipeline can safely rerun this already-published event from Verifier. The current application has no in-product human correction/unpublish flow and no row-level article revision history.
4. Recheck the pilot call and attempt budgets read-only immediately before execution. The last recorded baseline is 19/30 Groq calls and 4/5 canonical attempts. The expected full canonical rerun is 6 Groq calls, including a fresh Critic call. Publisher is deterministic and uses no model.
5. Preserve the existing article row and slug when the approved path permits it. Do not delete the event or raw item. Do not bypass Publisher or overwrite prose directly without the correction record.
6. Archive the current article before drafting or publishing the replacement. Read back the public contract to confirm the article is no longer visible.
7. Rerun the canonical pipeline from Verifier using the stored extraction and an explicit claim provenance ledger that distinguishes TechCrunch's reporting from facts attributed to WSJ. Translator must keep the qualifier; Editor must not add unsupported internal claims.
8. Require Critic to receive the source URL and original source evidence or a faithful claim ledger with evidence for each material claim. Stop if the source evidence is missing, the title drops a material qualifier, or unsupported claims remain.
9. Publish only after Critic passes and the human correction record is complete. Read the article back through the public contract; confirm the corrected headline, summary, body, sources, publication status, articleId, and slug. Add the resulting public snapshot hash and checkpoint hashes to the correction record.

## Guardrails

- No scheduler, router, Netlify deployment, or 12D work.
- No source article body copied into documentation.
- No change to other pilot articles.
- No schema or migration unless separately scoped and approved.
- Keep the article archived if the source chain or claim support is unresolved.
- The 12C.1 baseline records 11 Groq calls and 1 canonical attempt remaining; verify both values again before execution.

## Acceptance criteria

- The prior published row is snapshotted before archive or correction.
- Archive visibility is verified through the public contract before replacement publication.
- A human-reviewed correction record preserves before/after text and provenance.
- Any replacement comes from Verifier onward and completes all six canonical model stages, including Critic.
- The published version preserves the TechCrunch → WSJ attribution semantics and source uncertainty.
- No material internal-review, mitigation, vulnerability, or date claims appear without explicit source evidence.
- Final public contract readback matches the approved correction record.
- If any criterion cannot be met, the article remains archived and the phase reports the blocker without fabricating a correction.
