# 10G.7a.5b.0 — estado remoto de la migración Groq

## Resultado

**READY YES.** El proyecto enlazado coincide con HorizAI (`skrthgpurquypgdwxast`). El historial remoto confirma que las migraciones 24 y 25 están aplicadas. La versión remota más reciente es `20260925000025`.

Esta fase fue exclusivamente de descubrimiento. No aplicó migraciones, no alteró el esquema, no creó fixtures y no llamó a proveedores.

## OBSERVE

La lectura anterior por PostgREST devolvió `PGRST106`, ya que `supabase_migrations` no está expuesto. Ese resultado no determinaba el estado. El repositorio sí contiene el enlace de Supabase y un comando de CLI existente para listar migraciones.

## PLAN

Usar la CLI Supabase actual y enlazada para leer el historial remoto; comparar las entradas local/remota; dado que 25 aparecía aplicada, consultar solo metadatos de las funciones que introduce o actualiza.

## EXECUTE

- CLI: Supabase `2.118.0`.
- El nombre y las referencias del proyecto enlazado coinciden con `horizai` / `skrthgpurquypgdwxast`.
- Comando de historial: `npx --yes supabase migration list --linked --output-format json`.
- La salida muestra `20260924000024` y `20260925000025` tanto en local como en remoto. Las 26 entradas locales listadas coinciden con el historial remoto; la más reciente es `20260925000025`.
- La revisión de objetos se ejecutó mediante `supabase db query --linked` con una consulta `SELECT` sobre `pg_proc`, `pg_namespace`, ACL y roles. No consultó filas de producción.

### Estado de migraciones

| Migración | Local | Remoto |
| --- | --- | --- |
| `20260924000024` | Presente | **APPLIED** |
| `20260925000025` | Presente | **APPLIED** |

### Objetos de la migración 25

| Función | Firma de identidad | Retorno |
| --- | --- | --- |
| `public.reserve_groq_request_and_tokens` | `p_run_id uuid, p_agent_name text, p_agent_version text, p_event_key text, p_attempt integer, p_model text, p_request_date date, p_request_hard_limit integer, p_request_soft_limit integer, p_token_hard_limit bigint, p_token_soft_limit bigint, p_estimated_tokens bigint` | `jsonb` |
| `public.settle_groq_token_usage` | `p_reservation_id bigint, p_run_id uuid, p_request_date date, p_actual_input_tokens bigint, p_actual_output_tokens bigint` | `jsonb` |
| `public.mark_agent_request_dispatched` | `p_reservation_id bigint, p_run_id uuid, p_request_date date` | `boolean` |
| `public.release_agent_request` | `p_reservation_id bigint, p_run_id uuid, p_request_date date` | `boolean` |

Las cuatro funciones son `SECURITY DEFINER` y usan `search_path=pg_catalog, public, pg_temp`. Los privilegios efectivos permiten `EXECUTE` a `service_role` y lo deniegan a `anon` y `authenticated`. La ACL consultada contiene `postgres` y `service_role`, sin concesión a `PUBLIC`.

## CRITIQUE

El historial de migraciones, y no la mera presencia de los objetos, determina el estado: 24 y 25 figuran explícitamente en el historial remoto. La consulta de objetos fue una comprobación secundaria de metadatos porque 25 estaba aplicada.

## VERIFY

- Proyecto remoto: **MATCH** con la referencia esperada.
- Migración 24: **APPLIED**.
- Migración 25: **APPLIED**.
- Última migración remota: `20260925000025`.
- Migración 26 creada: **NO**.
- Escrituras remotas y mutaciones de esquema: **0**.
- Fixtures, llamadas a proveedores e inferencias: **0**.
- `npm run lint`: **PASS**.
- `npm run build` (incluye TypeScript): **PASS**.
- JSON del artefacto: **PASS**.
- No se imprimieron credenciales.

## Continuación

La fase 10G.7a.5b puede reanudarse directamente desde **REMOTE VALIDATION**, sin reaplicar la migración 25.
