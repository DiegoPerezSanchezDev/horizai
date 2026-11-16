# Retirada de noticias publicadas (P1)

Estado: **código y migración preparados, sin aplicar ni activar.** Fecha: 2026-11-06.

## Qué hace

Desde `/editorial/publicadas` un operador autorizado puede retirar una noticia publicada (`publication_status` `published` → `archived`), con motivo, nota interna obligatoria y registro de operador y fecha. También puede restaurar solo las retiradas por este flujo. La noticia deja de aparecer en la web pública porque `public.public_published_articles` solo incluye `published`.

Objetivo de P0-a (D5): atender una reclamación el mismo día o el siguiente.

## Piezas

| Pieza | Fichero |
| --- | --- |
| Migración (NO aplicada) | `supabase/migrations/20261106120000_article_withdrawals.sql` |
| Política y validación puras | `lib/editorial/withdrawal-policy.ts` |
| Repositorio RPC (solo servidor) | `lib/editorial/withdrawal-repository.ts` |
| Pantalla | `app/editorial/(workspace)/publicadas/page.tsx` |
| Endpoint POST | `app/editorial/(workspace)/publicadas/withdraw/route.ts` |
| Pruebas offline | `npm run editorial:withdrawal:unit` |

## Seguridad

- Es el **primer endpoint de escritura del panel editorial**. Hasta ahora el panel era de solo lectura y `handlers.ts` declaraba «no editorial RPCs or decision endpoints»; este cambio lo amplía de forma deliberada y acotada.
- Orden del endpoint: comprobación de mismo origen → operador verificado desde la sesión (`requireEditorialOperator`) → bandera → formulario estricto → una RPC.
- La bandera `EDITORIAL_WITHDRAWAL_ENABLED` debe valer exactamente `true`; por defecto está desactivada (`.env.example`).
- El correo del operador sale de la sesión, nunca del formulario; los campos desconocidos o duplicados se rechazan.
- Las RPC son `security definer`, con `search_path` fijado y solo `service_role` puede ejecutarlas. La tabla de auditoría no tiene permisos para `anon` ni `authenticated`.
- Un disparador impide que un artículo retirado vuelva a `published` por cualquier otra vía (por ejemplo una nueva ejecución del pipeline para el mismo evento). Solo `restore_withdrawn_article` lo permite.

## Riesgos conocidos

1. **La migración no se ha ejecutado contra ninguna base de datos.** La instancia configurada no resuelve su nombre de host (`ENOTFOUND`). Solo hay comprobaciones estáticas del SQL.
2. **Efecto sobre el publicador.** El plan de escritura del publicador usa `update_same_event` y fija `published`. Con el disparador, una republicación del mismo evento fallará de forma explícita (`ARTICLE_WITHDRAWN`) en vez de reabrir la noticia. Falta una prueba con la RPC real del publicador.
3. **El listado solo muestra los últimos 30 días** (lectura pública existente); para el resto se retira por enlace.
4. No hay prueba de navegador del flujo completo ni se ha probado con un operador real.

## Para activarlo (cuando se autorice)

1. Revisar la migración y aplicarla en un entorno de prueba.
2. Probar retirar, repetir (idempotencia), restaurar y republicar el mismo evento.
3. Poner `EDITORIAL_WITHDRAWAL_ENABLED=true` solo en el entorno elegido.
