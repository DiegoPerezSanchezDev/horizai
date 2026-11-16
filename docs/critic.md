# Critic — Fase 9I

## Alcance

`critic-v3` audita la consistencia entre Verification, Translation, Editorial, Classification + Geo y Ranking antes de publicar. No traduce, no reescribe, no clasifica, no recalcula la semántica del ranking y no publica. Puede devolver una ruta `revise_*`, pero en esta fase no existe ningún loop automático de revisión.

## Contrato público existente

Critic reutiliza exactamente `criticResultSchema` de `lib/agents/contracts/index.ts`:

```text
schemaVersion: 1
eventKey: string
decision: pass | revise_verification | revise_translation | revise_editorial |
          revise_classification | revise_ranking | reject
issues: [{ code, field: string | null, severity, message }]
unsupportedClaims: [{ claim, reason, sourceIds: UUID[] }]
severity: low | medium | high | critical
notes: string
```

El modelo no genera este payload público directamente. Genera únicamente `CriticGeneration` v3, un schema interno estricto con una sola lista `findings` y una unión discriminada:

```text
issue:             kind, dimension, stage, severity, message, evidenceIndices
unsupported_claim: kind, claim, reason, stage, severity, evidenceIndices
```

No se permite mezclar campos entre variantes ni añadir campos desconocidos. Código confiable añade `schemaVersion`, `eventKey`, IDs y la decisión final.

## Flujo

```text
validated pipeline outputs
        ↓
deterministic prechecks
        ↓ (solo si pasan)
CriticGeneration v3: JSON.parse → Zod
        ↓
evidence indices bounds validation → canonical refs in trusted code
        ↓
deterministic routing → CriticResultSchema
```

El Critic recibe solo claims de Verification, material estructurado de Translation, el `bodyEs` editorial (con límite de 20.000 caracteres), clasificación, señales del ranking y metadata mínima de fuentes. No recibe HTML, `raw_content`, OpenGraph, JSON-LD, prompts, reasoning, secretos ni el artículo fuente completo. El cuerpo editorial sí se incluye porque es el lugar donde pueden aparecer afirmaciones nuevas o una síntesis infiel; su límite queda registrado en las métricas.

## Prechecks autoritativos

`critic-prechecks.ts` comprueba sin LLM:

- schemas y lineage/eventKey de todas las etapas;
- referencias a fuentes existentes;
- cobertura 1:1 de `translatedFacts` sobre `verifiedFacts`;
- guard editorial determinista;
- región y categorías contra el registry activo;
- coordenadas iguales a las del Geo Resolver y con procedencia de registry;
- `verifiedFacts > 0` para poder llegar a Critic;
- `ranking-v1`, señales deterministas y recomputación exacta de `importanceScore`;
- estado upstream `rejected`.

Un fallo de precheck no se envía al modelo. El resultado se enruta determinísticamente; un estado upstream `rejected` se convierte en `reject`, y los restantes fallos se dirigen a la primera etapa contaminante.

## Dimensiones semánticas

`FACTUAL_ACCURACY`, `FACTUAL_PRECISION`, `TRANSLATION_FIDELITY`, `UNCERTAINTY_PRESERVED`, `NO_ADDED_FACTS`, `NO_HALLUCINATIONS`, `HEADLINE_ACCURACY`, `DEK_ACCURACY`, `WHY_IT_MATTERS_SUPPORT`, `COPYRIGHT_SCOPE`, `CATEGORY_ACCURACY`, `REGION_ACCURACY`, `COUNTRY_ACCURACY`, `ENTITY_ACCURACY`, `RANKING_REASONABLENESS`, `CREDIBILITY_CONSISTENCY` y `SOURCE_TRACEABILITY`.

La escala pública existente es `low`, `medium`, `high`, `critical`. `low` y `medium` son advertencias no bloqueantes; `high` y `critical` bloquean y se enrutan. Un warning aislado, por tanto, produce `pass`.

## Routing y precedencia

`critic-routing-v1` elige la etapa bloqueante más temprana:

```text
verification → translation → editorial → classification → ranking
```

La precedencia evita corregir una consecuencia cuando la causa factual es anterior. Así, un problema de Verification y otro Editorial produce `revise_verification`. `reject` queda reservado para `VerificationResult.status = rejected` (y futuras condiciones explícitas de contenido irrecuperable); no es un cajón de sastre ni se activa por warnings.

Las decisiones no proceden del LLM. Antes de llamar al modelo se construye un catálogo determinista con orden fijo: fuentes, hechos verificados, claims inciertos, contradicciones, hechos traducidos, campos editoriales, clasificación y ranking. El modelo recibe solo `evidenceIndex`, tipo y preview corto; nunca recibe `canonicalRef` y nunca genera strings como `verifiedFact:0` o `editor:body`. Un índice fuera de rango o duplicado provoca fail-closed. Código confiable resuelve los índices a refs canónicas y valida su existencia. Los `issue` pasan a `CriticResult.issues`; los `unsupported_claim` pasan a `CriticResult.unsupportedClaims` y además producen una señal de issue derivada en código confiable para que el router pueda bloquear la etapa. No hay una segunda generación ni duplicación semántica.

## Versionado y ejecución

La versión actual del agente es `critic-v3` y el routing sigue siendo `critic-routing-v1`. `critic-v2` queda como versión histórica del shape que pedía `evidenceRefs`; el cambio incompatible se identifica explícitamente con `critic-v3`. El contrato público conserva `schemaVersion: 1`, porque no ha cambiado. Las ejecuciones registran la versión efectiva en `agent_runs`/`agent_logs`.

Los comandos preparados, pero no ejecutados en Fase 9I, son:

```bash
npm run critic:provider-test
npm run critic:replay-test
npm run critic:test -- --hours=48 --limit=1
```

`critic:replay-test` lee `artifacts/pipeline-ranker-checkpoint.json`, aplica prechecks y después Critic con `maxRetries=0`. `critic:provider-test` usa un fixture local y también queda en `maxRetries=0`, `maxAttempts=1` en la configuración de prueba. El checkpoint se escribe atómicamente mediante `writeRankerPipelineCheckpointAtomic` después de un Ranker SUCCESS; solo contiene las salidas necesarias para reproducir Critic y nunca material bruto o secretos.

## Observabilidad y coste

Critic usa el runtime común, `agent_runs`/`agent_logs`, structured output `json_object`, validación Zod posterior, timeout, guard diario y fail-closed. Registra la telemetría común y añade prechecks, tamaño del catálogo, índices recibidos/válidos, refs resueltas, índices inventados, `findingsCount`, `issueFindingsCount`, `unsupportedClaimFindingsCount`, validación del resultado público, etapa enrutada, decisión final, versión de routing y validación de evidencias. No guarda reasoning. El E2E futuro requiere seis reservas como máximo —Verifier, Translator, Editor, Classifier, Ranker y Critic— y no se ejecuta en esta fase.
