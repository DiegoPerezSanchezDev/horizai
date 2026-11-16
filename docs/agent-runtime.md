# Agent Runtime

HorizAI ejecuta los agentes mediante un runtime común en `lib/agents/runtime/`. El runtime recibe instrucciones de sistema, una entrada tipada, el schema Zod y una configuración de modelo; el proveedor devuelve un objeto que se valida de nuevo con Zod antes de entregarlo al agente.

La infraestructura provider-scoped y la política offline se describen en [`free-provider-strategy.md`](free-provider-strategy.md). El router sigue desactivado en producción. Las cuotas de Groq y Cloudflare se contabilizan por separado y en unidades distintas; el pipeline programado actual admite eventos únicamente contra el presupuesto Groq.

El runtime proporciona:

- `ModelProvider`: interfaz desacoplada del proveedor concreto.
- `parseStructuredOutput`: rechazo de JSON, enums, URLs, fechas o scores inválidos mediante el schema correspondiente.
- timeout por llamada y como máximo dos reintentos para timeout, salida estructural inválida o error temporal.
- guard de coste común con reservas locales separadas por proveedor, máximo de 1.200 tokens de salida, sin fallback de proveedor/modelo y fallo inmediato ante rate limit. La reserva persistente se realiza en la unidad propia del proveedor.
- logging de intentos y resultado en `agent_runs` y `agent_logs`, sin payload periodístico completo ni secretos.
- telemetría común y simétrica para éxito y error: `providerHttpStatus`, modelo/versión, formato estructurado, reasoning configurado, `finishReason`, intentos/reintentos, latencia, tokens, tamaños de request/response, validez Zod y timestamps. Los valores que no existen se conservan como `null`.
- errores fail-closed: una excepción no produce un resultado aprobado.

### Retries y precedencia

`attempts` siempre equivale a la llamada inicial más los retries realizados. La precedencia de `maxRetries` es: override explícito de la ejecución/agente, configuración específica del agente, configuración global y, por último, el default del runtime. Un valor explícito `maxRetries: 0` es válido y significa una sola llamada total.

Los modos `strict_schema`, `best_effort_schema` y `json_object` solo determinan qué errores estructurales pueden ser retryable; nunca aumentan silenciosamente el número máximo de retries configurado. Cada attempt que llega al proveedor consume exactamente una reserva persistente de cuota. Por tanto, el peor caso del preflight se calcula con el `maxRetries` efectivo de cada agente.

El adaptador incluido usa el protocolo OpenAI-compatible configurado por entorno. No se elige un proveedor ni un modelo por código. Envía `messages`, `response_format.json_schema` y el schema generado desde Zod al endpoint `/chat/completions`; no habilita tools. El resultado se valida otra vez localmente con Zod.

## Configuración

Los nombres están en `.env.example`. Para habilitar una ejecución real deben existir `AGENT_PROVIDER`, `AGENT_API_URL`, `AGENT_API_KEY` y el modelo específico del agente, actualmente `AGENT_MODEL_VERIFY`. `AGENT_API_KEY` solo se lee en procesos server-side y nunca se registra.

Los valores operativos opcionales son `AGENT_TIMEOUT_MS`, `AGENT_MAX_RETRIES`, `AGENT_RETRY_BACKOFF_MS` y `AGENT_TEMPERATURE_VERIFY`. El hard cap de requests de Groq se resuelve en este orden: `GROQ_DAILY_REQUEST_HARD_CAP` (1–1.000), `AGENT_DAILY_REQUEST_LIMIT` como fallback legado Groq-only (1–20), y el default conservador de 20. El valor legado no restringe un cap canónico explícito y Cloudflare ignora ambos. La configuración Groq canónica también incluye `GROQ_DAILY_TOKEN_HARD_CAP`, `GROQ_REQUESTS_PER_MINUTE_HARD_CAP` y `GROQ_TOKENS_PER_MINUTE_HARD_CAP`; los soft caps se calculan con el ratio existente. `GROQ_EVENT_TOKEN_PLANNING_MARGIN_PERCENT` solo afecta la proyección de evento nuevo, nunca la reserva por etapa. El runtime reserva atómicamente request+estimación por etapa en migration 25, marca dispatch y liquida al usage real; ante usage desconocido posterior a dispatch conserva el estimado. Después de Verifier, el pacing TPM lee remaining/reset de los headers Groq persistidos para el mismo `eventKey` y falla cerrado si no hay estado confiable. `GROQ_MAX_CONCURRENT_EVENTS` debe ser como máximo 1 antes de que throughput pueda aprobarse. `AGENT_MAX_OUTPUT_TOKENS` tiene un máximo de 1.200, `AGENT_FAIL_ON_RATE_LIMIT=true` y `AGENT_ALLOW_PAID_FALLBACK=false`; el runtime limita `AGENT_MAX_RETRIES` a dos. Cloudflare consume Neurons; su límite diario de requests es opcional y no se impone uno implícito.

Cada intento contra el modelo —incluidos retries— consume exactamente una reserva del proveedor asignado. Groq se reserva mediante `reserve_provider_agent_request`; Cloudflare usa `reserve_cloudflare_neuron_capacity`, con una unidad de Neurons y un request cap solo si se configuró explícitamente. Ambos registran `provider_request_reserved` con identidad de proveedor y permanecen bajo las RPCs existentes. Las reservas antiguas sin etiqueta se cuentan conservadoramente dentro de Groq; nunca dentro de Cloudflare. Si no se puede leer o registrar la capacidad persistente del proveedor asignado, el runtime falla cerrado y no llama al modelo.

El periodo diario se define por fecha UTC (`YYYY-MM-DD`). Los guards en memoria también se particionan por proveedor y aceptan un reloj inyectable para que los tests controlen el cambio de día; en producción su valor predeterminado sigue siendo `new Date()`. La reserva local devuelve la fecha UTC calculada con ese mismo reloj y el runtime reutiliza exactamente esa fecha para la reserva persistente, evitando divergencias entre ambos guards.

Un HTTP 429 se convierte en `FREE_TIER_LIMIT_REACHED`, no se reintenta, no activa fallback y bloquea el evento; además, bloquea nuevas llamadas del mismo proceso. La cuota real de Groq sigue siendo la autoridad externa y debe monitorizarse por separado.

En `SUCCESS`, `PROVIDER_HTTP_ERROR`, `LOCAL_JSON_PARSE_ERROR`, `LOCAL_SCHEMA_VALIDATION_ERROR`, `TIMEOUT` y `FREE_TIER_LIMIT_REACHED` se persiste el mismo objeto `telemetry` dentro de `agent_runs.stats` y del log final. Nunca contiene API keys, cabeceras de autorización, prompts completos, material periodístico completo ni reasoning interno.

Los informes E2E añaden solo snapshots seguros. `artifacts/editor-report.json` conserva dimensiones, una muestra editorial limitada a `bodyPreview` de 500 caracteres y resultados QA deterministas; no conserva `bodyEs` completo ni material fuente.

## Versionado

Cada agente declara una versión, actualmente `verifier-v1`, y el runtime la guarda en `agent_runs.config` y en los logs. Un cambio incompatible debe crear `verifier-v2` (o la siguiente versión), mantener la anterior para interpretar ejecuciones históricas y registrar ambas versiones durante una migración. Los schemas de datos continúan usando `schemaVersion: 1` hasta que exista una migración explícita.
