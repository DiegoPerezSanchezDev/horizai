# Translator Agent — Fase 9E

## Alcance

`translator-v1` convierte a español internacional el material estructurado ya verificado. Recibe un `ClusteredEvent`, el `VerificationResult` y metadata mínima de sus fuentes. No recibe automáticamente los artículos completos: el input contiene el título canónico, claims, contradicciones y trazabilidad necesaria para preparar una futura síntesis original.

El Translator no redacta, no clasifica, no puntúa, no corrige hechos y no cambia el estado del Verifier. Un evento `rejected` no puede avanzar.

## Contrato y fidelidad

La salida pública sigue siendo exclusivamente el `TranslationResult` existente. Internamente, el proveedor genera solo un `TranslatorGeneration` mínimo y lo valida con Zod: `translatedTitle`, `factTranslations` (cada elemento contiene únicamente `factIndex` y `translatedText`), `translatedSourceMaterial`, `preservedNames` y `translationNotes`. Después, código confiable reconstruye y valida el `TranslationResult` final. `sourceText`, `sourceItemId`, `schemaVersion`, `eventKey`, `sourceLanguage` y `targetLanguage` nunca los decide el modelo.

El ensamblaje exige correspondencia exacta 1:1 entre `factTranslations` y `verification.verifiedFacts`: todos los índices deben existir, ser únicos y cubrir la secuencia completa. El texto fuente se copia exactamente desde el claim validado y `sourceItemId` se resuelve desde la metadata de fuentes. Si falla la generación o el ensamblaje, el evento queda bloqueado.

`translatedSourceMaterial` continúa siendo material breve de trabajo generado por el modelo, no una reproducción del artículo fuente. Incluye solo el contexto lingüístico compacto que el Editor pueda necesitar además de los hechos estructurados.

Se preservan nombres, modelos, versiones, cifras, fechas, monedas, unidades y siglas. Expresiones como `may`, `could`, `reportedly` y `according to` no pueden aumentar su certeza. Las contradicciones se incluyen como material traducible y no se resuelven.

## Runtime y presupuesto

El agente reutiliza el runtime común: structured output, validación Zod doble, timeout, máximo de dos retries, logging, reserva persistente y fail-closed. El modelo se lee de `AGENT_MODEL_TRANSLATE`; el proveedor sigue siendo el configurado por `AGENT_PROVIDER`. No existe fallback. El razonamiento del Translator se controla con `AGENT_REASONING_EFFORT_TRANSLATE` y `AGENT_INCLUDE_REASONING_TRANSLATE`; para Groq se configura `low` y `false` sin guardar reasoning.

La telemetría distingue `generationSchemaValid`, `finalTranslationResultValid`, `translationAssemblySuccess`, bytes de la generación, el conteo esperado/generado y los índices esperados/recibidos. Si la generación es estructuralmente inválida, también conserva de forma acotada los caracteres de `translatedSourceMaterial` y los `invalidPaths`, sin guardar el texto completo. Antes de llamar a Translator, el pipeline escribe atómicamente `artifacts/pipeline-verifier-checkpoint.json`, lo lee y valida, y comprueba que sus identificadores y número de hechos coincidan con el Verifier actual. El checkpoint contiene solo metadata, claims verificados y el input limitado del Translator; no contiene HTML, artículos completos, secretos ni reasoning. `translator:replay-test` está preparado para depurar ese checkpoint con `maxRetries=0`, pero no forma parte del pipeline normal.

Translator exige además `verifiedFacts.length >= 1` localmente. Con cero hechos devuelve `translator_precondition_failed` y no crea `agent_run`, no reserva cuota y no llama al proveedor. `translatedSourceMaterial` sigue siendo necesario porque el Editor lo consume como contexto lingüístico compacto adicional a `translatedTitle`, `translatedFacts` y `VerificationResult`; no sustituye los hechos ni añade trazabilidad. En el futuro podría simplificarse si los consumidores dejan de necesitar ese contexto, pero esa decisión requeriría una nueva versión de contrato.

El comando `translator:test` hace un preflight antes de Discovery/Extraction/Clustering: consulta el ledger diario y exige al menos dos reservas disponibles, una para Verifier y otra para Translator. Cada retry reserva otra request individualmente; si la cuota se agota, el evento no avanza.

```bash
npm run translator:unit
npm run translator:test -- --hours=48 --limit=1
```

El modo es dry-run y escribe únicamente `artifacts/translator-report.json`; no crea artículos ni conecta la UI.

## Versionado

La versión actual es `translator-v1`. Un cambio incompatible debe crear `translator-v2` y conservar la versión anterior para reproducir ejecuciones históricas. `schemaVersion` del contrato permanece en `1` mientras no cambie la forma del payload.
