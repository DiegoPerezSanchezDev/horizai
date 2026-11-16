# Registro de intentos por evento

Fase 10F-A.4 añade `public.pipeline_event_attempts`, una memoria interna y mínima del estado de procesamiento de cada `eventKey`. La tabla almacena identidad, tiempos, resultado y metadatos de reintento; no almacena artículos, prompts, razonamiento, respuestas del modelo ni cuerpos de fuentes.

## Selección normal

El orden existente de eventos se conserva. Antes de aplicar `limit`, el orquestador consulta la elegibilidad y elimina los eventos que no pueden iniciar una ejecución normal. Por tanto, un evento bloqueado no consume el único cupo de una ejecución mientras otro evento elegible queda detrás.

```text
Discovery → Extraction → Clustering → ordenar igual que antes
                                      ↓
                              filtrar elegibilidad
                                      ↓
                              aplicar limit
                                      ↓
                           claim atómico → stages
```

El periodo diario es UTC, igual que el ledger de cuota. Un fallo técnico de primer intento queda en cooldown hasta el siguiente `00:00 UTC`; el segundo fallo técnico lleva el evento a cuarentena y requiere revisión manual. Un `PROVIDER_RATE_LIMIT` puede volver a ser elegible posteriormente y no incrementa el contador de reintentos del evento.

## Estados

| Estado | Selección normal | Cuenta para límite de reintentos |
| --- | --- | --- |
| `READY_FOR_PUBLICATION` | No | No |
| `REVISION_REQUIRED` | No; solo un flujo explícito de revisión | No |
| `REJECTED` | No | No |
| `VERIFICATION_INSUFFICIENT` | No | No |
| `TECHNICAL_FAILURE` | Con cooldown y máximo de 2 intentos | Sí |
| `PROVIDER_RATE_LIMIT` | Sí cuando vuelva a ser elegible | No |
| `CANCELLED` / `ABORTED` | Según el flujo que los produzca | No |

El claim se realiza mediante `claim_pipeline_event_attempt` antes de cualquier petición a un proveedor. La unicidad `(event_key, pipeline_run_id)` evita duplicar el mismo intento y un índice parcial permite un único intento activo por evento. Los intentos activos antiguos se cierran como `ABORTED` por el claim siguiente cuando superan el TTL; no existe un bucle de recuperación que pueda disparar proveedores.

El finalize solo acepta el `attempt_id` y `pipeline_run_id` propietarios del intento activo. Si el registro no puede reclamarse, el evento queda fail-closed y no se invoca ninguna etapa de proveedor.

## Backfill histórico

El backfill se ejecuta con `npm run pipeline:attempts:backfill -- --run-id=<uuid> --event-key=<key>`. Valida los `agent_runs` del Verifier, Translator y Editor y el fallo numérico del Editor antes de usar los RPC de claim/finalize. Es idempotente: si la identidad ya existe, comprueba el estado y no inserta otra fila. El intento histórico conocido se clasifica como `TECHNICAL_FAILURE / EDITOR_OUTPUT_REJECTED`, con `counts_toward_retry_limit=true`.

## Seguridad

La tabla tiene RLS habilitado, ningún acceso para `public`, `anon` o `authenticated`, y los dos RPC solo pueden ejecutarse con `service_role`. No se modifica la política RLS de las tablas existentes. La selección provider-free puede leer el registro con el cliente server-only, pero no llama a Groq.
