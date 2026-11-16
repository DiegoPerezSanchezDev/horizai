# 12C.2B.2e.1 — Fresh Groq TPM capacity probe

**Estado:** completada como diagnóstico. **Capacidad:** `BLOCKED_TPM_STATE_UNKNOWN`. No se autorizó la continuación.

## WHY PROBE WAS REQUIRED

La última lectura confiable de TPM era de `2026-10-02T09:56:06.461Z`, más de diez horas antes, y su ventana de reset ya había vencido. La fase anterior detuvo la continuación porque no podía demostrar capacidad actual para la solicitud Critic V4 estimada en 6.397 tokens. Se necesitaba comprobar si el endpoint de metadatos de modelos entregaba cabeceras frescas sin ejecutar inferencia.

## ENDPOINT

- URL: `https://api.groq.com/openai/v1/models`
- Método: `GET`
- Resultado: HTTP `200`; cuerpo válido de lista con 11 modelos; `openai/gpt-oss-20b` estaba presente.
- Referencias: [Groq API Reference](https://console.groq.com/docs/api-reference) y [Groq Models](https://console.groq.com/docs/models).

## NON-INFERENCE GUARANTEE

La única solicitud a Groq fue el GET de metadatos `/openai/v1/models`. `GROQ_API_KEY` no estaba definido en el entorno; la autenticación usó `AGENT_API_KEY`, ya configurado con `AGENT_PROVIDER=groq` y el endpoint Groq. Nunca se mostró ni guardó el valor de la credencial. No hubo llamadas a chat completions, responses ni otro endpoint de inferencia. No hubo reintentos, llamadas a Cloudflare o Cerebras, autorización de continuación, despacho Critic ni escrituras Supabase.

Contadores de esta fase: `metadataApiRequests=1`, `modelInferenceCalls=0`, `inferenceTokens=0`.

## HEADERS

La respuesta incluyó `Date: Fri, 02 Oct 2026 20:19:19 GMT`. Las cabeceras de cuota permitidas no estaban presentes:

| Cabecera | Valor |
| --- | --- |
| `x-ratelimit-limit-requests` | ausente |
| `x-ratelimit-remaining-requests` | ausente |
| `x-ratelimit-reset-requests` | ausente |
| `x-ratelimit-limit-tokens` | ausente |
| `x-ratelimit-remaining-tokens` | ausente |
| `x-ratelimit-reset-tokens` | ausente |
| `retry-after` | ausente |

## FRESHNESS

La solicitud comenzó a `2026-10-02T20:19:19.359Z` y terminó a `2026-10-02T20:19:19.610Z`. La respuesta fue HTTP 200 con el `Date` indicado arriba; se usó `cache: no-store` y no se reutilizó ninguna cabecera almacenada. Por tanto, la respuesta es fresca, pero no contiene cabeceras TPM que puedan evaluarse.

## REQUEST ACCOUNTING

La consulta posterior de solo lectura a Supabase, a `2026-10-02T20:21:35.483747Z`, confirmó que el ledger canónico del día aún registra 5 solicitudes Groq, 7.366 tokens y 0 reservas desconocidas, igual que la lectura anterior al probe de `2026-10-02T20:18:31.784272Z`. Delta del ledger interno: 0 solicitudes y 0 tokens.

La respuesta no tenía cabeceras RPD. Por ello no se puede determinar si Groq contó el GET en su cuota de solicitudes; no se presume que fuera gratuito ni se añade a los 24 llamados históricos de inferencia del piloto.

## TOKEN ACCOUNTING

Esta fase consumió 0 tokens de inferencia y no generó uso de modelo. El ledger canónico permaneció en 7.366 tokens, delta 0. No hay evidencia de tokens de inferencia consumidos por el GET de metadatos; tampoco hay cabeceras TPM para medir una cuota TPM del proveedor.

## TPM INTERPRETATION

Groq documenta `x-ratelimit-limit-tokens`, `x-ratelimit-remaining-tokens` y `x-ratelimit-reset-tokens` como lecturas de TPM. Las tres faltaron en esta respuesta, así que no hay un estado actual utilizable para `openai/gpt-oss-20b`. Véase [Groq Rate Limits](https://console.groq.com/docs/rate-limits).

La estimación Critic V4 sigue en 6.397 tokens, con límite interno configurado de 8.000 y margen de seguridad de 128; el margen teórico con la cuota completamente disponible sería 1.475. Sin TPM restante/reset frescos no se puede concluir `IMMEDIATE` ni `WAIT_FOR_TOKEN_RESET`.

## CAPACITY DECISION

`capacityDecision=BLOCKED_TPM_STATE_UNKNOWN`
Motivo del probe: `METADATA_ENDPOINT_NO_USABLE_TPM_STATE`.

Se detuvo aquí. No se probó otro endpoint y no se ejecutó una llamada de inferencia pequeña. Esta decisión no autoriza la continuación de un solo uso.

## REAL STATE

La lectura SQL posterior confirmó:

- Artículo `756b0ee0-b5e6-4153-846f-278a12c9afe3`: `archived`, no visible públicamente.
- Intento `a82482be-58d8-4fc6-ac16-946d0906257b`: `TECHNICAL_FAILURE`, `continuation=null`, intento piloto 5; siguen existiendo 2 intentos para el evento.
- Ejecuciones Critic V4 asociadas: 0.
- Contrato público: 2 artículos, mismos dos slugs presentes antes del probe; el incidente sigue ausente.
- Ledger diario Groq: 5 solicitudes, 7.366 tokens, 0 reservas desconocidas; Cloudflare y Cerebras: 0 solicitudes.

No hubo escrituras Supabase, migraciones ni cambios en el artículo o el intento.

## NEXT STEP

Detenerse. No consumir la autorización previa ni iniciar Critic con capacidad inferida. Para una futura evaluación hace falta evidencia TPM fresca y utilizable; esta fase no concede autorización para continuar.

**Probe completado; READY estricto: NO.** La solicitud de metadatos terminó, la inferencia fue cero, el estado real quedó intacto y la capacidad quedó clasificada explícitamente como desconocida. `GROQ_API_KEY` no estaba disponible y la autenticación usó la credencial Groq configurada en `AGENT_API_KEY`, por lo que no se cumplió literalmente la fuente de credencial pedida. No se repetirá la solicitud para corregirlo. La continuación permanece pendiente y no autorizada.
