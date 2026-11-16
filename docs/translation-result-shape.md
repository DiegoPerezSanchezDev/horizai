# TranslationResult: forma y correspondencia

Este documento refleja directamente `translationResultSchema` en `lib/agents/contracts/index.ts`. No es un contrato paralelo ni relaja la validación.

## Generación interna del Translator

El contrato público no cambia, pero el proveedor no genera todo `TranslationResult`. `translatorGenerationSchema` define el payload mínimo:

```text
TranslatorGeneration {
  translatedTitle: string
  factTranslations: [{ factIndex: integer, translatedText: string }]
  translatedSourceMaterial: string
  preservedNames: string[]
  translationNotes: string[]
}
```

`factIndex` es el índice cero-based de `verification.verifiedFacts`. El ensamblador local exige cobertura exacta 1:1 y restaura desde el input validado `schemaVersion`, `eventKey`, idiomas, `sourceText` y `sourceItemId`. Por ello una respuesta con índice duplicado, inexistente, faltante o texto vacío se rechaza; no se aplica normalización silenciosa.

## Campos top-level

| Campo | Tipo exacto | Required | Nullable | Restricciones | Prompt | Match |
| --- | --- | --- | --- | --- | --- | --- |
| `schemaVersion` | literal `1` | Sí | No | Solo `1` | Enumera la clave y el objeto de ejemplo usa `1` | Sí |
| `eventKey` | string | Sí | No | trim, 1–200 caracteres | Enumera la clave | Sí |
| `sourceLanguage` | string | Sí | No | patrón `^[a-z]{2,3}(?:-[A-Z]{2})?$` | Enumera la clave | Sí |
| `targetLanguage` | literal `"es"` | Sí | No | Solo `es` | Enumera la clave y el ejemplo usa `es` | Sí |
| `translatedTitle` | string | Sí | No | trim, 1–500 caracteres | Enumera la clave | Sí |
| `translatedFacts` | array de objetos | Sí | No | 1–100 elementos | Describe la estructura exacta | Sí |
| `translatedSourceMaterial` | string | Sí | No | trim, 1–120.000 caracteres | Describe string no vacío y mínimo material | Sí |
| `preservedNames` | array de strings | Sí | No | 0–100; cada string trim, 1–200; valores únicos | Describe array, strings únicos y `[]` | Sí |
| `translationNotes` | array de strings | Sí | No | 0–30; cada string trim, 1–500; valores únicos | Describe array, strings únicos y `[]` | Sí |

El objeto top-level es `.strict()`: no admite claves adicionales.

## Elementos anidados

`translatedFacts` usa objetos `.strict()` con exactamente:

| Campo | Tipo exacto | Required | Nullable | Restricciones |
| --- | --- | --- | --- | --- |
| `sourceText` | string | Sí | No | trim, 1–2.000 caracteres |
| `translatedText` | string | Sí | No | trim, 1–2.000 caracteres |
| `sourceItemId` | string o `null` | Sí | Sí | string trim, 1–200 caracteres cuando no es null |

Los elementos de `translatedFacts` tampoco admiten claves adicionales.

## Ejemplo canónico local

El fixture `canonicalTranslationResultFixture` se construye con esta forma y pasa `translationResultSchema.parse(...)`. Incluye un hecho traducido, `preservedNames` mínimo, `translatedSourceMaterial` mínimo y `translationNotes: []`.

## Retry estructural

En `best_effort_schema` y `json_object`, un error local de JSON/schema puede producir un único retry. El feedback solo utiliza paths, tipos esperados y campos ausentes; nunca incluye el output anterior ni valores textuales generados.
