# Pipeline boundary matrix

Este documento registra las formas reales que cruzan los adapters de producción. Los resultados públicos de cada etapa no se reutilizan automáticamente como inputs de la siguiente: cada boundary construye una proyección explícita y la valida con el schema downstream antes de reservar o despachar una llamada.

## Matriz

| Boundary | Resultado upstream | Input downstream | Estado |
| --- | --- | --- | --- |
| Verifier → Translator | `VerificationResult` | `TranslatorInput.verification` | PASS / proyección de `TranslatorInput` |
| Verifier → Editor | `VerificationResult` | `EditorInput.verification` | PASS / proyección explícita |
| Translator → Editor | `TranslationResult` | `EditorInput.translation` | PASS / proyección explícita |
| Verifier → Classifier | `VerificationResult` | `ClassifierInput.verification` | PASS / proyección explícita |
| Translator → Classifier | `TranslationResult` | `ClassifierInput.translation` | PASS / proyección explícita |
| Editor → Classifier | `EditorialDraft` | `ClassifierInput.editorial` | PASS / proyección explícita |
| Classifier → Ranker | `ClassificationResult` | `RankerInput.classification` | PASS / proyección explícita |
| Geo → Ranker | `GeoStageOutput` | — | PASS / no aplica: `RankerInput` no admite geo; no se inyectan coordenadas |
| Verifier → Ranker | `VerificationResult` | `RankerInput.verification` | PASS / proyección explícita |
| Translator → Ranker | `TranslationResult` | `RankerInput.translation` | PASS / proyección explícita |
| Editor → Ranker | `EditorialDraft` | `RankerInput.editorial` | PASS / proyección explícita |
| Upstream → Critic | resultados validados | `CriticInput` | PASS / builder estricto; traducción, editorial, clasificación y verificación tienen las formas públicas admitidas |
| Critic/Ranker → Critic | `CriticResult`, `RankingResult` | `CriticInput.ranking` y resultado posterior | PASS / ranking checkpoint validado |
| Upstream → Publisher | `PublicationPayload` y lineage | `PublisherInput` | PASS / payload parseado antes de Publisher; Publisher vuelve a validar |

## Proyecciones críticas

### Editor

`EditorInput.translation` admite exactamente:

```text
translatedTitle
translatedFacts
translatedSourceMaterial
preservedNames
translationNotes
```

`EditorInput.verification` admite exactamente:

```text
status
confidenceScore
verifiedFacts
uncertainClaims
contradictions
```

### Classifier

`ClassifierInput.verification` admite exactamente los cinco campos anteriores.

`ClassifierInput.translation` admite `translatedTitle`, `translatedFacts` sin `sourceItemId` y `preservedNames`.

`ClassifierInput.editorial` admite únicamente `headlineEs`, `summaryEs` y `keyPoints`.

### Ranker

`RankerInput` recibe proyecciones separadas de verificación, traducción, editorial y clasificación. El resultado Geo no se pasa al Ranker porque su schema no lo admite; Geo se conserva como etapa determinista y se incorpora al input del Critic.

### Critic y Publisher

El Critic recibe un `CriticInput` completo validado. Su input de modelo vuelve a proyectar los campos necesarios y limita el cuerpo editorial según su propia política.

Publisher recibe un `PublicationPayload` validado, un lineage explícito por `eventKey` y el contexto de trazabilidad necesario para volver a validar nombres, fuentes y material traducido. En `dryRun`, no ejecuta escrituras.

## Validación

La regresión está cubierta por:

```bash
npm run pipeline:boundaries:unit
npm run pipeline:wiring:unit
```

Los tests usan resultados públicos completos y comprueban `Object.keys` de las subformas críticas para evitar que un spread indiscriminado reintroduzca el fallo.

No se modifican prompts, contratos públicos, scoring, geo, routing, RLS ni publicación real.
