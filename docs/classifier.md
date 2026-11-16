# Classifier + Geo Resolver — Fase 9G

## Alcance

`classifier-v1` asigna semántica estructurada a un evento ya verificado, traducido y editado. No verifica, traduce, redacta, rankea ni publica. No se conecta a la UI y no realiza búsquedas externas.

El contrato público existente es `ClassificationResult` en `lib/agents/contracts/index.ts`:

| Campo | Forma exacta | Origen |
| --- | --- | --- |
| `schemaVersion` | literal `1` | ensamblaje determinista |
| `eventKey` | string, 1–200 | input confiable |
| `primaryRegionCode` | código de región o `null` | decisión semántica validada contra registry |
| `countryCodes` | array de códigos `A-Z{2}`, únicos, máximo 100 | decisión semántica + validación ISO |
| `categorySlugs` | strings únicos, máximo 30 en el contrato; Classifier limita a 3 | decisión semántica + registry activo |
| `companies` | strings normalizados, máximo 100 | decisión semántica + normalizador |
| `models` | strings normalizados, máximo 100 | decisión semántica + normalizador |
| `people` | strings normalizados, máximo 100 | decisión semántica + normalizador |
| `technologies` | strings normalizados, máximo 100 | decisión semántica + normalizador |
| `latitude` / `longitude` | coordenadas válidas o ambos `null` | exclusivamente Geo Resolver |

El contrato no tiene arrays públicos separados para `organizations`, `products` u `other`; no se han inventado campos paralelos.

## Input builder

`buildClassifierModelInput` envía solo:

- evento: `eventKey` y `canonicalTitle`;
- verificación: estado, score, hechos, claims inciertos y contradicciones;
- traducción: título, hechos traducidos y nombres preservados;
- editorial: titular, resumen y puntos clave;
- metadata no secreta de fuentes: nombre, tipo y país;
- códigos activos de regiones y slugs activos de categorías para acotar decisiones.

No envía HTML, artículo fuente, `bodyEs`, OpenGraph, JSON-LD, hashes, metadata de debugging, reasoning ni prompts anteriores.

## Payload generado por el LLM

El modelo devuelve únicamente `ClassifierGeneration`:

```json
{
  "primaryRegionCode": "US",
  "countryCodes": ["US"],
  "categorySlugs": ["modelos"],
  "companies": ["OpenAI"],
  "models": ["GPT-5"],
  "people": [],
  "technologies": []
}
```

El schema interno es estricto y no admite `schemaVersion`, `eventKey`, IDs, UUIDs, latitud, longitud, coordenadas ni campos adicionales. Zod se ejecuta antes del ensamblaje final.

## Ensamblaje determinista

HorizAI conserva `eventKey` y añade `schemaVersion`. Las categorías y regiones se validan contra registros activos leídos de Supabase; el modelo no copia IDs de base de datos. Los países se validan contra un registro ISO alpha-2. Las entidades pasan por normalización exacta de aliases conocidos y deduplicación por tipo; entidades con el mismo texto en tipos distintos no se fusionan.

El `Geo Resolver` recibe el país/región ya validado y el registry de regiones. Devuelve internamente `resolutionLevel` (`global`, `region`, `country` o `unresolved`) y `resolvedFrom`. Solo sus coordenadas pasan a `ClassificationResult`. Si no hay correspondencia determinista, ambos campos quedan `null`; el modelo nunca puede rellenarlos.

Reglas principales:

- un país con región específica registrada prevalece sobre su región padre;
- una región sin país se resuelve a nivel `region`;
- `GLOBAL` se acepta solo como decisión del Classifier para alcance realmente multinacional, no por la mera internacionalidad de una empresa;
- una empresa estadounidense con un evento francés conserva `FR`/`EUROPE`, no `US` por su origen corporativo;
- coordenadas de país son centroides de registry y no ubicación exacta de ciudad o acontecimiento.

## Registry

En producción, `loadActiveReferenceRegistry` lee `regions` y `categories` activas de Supabase. Las coordenadas canónicas son las de `supabase/migrations/20260912000001_seed_reference_data.sql`; no se duplica otro dataset de producción. Los tests usan un registry en memoria equivalente.

## Checkpoint y replay

`artifacts/pipeline-editor-checkpoint.json` se prepara después de Editor SUCCESS y antes de Classifier. Contiene `eventKey`, título canónico, `VerificationResult`, `TranslationResult`, `EditorialDraft` y metadata mínima de fuentes. El lector seguro rechaza HTML, raw content, secretos, prompts y reasoning. `npm run classifier:replay-test` permite reproducir Classifier sin volver a ejecutar Verifier, Translator o Editor. En SUCCESS, el replay conserva ahora un reporte sanitizado y escribe atómicamente `artifacts/pipeline-classifier-checkpoint.json` después de Classifier + Geo Resolver, para permitir el futuro Ranker sin repetir etapas anteriores.

## Observabilidad y reportes

Classifier usa el `AgentTelemetry` común del runtime. El reporte conserva regiones, países, categorías, entidades, nivel geo y coordenadas únicamente cuando provienen del resolver. `artifacts/classifier-provider-report.json` está inicializado como `not_run` para pruebas aisladas; los replays SUCCESS escriben también un reporte sanitizado de ejecución.

## Evolución posterior

Los cambios incompatibles deben crear una versión nueva del contrato y del agente (`classifier-v2`), manteniendo la interpretación de ejecuciones históricas. No se han creado migraciones en Fase 9G.
