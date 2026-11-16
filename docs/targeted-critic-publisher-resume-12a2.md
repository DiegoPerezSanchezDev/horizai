# 12A.2 — Targeted Critic Revalidation and Publisher Recovery

**Result: READY YES — published and verified locally.** Event: `event-cbbf85234317a442f59ece63ef1b40c8`.

## COOLDOWN

The canonical cooldown ended at `2026-09-29T00:00:00Z`. The read-only preflight at `2026-09-29T20:06:47Z` found it elapsed and the event eligible. No attempt timestamp was changed. Attempt 2 was acquired through the normal repository at `20:07:10Z` and finalized as `READY_FOR_PUBLICATION` at `20:07:35Z` (`retryClass=NONE`, not counted toward the retry limit). Attempt 1 remains preserved as the earlier Publisher technical failure.

## PREFLIGHT

- Local and remote Supabase migration histories matched through `20260927000026`; migration 27 does not exist. No schema change was made.
- All six persisted stage checkpoints were read with their safe readers and aligned. Verifier, Translator, Editor, Classifier, and Ranker were not rerun.
- The original event and article slug were absent; the public view count was 0. The source raw item resolved uniquely, belonged to The Verge AI, and had `processing_status=extracted` and `extraction_quality=full`.
- Critic schema, deterministic prechecks, geo consistency, Publisher payload projection, and region registry checks passed.
- Free provider router and scheduler stayed disabled. Netlify was not touched; nothing was deployed.

## CAPACITY

At preflight, Groq had 0 requests and 0 tokens accounted for the UTC day, no unknown dispatched reservations, and no active provider block. The estimated Critic request was 7,535 tokens. Canonical TPM pacing returned `WAIT_FOR_TOKEN_RESET` for about 21.7 seconds; the production runner applied that policy before dispatch.

## CHECKPOINT RECOVERY

The historical checkpoints were not changed. Their six preflight hashes match the post-execution hashes. The corrected Critic result was written separately at `artifacts/pipeline-checkpoints/8c96ffb9-4705-4aab-b396-7e4cc41b2939/critic-event-cbbf85234317a442f59ece63ef1b40c8.json`.

## GEO PROJECTION

The old Critic checkpoint recorded `GLOBAL`, `countryCodes=["US"]`, and the incorrect coordinates `(39.8283, -98.5795)`. The deterministic projection used the active GLOBAL registry point `(20, 0)` and preserved `countryCodes=["US"]`. Historical classification evidence remains unchanged.

## CRITIC INPUT DIFF

The only model-input paths that changed were `classification.latitude` and `classification.longitude`. Removing those two fields makes the old and new model inputs deeply equal. The new schema and deterministic prechecks passed with no issues.

## CRITIC EXECUTION

The production `CriticAgent` ran once with `critic-v3`, Groq, model `openai/gpt-oss-20b`, and `maxRetries=0`. The response was HTTP 200. Usage was settled in the canonical ledger as 2,777 input + 45 output = **2,822 tokens**. Retries and fallback calls were 0.

## CRITIC RESULT

Decision: **`pass`**, severity `low`; issues and unsupported claims were empty. The result was schema-valid and its deterministic prechecks passed. This was the only new provider request.

## PUBLISHER READINESS

Final readiness passed with no issues. It confirmed event creation was appropriate, the raw-item ownership check covered the one source, and the final payload still matched the corrected region registry point. Duplicate checks passed immediately before the write.

## PUBLICATION

The real deterministic Publisher committed one `publish_article_atomic` transaction. It created one event and one article, linked 2 categories, 1 entity, and 1 source, and reported 4 relations created. No manual database inserts or repair writes were made.

- Event ID: `c5575e04-85fb-4b5e-adbb-b3acc6368c4f`
- Article ID: `6203559f-413a-4f06-9346-1720bbeb0e7a`
- Slug: `openai-emplea-agentes-para-escanear-el-sitio-de-estadisticas-de-la-onu-mas-de-16-000-veces`
- The Publisher returned `activityRowsCreated=0`; its current atomic publication contract does not recalculate aggregate `activity_history` rows. The count remained 0, as expected by that contract.

## PUBLIC CONTRACT

The public `public_published_articles` view returned exactly one row for the slug. The article is published and Critic-approved; there is one event, one article, one slug, and no duplicate materialization. Public article count changed from **0 to 1**.

- Headline: OpenAI emplea agentes para escanear el sitio de estadísticas de la ONU más de 16.000 veces
- Summary: Entre abril y junio de 2026, agentes autónomos de OpenAI escanearon el sitio de estadísticas de la ONU (UNCTADstat) más de 16.000 veces. El objetivo aparente era extraer información pública relacionada con el Índice de Capacidades Productivas mediante la API del portal.
- Por qué importa: El caso evidencia la creciente capacidad de los agentes de IA para realizar búsquedas automatizadas a gran escala en sitios web internacionales, planteando preguntas sobre la seguridad, la ética y la gestión de datos públicos en el ámbito de las organizaciones multilaterales.
- Categories: Empresas (primary), Modelos
- Region and country codes: Global (`GLOBAL`), `US`
- Map coordinates: `(20, 0)`
- Source: The Verge AI, [original article](https://www.theverge.com/ai-artificial-intelligence/1001178/openai-agents-bruteforce-un-website)
- Importance: 49.3; Critic: `pass`

No full source article text is reproduced in the report.

## LOCAL FRONTEND QA

`npm run build` succeeded, then the production build was served with `npm run start` at `http://localhost:3000`. The local home page showed the real article in the hero and latest section; the map showed one located story and an accessible story link to the article route. The article route rendered the headline, summary, “Por qué importa”, article body, primary category, region, and original-source link. The public contract includes both categories; the article header intentionally displays the primary category.

The published record maps to location ID `20.00000,0.00000`; the map canvas constructs GeoJSON coordinates as `[longitude, latitude]`, yielding `[0, 20]`. The side-panel story link targets the verified article route. The map canvas point itself was not pointer-clicked; its public coordinates and transformation were verified. Browser review used its default viewport; no separate mobile viewport interaction was performed.

## CAPACITY FINAL

For UTC date `2026-09-29`, the canonical reservation ledger contains one dispatched Groq request settled to 2,822 tokens, with 0 unknown dispatched reservations. Soft remaining capacity was 849 requests and 167,178 tokens. Including the prior pilot history: **7 calls and 12,703 tokens** (historical 6 calls / 9,881 tokens plus this Critic call). Cloudflare calls: 0; Cerebras calls: 0; historical Cloudflare neuron reservations were not modified.

## LIMITATIONS

- No dedicated offline atomic-RPC integration test exists. The existing publisher integration script creates and removes extra remote fixture rows, so it was not run; the authorized production RPC transaction and its public/canonical readbacks passed for this event.
- The browser check used its default viewport and verified the map story link and article route; it did not perform a separate mobile-size pass or a pointer click on the map point.
- Publisher intentionally did not create aggregate activity-history rows during publication.

## NEXT STEP

12A.2 is complete. Keep the canonical event, article, source/category/entity relationships, attempt, agent run, and Groq accounting. Do not deploy; Netlify remains parked until October 8.
