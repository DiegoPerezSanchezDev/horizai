# Adaptador de Gemini (Google AI Studio, capa gratuita) — fase offline

Estado: **implementado y probado solo con un servidor simulado; desactivado por defecto; no conectado al pipeline de producción**. Sin `GEMINI_PROVIDER_ENABLED=true` y `GEMINI_FREE_TIER_PROJECT_CONFIRMED=true` nada de Gemini se ejecuta y el comportamiento con Groq no cambia.

## Qué se verificó en la documentación oficial (leída el 2026-11-07)

- **Endpoint compatible con OpenAI: existe** (`https://generativelanguage.googleapis.com/v1beta/openai/`, `/docs/openai`) y soporta `response_format` con esquema. No se usa: el mapeo de `reasoning_effort` y el significado de `usage` son opacos, y el límite se contabiliza mejor con `usageMetadata` nativo (incluye `thoughtsTokenCount`).
- **API nativa `generateContent`** (`POST …/v1beta/models/{model}:generateContent`, cabecera `x-goog-api-key`): `/docs/structured-output` la marca como API *legacy pero soportada*; la API por defecto es ahora Interactions. Se eligió `generateContent` por estabilidad y por tener la forma REST documentada.
- **Salida estructurada**: la página dice «`response_json_schema` (o `responseFormat.text.schema` en REST)» y el ejemplo REST usa `generationConfig.responseFormat.text = { mimeType: "APPLICATION_JSON", schema }`. Los ejemplos de SDK usan `responseMimeType` + `responseJsonSchema`. **No está verificado en vivo cuál acepta el servidor**: por eso el adaptador implementa ambas (`GEMINI_STRUCTURED_FORMAT=response_format` por defecto | `response_json_schema`).
- **Subconjunto de JSON Schema**: `type` (también array con `"null"`), `properties`, `required`, `additionalProperties`, `items`, `enum`, `anyOf`, `title`, `description`, `minItems/maxItems`, `minimum/maximum`, `prefixItems`, `format` (solo date/date-time/time). `minLength`, `maxLength`, `minProperties`, `maxProperties`, `uniqueItems`, `contains` se ignoran en el servidor. `const`, `oneOf`, `allOf` y `$ref` no figuran. Esquemas demasiado complejos devuelven `400 INVALID_ARGUMENT`.
- **Límites**: `/docs/rate-limits` **no publica cifras de la capa gratuita**; remite al panel de AI Studio (con login). Se confirma: se miden RPM, TPM (entrada) y RPD; límites **por proyecto, no por clave**; RPD se reinicia a **medianoche hora del Pacífico**; hay límites por modelo y los modelos preview/experimentales son más restrictivos.
- **Gratuidad** (`/docs/pricing`): los modelos de texto de la lista cerrada figuran «Free of charge» en entrada y salida en el nivel gratuito. Gemini 4 Argon, `*-pro-preview`, imagen, TTS, Live, Omni y embeddings quedan fuera. **En la capa gratuita el contenido se usa para mejorar los productos de Google** (columna «Used to improve our products: Yes»): no enviar nada que no pueda ser público.
- **La gratuidad depende del proyecto de Google Cloud de la clave**: si tiene facturación activa, el uso es de pago. El código no puede comprobarlo; de ahí la variable de atestación explícita.

## Diseño (mínimo)

| Pieza | Archivo | Función |
|---|---|---|
| Política | `lib/agents/runtime/gemini-policy.ts` | Lista cerrada de modelos, activación doble, endpoint exacto. `gemini_free` **no** entra en `freeProviderPolicy`/`FreeProviderId`/router: `assertFreeProviderRequest("gemini_free", …)` sigue lanzando `PaidProviderForbiddenError`. |
| Esquemas | `gemini-schema.ts` | Zod → esquema estricto existente (sin `pattern/format/min/max`) → subconjunto Gemini (`const`→`enum`, `oneOf`→`anyOf`, nullable → `type:[x,"null"]`, uniones de literales → un `enum`) + validación final del subconjunto. Falla cerrado ante `allOf` múltiple, `$ref`, opcionales. |
| Capacidad | `gemini-capacity.ts` | Contabilidad local RPM/RPD/TPM/TPD (ventana móvil de 60 s, día del Pacífico), reserva → liquidación con `usageMetadata`, bloqueo tras 429, ledger JSON opcional (ilegible ⇒ falla cerrado). |
| Adaptador | `gemini-provider.ts` | `GeminiModelProvider` (`providerId = "gemini_free"`), reserva local antes de despachar, 429 ⇒ `FreeTierLimitReachedError` + bloqueo, sin reintentos ni fallback, clave redactada en errores. |
| Evento | `gemini-event-session.ts` | `GeminiEventSession`: admite el evento completo (bloqueo + límites diarios) antes de empezar, fija proveedor+modelo, tope de peticiones por evento (6), y tras un 429/capacidad detiene el resto de etapas (no hay router ni fallback a mitad de evento). |
| Integración | `agent-runner.ts`, `model-provider.ts` | Rama `gemini_free` en el runner (no llama a las RPC de reserva de Groq/Cloudflare ni al presupuesto global); `AGENT_PROVIDER=gemini_free` en `createConfiguredModelProvider` (solo si pasa las puertas). |

## Variables de entorno

| Variable | Significado | Defecto |
|---|---|---|
| `GEMINI_PROVIDER_ENABLED` | Puerta 1. Solo `true` activa el adaptador; cualquier valor ambiguo falla cerrado. | vacío = inactivo |
| `GEMINI_FREE_TIER_PROJECT_CONFIRMED` | Puerta 2. Atestación del operador de que la clave pertenece a un proyecto **sin facturación**. | vacío = inactivo |
| `GEMINI_API_KEY` | Clave de AI Studio. Se envía solo en `x-goog-api-key`. | — |
| `GEMINI_MODEL` | Modelo a usar; debe estar en la lista cerrada. Sin valor por defecto. | — |
| `GEMINI_APPROVED_MODELS` | Lista (coma) que **reduce** la lista cerrada; no puede ampliarla. | lista cerrada completa |
| `GEMINI_LIMIT_RPM/RPD/TPM/TPD` | Límites locales. Máximos de cordura: 1000 / 10 000 / 1 000 000 / 10 000 000; TPM ≤ TPD y RPM ≤ RPD. | 2 / 20 / 6 000 / 40 000 |
| `GEMINI_USAGE_LEDGER_PATH` | Ledger JSON local (un solo proceso). Sin él, la contabilidad es solo en memoria. | memoria |
| `GEMINI_PACING_MAX_WAIT_MS` | Espera máxima (0–90 000) a que se libere la ventana móvil de RPM/TPM antes de despachar. Nunca espera límites diarios ni 429. Mantener 0 en ejecuciones supervisadas. | 0 |
| `GEMINI_STRUCTURED_FORMAT` | `response_format` (REST documentado) o `response_json_schema` (SDK). | `response_format` |
| `GEMINI_THINKING_LEVEL` / `GEMINI_THINKING_BUDGET` | Opcionales y excluyentes (`thinkingConfig`). `AGENT_REASONING_EFFORT_*` se ignora con Gemini. | modelo por defecto |

Si se usa `AGENT_PROVIDER=gemini_free`, los `AGENT_MODEL_*` de todas las etapas deben ser igual a `GEMINI_MODEL`; cualquier otro modelo se bloquea antes de despachar.

## Por qué los límites por defecto son tan bajos

Las cifras oficiales no están verificadas y el uso hecho fuera de este proceso no se ve. 2 RPM / 20 RPD / 6 000 TPM / 40 000 TPD son deliberadamente arbitrarios y bajos (no proceden de ninguna cifra oficial) y encajan con el tope supervisado actual (5 candidatas, un evento de 6 peticiones). Súbelos solo tras leer los límites reales en el panel de AI Studio.

## Siguiente paso, no hecho: `scripts/supervised-pipeline-run.ts`

La comprobación de la línea `preflight.provider.toLowerCase() !== "groq"` (`SUPERVISED_REQUIRES_GROQ_PRIMARY_PROVIDER`) **no se ha tocado**. Para que una ejecución supervisada use Gemini habría que, en este orden:

1. **Migración Supabase** (no hecha): ampliar `agent_runs_provider_check` y `agent_logs_provider_check` con `gemini_free`, y el filtro `ar.provider not in (...)` de la puerta de revisión humana (`20261005194000_supervised_human_review_gate.sql`); crear el ledger duradero de Gemini (reserva/liquidación/marca de despacho, día del Pacífico) y un lector `getProviderDailyUsage` para él. Hoy `SupabaseAgentLogger.startRun` guarda `provider = NULL` para proveedores desconocidos y `reserveRequest` lanza «Provider-scoped capacity reservation is required»; por eso el runner no usa esa ruta con Gemini.
2. **`create-production-pipeline.ts`**: `ProductionPreflight.quotaProvider` es `"groq"`, el cuota persistente (`createPersistentPipelineQuota`) y la validación de telemetría de revisión del crítico (`["groq","cerebras","cloudflare_workers_ai"].includes(telemetry.provider)`) son específicos de Groq; hay que añadir `gemini_free` con unidad `tokens` liquidada. Idem lectores del planificador (`provider-capacity-reader.ts`, `scheduler-*`).
3. **En `supervised-pipeline-run.ts`**: sustituir la igualdad estricta por una allowlist `["groq", "gemini_free"]` **y** exigir, solo para `gemini_free`, que el proveedor sea un `GeminiModelProvider`/`GeminiEventSession`, `GEMINI_PACING_MAX_WAIT_MS=0`, ledger duradero configurado, y que los topes supervisados (5 candidatas, 36 peticiones) se apliquen también a Gemini (el runner no usa `ProviderScopedDailyRequestBudget` para Gemini; hoy solo lo limita el RPD local).
4. Por qué es seguro: el valor `gemini_free` solo puede aparecer si `AGENT_PROVIDER=gemini_free` **y** pasan las dos puertas de activación y la lista cerrada de modelos; las otras comprobaciones (reintentos cero, sin fallback de pago, sin espera in-run) se mantienen intactas; el modo supervisado ya no admite un proveedor «cualquiera», solo uno de dos con política cerrada y contabilidad propia.
5. Antes de activarlo de verdad: hasta **3 llamadas reales** de validación con una `GEMINI_API_KEY` de un proyecto sin facturación para confirmar (a) cuál de las dos formas de salida estructurada acepta el servidor, (b) que el esquema convertido de los seis agentes no da `400 INVALID_ARGUMENT` por complejidad, (c) el formato real del cuerpo de un 429 (`QuotaFailure`/`RetryInfo`) y las cifras reales del panel.

## Pruebas

`npm run provider:gemini:unit` — servidor simulado, sin red ni secretos: política y puertas, conversión de esquemas (incluidos los seis esquemas reales de agentes), JSON válido, 429 (diario y por minuto), límites locales, ledger en archivo, sesión de evento y paso por `runStructuredAgent`.
