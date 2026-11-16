# Observabilidad de agentes

El runtime común persiste un objeto `telemetry` tanto para ejecuciones exitosas como para fallos. Su forma está definida por `AgentTelemetry` y validada por `agentTelemetrySchema`.

Incluye status de ejecución, status HTTP del proveedor si existe, modelo y versión del agente, modo de structured output, configuración de reasoning, `finishReason`, intentos, retries, latencia, uso de tokens, tamaños de request/response, validez Zod y timestamps. Un dato que no existe en el proveedor o en el fallo se representa como `null`; no se infieren valores.

Los destinos son:

- `agent_runs.stats.telemetry`: resumen persistente de la ejecución.
- log `completed` o `failed` en `agent_logs`: mismo resumen y detalles diagnósticos acotados.

La telemetría no contiene API keys, cabeceras de autorización, prompts completos, reasoning interno ni contenido periodístico completo.

## Informes E2E seguros

`artifacts/editor-report.json` conserva metadata de trazabilidad, dimensiones de longitud, una muestra editorial (`headlineEs`, `dekEs`, `whyItMattersEs`, `keyPoints` y un `bodyPreview` de como máximo 500 caracteres) y QA determinista. No incluye el cuerpo completo ni el material fuente.

El informe del Verifier conserva conteos (`verifiedFactsCount`, `uncertainClaimsCount`, `contradictionsCount`) y `reasonChars`, no el texto completo de esas salidas. El informe del Translator conserva los indicadores de validación de generación y ensamblado, además de sus conteos y longitudes.

## Backlog de calibración

Una ejecución `single_source` con `confidenceScore` muy alto debe revisarse con una muestra mayor. No se aplica todavía ningún cap, normalización ni threshold adicional.
