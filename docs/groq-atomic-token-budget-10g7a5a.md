# 10G.7a.5a — presupuesto atómico de tokens Groq

## Estado

- Migración preparada: `supabase/migrations/20260925000025_groq_atomic_token_capacity.sql`.
- Aplicada: **no**. Esta fase no accede a Supabase remoto ni ejecuta `db push`.
- Nueva tabla: **no**. Se reutiliza `agent_logs` y el `reservationId` existente.
- Configuración efectiva de cuotas, scheduler, router y publicación: **sin cambios**.
- Sin llamadas a proveedores, RPC remoto, pipeline ni scheduler.

La migración es necesaria porque el ledger ya admite `provider_unit='tokens'` y `provider_unit_amount`, pero las RPC anteriores no reservaban request y tokens juntos para Groq ni ofrecían settlement atómico.

## Ledger canónico

Una fila `agent_logs` con `step='provider_request_reserved'` representa un intento de proveedor. Para las reservas nuevas de Groq:

- `provider='groq'` identifica proveedor y ámbito del lock.
- `provider_unit='tokens'` y `provider_unit_amount` contienen el único total de tokens que consume el presupuesto diario.
- Antes del dispatch, y después de un dispatch cuyo usage sea desconocido, ese total es `estimatedTokens`.
- Tras usage fiable, el mismo campo se actualiza a `inputTokens + outputTokens`.
- El estado está en el payload: `reserved_estimate` o `settled`.
- El request se cuenta desde la existencia de la misma fila; no hay una segunda fila ni un ledger paralelo.

La telemetría de `agent_runs.stats` no se suma para filas que ya tengan `provider_unit='tokens'`; solo permite reconstruir el total de reservas Groq históricas request-only. Una fila histórica Groq (incluidas filas cuyo `provider` sea `NULL`, que se siguen considerando Groq) con telemetría ausente, ambigua o con más de una reserva por ejecución hace que la nueva admisión falle cerrada con `GROQ_DAILY_TOKEN_USAGE_UNKNOWN`. Así no se convierte el pasado desconocido en cero ni se duplica telemetría.

## RPCs

`reserve_groq_request_and_tokens(...)` recibe los límites hard/soft efectivos, el modelo, la identidad de ejecución y `estimatedTokens`. Valida provider/run/model, fecha UTC actual, identidad de intento y valores positivos. Bajo un único lock Groq/día calcula uso actual, verifica ambas dimensiones y crea una sola fila o ninguna. La prioridad del rechazo es uso histórico desconocido, request hard/soft y tokens hard/soft; el resultado incluye `reason`, periodo, uso antes/después, límites y reserva.

`mark_agent_request_dispatched(...)` conserva el marcador `providerRequestDispatched`. `release_agent_request(...)` conserva la identidad y el owner actuales. Ambos seleccionan la reserva y toman el mismo lock Groq/día antes de mutar: si release gana, dispatch ya no encuentra la fila; si dispatch gana, el predicado de release impide borrar la fila. Para filas de otros proveedores se conserva el lock compartido y el comportamiento existente.

`settle_groq_token_usage(...)` exige owner, fila Groq con unidad tokens y request ya despachado. Actualiza el total a la suma real, incluso si es mayor que la reserva o deja el día por encima de un límite. Una repetición con el mismo total no vuelve a sumar; un total distinto devuelve `provider_token_settlement_conflict`. Settlement usa el `requestDate` almacenado como argumento y los límites UTC de ese día original, aunque ocurra después de medianoche.

Las RPC están `SECURITY DEFINER`, fijan `search_path`, califican objetos con `public`, revocan ejecución a `PUBLIC`, `anon` y `authenticated`, y conceden ejecución solo a `service_role`.

## Ciclo en runtime

El runtime estima el request con el estimador existente de pacing Groq (`chars/2 + 128` de overhead de input + `maxOutputTokens`); no se cambia el estimador TPM ni su margen. `ModelConfig.groqCapacity` es inyección explícita, no una cuota por defecto. En esta subfase no se cargan valores de cuenta ni se activan límites nuevos. Hasta que una fase posterior proporcione límites, una ejecución con provider Groq falla antes de abrir un `agent_run` o llamar al proveedor; no recurre al RPC request-only.

Con límites inyectados: reserva atómica → marcador de dispatch existente → HTTP. Si el fallo es anterior al marcador, se libera la fila. Si ya hubo dispatch y no hay input/output fiables (timeout, 429 sin usage, red, 5xx o respuesta corrupta), se conserva la estimación. Si hay usage fiable, se liquida antes del parseo/validación Zod, por lo que un output inválido no pierde el consumo real.

## Aislamiento Cloudflare

No se modifican RPCs de Neurons, sus límites, el settlement ni el routing Cloudflare. El lock Groq usa `horizai-agent-budget:groq:<UTC-date>`; no adquiere el lock de Cloudflare. La reserva Groq es una unidad `tokens`, no `neurons`.

## Validación local y limitaciones

- Tests de comportamiento del logger en memoria: reserva all-or-nothing, concurrencia simulada bajo serialización, límites soft/hard, settlement menor/igual/mayor, repetición/conflicto, release/dispatch en ambos órdenes, owner, desconocido post-dispatch, UTC y aislamiento Cloudflare.
- Test estático de migración: firmas, lock scopes, ledger único, grants, estados, UTC y no alteración de la política Neurons.
- `docker` existe pero el daemon local no está disponible; no hay `psql` ni harness PostgreSQL/Supabase efímero configurado. Por eso **SQL_CONCURRENCY_STATICALLY_VALIDATED_ONLY**; los tests en memoria no se presentan como prueba de concurrencia PostgreSQL. Esa validación queda para 10G.7a.5b, después de aplicar la migración con autorización.
- No se han ejecutado llamadas a proveedor ni Supabase remoto; tampoco se han consultado RPCs remotas.

La aplicación remota está pendiente de 10G.7a.5b. La política de capacidad completa y la configuración efectiva permanecen pendientes de 10G.7a.5; los gates de producción continúan cerrados.
