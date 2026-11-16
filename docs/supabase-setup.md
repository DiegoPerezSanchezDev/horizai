# Conexión de Supabase — Fase 8C

## Alcance

HorizAI tiene las migraciones y el seed de Fase 8A. Esta fase mantiene la conexión server-side y añade la superficie de seguridad de Fase 10E. La UI sigue usando sus mocks y no existe todavía cliente público conectado ni lógica de agentes expuesta.

## Variables de entorno

Crear `.env.local` en la raíz del proyecto. El archivo está excluido por `.gitignore` y nunca debe subirse al repositorio:

```ini
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<publishable-key>
SUPABASE_SECRET_KEY=<secret-key>
```

No incluir valores reales en documentación, fixtures, logs, commits ni capturas.

### Publishable key frente a secret key

- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` está diseñada para código que eventualmente pueda ejecutarse en el navegador. Solo debe usarse junto con RLS y policies revisadas; todavía no se usa en HorizAI.
- `SUPABASE_SECRET_KEY` permite operaciones privilegiadas y solo se lee en [`lib/supabase/server.ts`](../lib/supabase/server.ts). Nunca debe importarse desde un componente client ni aparecer en variables `NEXT_PUBLIC_*`.
- El cliente actual solo consume `NEXT_PUBLIC_SUPABASE_URL` y `SUPABASE_SECRET_KEY`, con sesiones persistentes y refresh automático desactivados porque se usa para procesos confiables server-side.

## Aplicar migraciones

Requisitos: tener Supabase CLI disponible mediante `npx`, una sesión iniciada y el proyecto enlazado.

```bash
npx supabase login
npx supabase link --project-ref <PROJECT_REF>
npm run supabase:status
npm run supabase:db:push
```

`supabase:db:push` aplica, en orden, las migraciones de `supabase/migrations/`. La migración de seed es idempotente y deja:

- 11 regiones.
- 8 categorías.
- 15 fuentes de ejemplo.

Las migraciones `20260921000014_security_rls_public_read_contract.sql` y
`20260921000015_fix_public_view_grants.sql` habilitan RLS en las tablas de
aplicación y crean el contrato público mínimo descrito en
[`docs/supabase-security.md`](supabase-security.md). No se concede SELECT
directo sobre las tablas base.

`npm run supabase:status` muestra la correspondencia entre migraciones locales y remotas. La migración de seguridad es forward-only; no se deben editar migraciones ya aplicadas.

## Smoke test

Ejecutar:

```bash
npm run supabase:smoke
```

El script carga `.env.local` con el cargador de entorno de Next, crea el cliente server-only y comprueba:

1. Lectura de `regions`, `categories` y `sources`.
2. Conteos exactos de 11, 8 y 15.
3. Creación temporal de un `agent_run` en modo `dry_run`.
4. Creación y lectura de un `agent_log` asociado.
5. Validación de la relación `agent_logs.run_id → agent_runs.id`.
6. Eliminación de ambos registros y comprobación de que no queda ninguno.

El script solo imprime estados y mensajes de error sanitizados; nunca imprime variables de entorno ni claves.

## Comprobación de seguridad

```bash
rg -n "SUPABASE_SECRET_KEY|NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY" -g '!node_modules' .
```

La referencia esperada a `SUPABASE_SECRET_KEY` está limitada al módulo
server-only y al nombre de entorno/documentación. La lectura pública futura
debe usar únicamente las views curadas y mantenerse protegida por RLS/grants.

Para comprobar el contrato de anon y la ausencia de acceso directo:

```bash
npm run supabase:security
```

## Validación completa

```bash
npm run supabase:smoke
npm run agents:contracts:test
npm run lint
npx tsc --noEmit
npm run build
```

La build no debe importar `lib/supabase/server.ts` desde rutas client. Si en el futuro se necesita acceso público, debe crearse un módulo separado que use únicamente `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` y que respete RLS.
