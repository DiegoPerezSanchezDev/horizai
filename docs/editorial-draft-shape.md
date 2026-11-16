# EditorialDraft: forma y correspondencia

Este documento refleja directamente `editorialDraftSchema` en `lib/agents/contracts/index.ts`. No es un contrato paralelo ni relaja la validación. El propietario es `editor-v1`.

## Campos top-level

| Campo | Tipo exacto | Required | Nullable | Restricciones |
| --- | --- | --- | --- | --- |
| `schemaVersion` | literal `1` | Sí | No | Solo `1` |
| `eventKey` | string | Sí | No | trim, 1–200 caracteres |
| `headlineEs` | string | Sí | No | trim, 10–160 caracteres; no `!!` ni `??` |
| `dekEs` | string | Sí | No | trim, 10–360 caracteres; no `!!` ni `??` |
| `summaryEs` | string | Sí | No | trim, 30–800 caracteres; no `!!` ni `??` |
| `whyItMattersEs` | string | Sí | No | trim, 30–1.200 caracteres; no `!!` ni `??` |
| `bodyEs` | string | Sí | No | trim, 100–50.000 caracteres; no `!!` ni `??` |
| `keyPoints` | array de strings | Sí | No | 1–8 elementos; cada uno trim, 10–280 caracteres; no `!!` ni `??` |
| `suggestedSlug` | string | Sí | No | trim, 3–120; solo `a-z`, `0-9` y guiones simples |

El objeto top-level es `.strict()`: no admite claves adicionales. No hay campos nullable en `EditorialDraft`.

## Forma del input

`EditorInput` es un contrato interno estricto y mínimo para ejecutar el agente:

- `event`: solo `eventKey` y `canonicalTitle`.
- `verification`: status, confidenceScore, verifiedFacts, uncertainClaims y contradictions.
- `translation`: translatedTitle, translatedFacts, translatedSourceMaterial mínimo, preservedNames y translationNotes.
- `sources`: `sourceId`, `sourceName`, `canonicalUrl` y `sourceType`.

No incluye HTML, OpenGraph, JSON-LD, hashes, metadata interna ni el artículo fuente completo. `VerificationResult` es la autoridad factual; la traducción solo aporta material lingüístico.

## Ejemplo canónico

`canonicalEditorialDraft` en `lib/agents/editor/editor-fixtures.ts` pasa `editorialDraftSchema.parse(...)` y se usa también para generar el ejemplo estructural del prompt.

## Validación y guard editorial

La salida sigue el flujo `JSON.parse → EditorialDraftSchema → guard determinista`. El guard comprueba correspondencia de `eventKey`, titular no idéntico al título canónico, URLs no inventadas, tokens numéricos/fechas presentes en el material permitido, preservación de nombres y ausencia de reproducción literal del material traducido cuando es suficientemente largo. No intenta resolver semántica compleja: esa revisión corresponde al futuro Critic.

## Versionado

La versión actual es `schemaVersion: 1`. Los cambios incompatibles deberán crear `editorialDraftV2Schema`, mantener la versión anterior para históricos y actualizar explícitamente el agente (`editor-v2`).
