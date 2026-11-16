# Ranker — Fase 9H

## Alcance

`ranker-v1` ordena eventos por importancia editorial. No verifica, traduce, redacta, clasifica, resuelve coordenadas ni publica. Recibe un input estructurado pequeño y produce `RankingResult` validado.

## Contrato público existente

`RankingResult` en `lib/agents/contracts/index.ts` tiene exactamente:

```text
schemaVersion: 1
eventKey: string
impact: number 0–100
novelty: number 0–100
reach: number 0–100
credibility: number 0–100
economicImpact: number 0–100
momentum: number 0–100
importanceScore: number 0–100 | null | omitted
rankReason: string
```

No se ha creado ni modificado un contrato público.

## Generación semántica interna

El LLM genera únicamente `RankerGeneration`:

```json
{
  "impact": 0,
  "novelty": 0,
  "economicImpact": 0
}
```

Los tres campos son enteros entre 0 y 100. El schema es estricto y rechaza `eventKey`, `importanceScore`, IDs, metadatos redundantes, coordenadas y cualquier campo adicional. El prompt trata todo contenido externo como datos no confiables y no habilita herramientas.

## Señales deterministas

- `credibility`: combina el estado de verificación, `confidenceScore`, número de fuentes, contradicciones y claims inciertos. La base por estado es `confirmed=88`, `developing=68`, `single_source=48`, `rumor=22`, `rejected=0`; se pondera `45%` base, `35%` confidence y `20%` corroboración (`min(100, sourceCount × 35)`). Se restan `10` por contradicción hasta `30` y `3` por claim incierto hasta `15`.
- `reach`: `min(70, countryCount × 20)` + `10` si hay una región específica distinta de `GLOBAL` + `min(15, entityCount × 2)`. `GLOBAL` no obtiene bonus automático; necesita cobertura de países.
- `momentum`: es `50` neutral con `momentumAvailable=false` cuando no existe histórico. Con `activity_history`, combina `50%` de `activityScore`, `25%` de frecuencia (`eventCount × 10 + articleCount × 5`, máximo 100) y `25%` de recencia. La recencia vale 100 hasta 24 horas y decrece hasta 0 a los 30 días.

Todas las señales se redondean a enteros y se limitan a `0–100`.

## Fórmula y guardrails

Se reutiliza `calculateImportanceScore()` con `ranking-v1`:

```text
impact          25%
novelty         15%
reach            20%
credibility     20%
economicImpact  10%
momentum        10%
```

El resultado se redondea a dos decimales. Como guardrails explícitos, un evento `rejected` limita el score final a `15` y un `rumor` a `45`; `single_source` no tiene cap duro. Las contradicciones y la incertidumbre reducen `credibility`. Estos límites son conservadores y deberán calibrarse con un dataset real, separado de la fórmula versionada.

`rankReason` se genera determinísticamente a partir de dimensiones, señales, estado y `ranking-v1`; nunca procede del LLM. El resultado final se valida otra vez con `rankingResultSchema`.

## Input y trazabilidad

El Ranker recibe evento, verificación, título/hechos traducidos, resumen editorial, `whyItMatters`, puntos clave y clasificación. No recibe HTML, artículo completo, OpenGraph, JSON-LD, debugging, prompts anteriores ni reasoning.

`ranker-v1` usa la telemetría común: provider, modelo, modo estructurado, reasoning, finish reason, intentos, retries, latencia, tokens, bytes y validez Zod. Añade validez de generación semántica, señales calculadas, score final, dimensiones, fuente count, estado de verificación, disponibilidad de momentum y `formulaVersion`. La combinación final conserva los diagnósticos del proveedor, por lo que HTTP status, finish reason y bytes no se pierden al ensamblar el resultado.

## Checkpoint

`artifacts/pipeline-classifier-checkpoint.json` se escribe atómicamente después de Classifier + Geo Resolver SUCCESS. Contiene solo la información mínima para reproducir Ranker: evento resumido, verificación, traducción mínima, editorial resumida, clasificación completa, metadata de fuentes y timestamps. Rechaza HTML, contenido bruto, secretos, prompts y reasoning.

Los comandos preparados son:

```bash
npm run ranker:provider-test
npm run ranker:replay-test
npm run ranker:test -- --hours=48 --limit=1
```

No se ejecutan en la preparación de 9H. El E2E futuro exige al menos cinco reservas diarias: Verifier, Translator, Editor, Classifier y Ranker, todos con `maxRetries=0`.

## Evolución

Los cambios incompatibles deberán crear `ranker-v2` y conservar la interpretación de históricos. La fórmula deberá versionarse como otra `formulaVersion`; no se optimizarán pesos ni thresholds hasta disponer de eventos reales revisados.
