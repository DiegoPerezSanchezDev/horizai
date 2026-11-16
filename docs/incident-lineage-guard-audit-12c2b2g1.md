# 12C.2B.2g.1 — Auditoría de determinismo del guard de linaje

**Modo:** diagnóstico de solo lectura. **Resultado:** `READY NO`.

Se hicieron cero llamadas a proveedores, cero inferencias, cero llamadas a la RPC de resume y cero escrituras remotas. No se creó un intento, no se consumió la autorización, Critic no se ejecutó y no se publicó nada.

## FAILURE

La fase 12C.2B.2g terminó con `FACTUAL_REMEDIATION_CONTINUATION_RESUME_BLOCKED:INCIDENT_LINEAGE_OR_ARCHIVE_CHANGED`. La RPC de migración 30 devolvió ese motivo antes de cambiar la continuación. El artefacto anterior registra `resumeGeneration: null`, `resumeExecutionId: null` e historial vacío.

Los artefactos persistidos no contienen el SQL completo ni las columnas de la primera lectura compuesta que devolvió falso. Registran solo `firstCombinedPredicateAfterRpc: false`, `componentChecks: true` y `subsequentExactCombinedPredicate: true`. El probe terminó a las `2026-10-04T19:00:26.254Z`; el artefacto de fase se guardó a las `2026-10-04T19:00:41.472Z`. El instante exacto de la respuesta de resume no quedó guardado.

Argumentos recuperables de la RPC:

- `p_attempt_id`: `a82482be-58d8-4fc6-ac16-946d0906257b`.
- `p_pipeline_run_id`: `f140d01b-b7f1-4f05-b8f7-9ad0081e7105`.
- `p_resume_execution_id`: la aplicación generó un UUID en memoria, pero el valor no se persistió ni está en los artefactos disponibles.
- `p_checkpoint_manifest`: manifiesto de cinco checkpoints, etapa `critic`, `criticCheckpoint: absent`, hash canónico `0c3a6f8dab750a345f38e0efbd8481557a1fbfd49a43b2a13879b1ee43e555a6`.

El productor es el `IF` real/sintético de `public.resume_incident_factual_remediation_continuation(uuid, uuid, uuid, jsonb)` en la migración 30. El consumidor remoto es `SupabaseFactualRemediationContinuationRepository.resumePreviouslyAuthorized`; el runner convierte el resultado en `FACTUAL_REMEDIATION_CONTINUATION_RESUME_BLOCKED`. La definición remota leída en esta auditoría tiene propietario `postgres`, `SECURITY DEFINER` y `search_path=pg_catalog, public`; el bloque relevante coincide con la migración local 30.

## REAL STATE

La lectura PostgreSQL final, `2026-10-04 19:57:40.55064+00`, y el preflight de runner de las `2026-10-04T19:53:53.018Z` coinciden:

- Evento `5138e509-f4c3-4020-9d13-6a6efac99a39`, clave `event-30f226d1b8ba5c9eb8af2b65c46db512`, activo y aprobado.
- Artículo `756b0ee0-b5e6-4153-846f-278a12c9afe3`, asociado al evento correcto, `publication_status=archived`; el slug no está en la vista pública y el recuento público es 2.
- Una sola fila `event_sources`: evento `5138e509-f4c3-4020-9d13-6a6efac99a39`, raw item `d3834944-72f6-4f59-9aca-3f66ae92dc33`, fuente `e8dd0363-f51e-4381-9fb2-c02ee81f4d41`.
- Raw item: el mismo `source_id`, hash `sha256:9f053bdbb6d53e5d59baf254201811874992bf7cad444b38431b8f364bfe5caa`, longitud PostgreSQL 1.756, no nulo, `extraction_quality=full`, `processing_status=extracted`.
- Fuente: `TechCrunch AI`.
- Intento actual: el mismo intento 2, `TECHNICAL_FAILURE`, `cost_guard_violation`, piloto 5/5. Hay dos intentos, no existe intento 6.
- Continuación: la autorización existente sigue `STOPPED`; no hay `resumeGeneration`, `resumeExecutionId`, historial de resume, reserva Critic, dispatch Critic ni checkpoint Critic.
- Piloto: 26/30 llamadas Groq. El preflight posterior al probe no encontró nuevos runs Groq en el piloto.
- Migraciones remotas: 27–30 aplicadas; 30 es la última. La 31 no existe ni se aplicó.

## GUARD DECOMPOSITION

La rama real de la función colapsa exactamente estas cinco condiciones en el motivo observado:

```sql
if not exists (
  select 1 from public.events e
   where e.id = v_real_event_id and e.event_key = v_real_event_key
     and e.event_status = 'active' and e.review_status = 'approved'
) or not exists (
  select 1 from public.articles a
   where a.id = v_real_article_id and a.event_id = v_real_event_id
     and a.slug = v_real_article_slug and a.publication_status = 'archived'
) or exists (
  select 1 from public.public_published_articles p where p.slug = v_real_article_slug
) or (select count(*) from public.event_sources es where es.event_id = v_real_event_id) <> 1
   or not exists (
     select 1 from public.event_sources es
     join public.raw_items r on r.id = es.raw_item_id and r.source_id = es.source_id
     join public.sources s on s.id = es.source_id
      where es.event_id = v_real_event_id and es.raw_item_id = v_real_raw_item_id
        and es.source_id = v_real_source_id and s.name = 'TechCrunch AI'
        and r.content_hash = v_real_raw_content_hash and length(r.raw_content) = 1756
        and r.raw_content is not null and r.extraction_quality = 'full'
        and r.processing_status = 'extracted'
   ) then
  return jsonb_build_object('status', 'BLOCKED', 'reason', 'INCIDENT_LINEAGE_OR_ARCHIVE_CHANGED');
end if;
```

Nombres positivos de la consulta diagnóstica: `event_ok`, `article_archived_ok`, `incident_public`, `event_source_count`, `source_raw_lineage_match`. La condición de rechazo es `NOT event_ok OR NOT article_archived_ok OR incident_public OR event_source_count <> 1 OR NOT source_raw_lineage_match`.

Resultado actual: `true, true, false, 1, true`; rechazo `false`; guard válido `true`. Este motivo no agrupa el intento, la autorización, el manifiesto ni la ausencia de dispatch: la función los valida en otros bloques antes de este guard.

## SQL NULL AUDIT

- `EXISTS` y `NOT EXISTS` siempre devuelven booleanos no nulos. El `COUNT(*)` y su comparación con 1 tampoco son nulos.
- Comparaciones de campos dentro de los `WHERE` sí pueden producir `NULL`: IDs/clave/estados nulos, nombre nulo, hash nulo, `length(NULL)`, `extraction_quality` o `processing_status` nulos. Una fila solo satisface un `WHERE` cuando toda su condición es `TRUE`; un `NULL` no hace pasar la fila. Así, el `EXISTS` queda falso y el `NOT EXISTS` bloquea.
- `r.raw_content IS NOT NULL` es siempre booleano. Si el contenido es nulo, la combinación de predicados tampoco puede producir una fila válida.
- El `OR` externo combina únicamente los booleanos no nulos anteriores; el `IF` no recibe un resultado nulo.
- La prueba SQL confirmó para el raw item actual que `length=1756`, `char_length=1756` y ambos resultados son iguales. También confirmó que `NULL = 'expected'` y `length(NULL)=1756` son `NULL`, y que ese valor no satisface un `WHERE` ni un `EXISTS`.
- No hay `CASE`, extracción JSON, `IS DISTINCT FROM` ni comparación de timestamps en esta rama.

## JOIN / ROW MULTIPLICITY

La consulta remota de catálogo confirmó PK `event_sources(event_id, raw_item_id)`, FK compuesto `(raw_item_id, source_id) → raw_items(id, source_id)`, PK `raw_items(id)`, clave única `raw_items(id, source_id)`, PK `sources(id)`, PK `events(id)` y PK `articles(id)`. La PK de `event_sources` permite varias fuentes/raw items para un evento; por eso el guard cuenta todas las filas del evento y exige exactamente una.

Los joins a `raw_items` y `sources` no multiplican la fila esperada por sus claves. `EXISTS` no depende del orden ni de la cantidad de coincidencias; la condición de conteo rechaza 0 y más de 1. Las fixtures SQL ejercitaron 0, 1 y 2 filas, además de raw/source ausente o incongruente, hash nulo/cambiado, contenido nulo/vacío/longitud incorrecta, estados de extracción incorrectos, fuente incorrecta y artículo público.

## ORDERING

La rama no contiene `LIMIT`, `DISTINCT ON`, `array_agg`, `json_agg`, selección de fila actual/última ni `ORDER BY`. No existe una elección de fila dependiente del orden. Las PK/unique aplican al evento/artículo/raw/fuente; `event_sources` se valida por cardinalidad.

## ARCHIVE CONTRACT

El estado canónico de archivo es `articles.publication_status = 'archived'`, usado también por el ciclo de vida de artículos. No se usa `archived_at`. El guard comprueba además, por separado, que el slug no aparece en `public_published_articles`.

La vista pública remota filtra `publication_status='published'`, `published_at IS NOT NULL`, evento activo y revisión aprobada. Por tanto, ausencia en la vista no se usó como sustituto de `archived`; las dos comprobaciones se realizaron y ambas pasaron.

## REPEATED READS

El archivo [`artifacts/incident-lineage-guard-diagnostic-12c2b2g1.sql`](../artifacts/incident-lineage-guard-diagnostic-12c2b2g1.sql) se ejecutó diez veces en secuencia mediante `npx supabase db query --linked --output-format json --file ...`. No hubo escrituras entre ejecuciones. Las cinco ramas fueron iguales en 10/10 lecturas: `event=true`, `article=true`, `public=false`, `event_sources=1`, `source/raw=true`; `guard_rejects=false`, `overall_guard_pass=true`.

| # | Inicio cliente UTC | Fin cliente UTC | `statement_timestamp()` UTC | Ramas `event/article/public/count/source` | Rechaza |
|---:|---|---|---|---|---|
| 1 | 19:29:12.4178856 | 19:29:15.6686509 | 19:29:14.088011 | `T/T/F/1/T` | `false` |
| 2 | 19:29:15.7191558 | 19:29:19.5012805 | 19:29:17.883120 | `T/T/F/1/T` | `false` |
| 3 | 19:29:19.5027496 | 19:29:24.8253599 | 19:29:23.266836 | `T/T/F/1/T` | `false` |
| 4 | 19:29:24.8259636 | 19:29:27.9285249 | 19:29:26.369570 | `T/T/F/1/T` | `false` |
| 5 | 19:29:27.9294234 | 19:29:33.9255283 | 19:29:29.544264 | `T/T/F/1/T` | `false` |
| 6 | 19:29:33.9266528 | 19:29:37.2514271 | 19:29:35.690018 | `T/T/F/1/T` | `false` |
| 7 | 19:29:37.2522278 | 19:29:40.4448751 | 19:29:38.877705 | `T/T/F/1/T` | `false` |
| 8 | 19:29:40.4454729 | 19:29:43.6126112 | 19:29:42.049332 | `T/T/F/1/T` | `false` |
| 9 | 19:29:43.6130241 | 19:29:46.8701280 | 19:29:45.280219 | `T/T/F/1/T` | `false` |
| 10 | 19:29:46.8704939 | 19:29:50.2061483 | 19:29:48.639103 | `T/T/F/1/T` | `false` |

La prueba [`artifacts/incident-lineage-guard-same-snapshot-12c2b2g1.sql`](../artifacts/incident-lineage-guard-same-snapshot-12c2b2g1.sql) usó una transacción `REPEATABLE READ READ ONLY` y evaluó dos veces el guard, con el mismo vector y `identical=true` en el mismo snapshot.

La fixture CTE de [`artifacts/incident-lineage-guard-fixture-12c2b2g1.sql`](../artifacts/incident-lineage-guard-fixture-12c2b2g1.sql) devolvió 17/17 resultados esperados. Es una fixture efímera dentro de una consulta SELECT, no creó filas. La discrepancia histórica falsa→verdadera **no** se reprodujo. El repositorio no tenía PostgreSQL local disponible en la fase anterior; por eso esta fixture SQL se ejecutó por el mecanismo remoto de consulta de solo lectura, mientras que el helper de preflight sí se probó con fixtures unitarios locales.

## CROSS-PATH COMPARISON

- **SQL PostgreSQL vía Supabase Management API:** el diagnóstico completo dio los mismos valores en diez lecturas y otra lectura final a las `19:57:40.55064+00`.
- **PostgREST/Supabase JS con clave de servidor:** una lectura completa a las `2026-10-04T19:34:01.983Z` devolvió los mismos IDs, estados, hash, longitud, fuente, cardinalidad, dos intentos y recuento público. Una ejecución posterior del preflight de auditoría también pasó a las `19:53:53.018Z`.
- **Errores de lectura REST:** hubo solicitudes aisladas con `PGRST303` (`JWT issued at future`) en lecturas de `sources`/`raw_items`; esas solicitudes no aportaron valores. Otras lecturas completas pasaron. No se atribuye ese error a la discrepancia de la RPC.
- **Preflight antiguo de 12C.2B.2g:** al repetirlo después del probe legítimo, se bloqueó con `PILOT_CALL_COUNT_CHANGED_SINCE_LAST_AUDIT` porque aún esperaba baseline 25 y ahora hay 26. No es una llamada adicional ni una mutación.

Las respuestas que sí contienen datos concuerdan. Los fallos REST no se reinterpretan como causa de la respuesta histórica.

## FIRST DIVERGENT PREDICATE

No identificable con la evidencia guardada. El artefacto previo conserva el resultado compuesto falso y el posterior verdadero, pero no la expresión SQL completa ni los valores por componente de la primera lectura. Las lecturas actuales y la instantánea transaccional no divergen: las cinco ramas coinciden.

El resumen anterior menciona `char_length` en la consulta inicial y `length` en la posterior. Para el valor actual, ambas funciones devuelven 1.756. Eso descarta esa diferencia como explicación del estado actual, pero no prueba que los dos statements históricos fueran idénticos en las demás condiciones ni explica el falso original.

## ROOT CAUSE

**Clase primaria elegida:** `OTHER` — la causa histórica sigue desconocida porque no se conservó el SQL exacto de la primera lectura falsa, no puede recuperarse el primer predicado divergente y no se reprodujo la respuesta de la RPC.

No se clasifica como glitch transitorio, red, consistencia eventual, carrera, problema de PostgREST, bug de consulta ni bug de la RPC. Una sola observación actual no prueba ninguna de esas causas.

**Causa secundaria confirmada:** `RUNNER_PREFLIGHT_BUG`. El preflight original comprobaba evento, artículo y visibilidad, pero omitía la cardinalidad `event_sources` y el enlace exacto raw/source/hash/longitud/estados que exige la RPC. Se corrigió el preflight local y se añadieron tests de rechazo. Esta brecha no explica por sí sola por qué la RPC histórica rechazó mientras una consulta posterior pasó.

## REAL LINEAGE DECISION

`REAL_LINEAGE_UNCHANGED`. En las lecturas actuales coinciden los IDs de evento, artículo, raw item y fuente; la relación tiene una fila; source_id y hash son los esperados; el raw tiene 1.756 caracteres, contenido no nulo, extracción completa y estado extraído; el artículo está archivado y no es público. El guard completo pasó 10/10 y dos evaluaciones de un snapshot.

## FIX BOUNDARY

**B — `LOCAL_RUNNER_FIX_ONLY` para la brecha demostrada de preflight.** El preflight local ahora valida cardinalidad y fuente/raw mediante los mismos IDs, hash, nombre, longitud y estados que migración 30. No se relajó ninguna regla.

La RPC remota no se cambió: no se demostró un defecto de su implementación. No se puede afirmar que el cambio local resuelva el falso histórico. El gate de ejecución sigue bloqueado hasta explicar esa respuesta.

## CODE CHANGES

- [scripts/factual-remediation-final-resume-12c2b2g.ts](../scripts/factual-remediation-final-resume-12c2b2g.ts): el preflight consulta `event_sources`, `raw_items` y `sources`; exige el enlace exacto y registra solo los valores necesarios, sin guardar el texto raw.
- [scripts/factual-remediation-final-resume-unit-test.mjs](../scripts/factual-remediation-final-resume-unit-test.mjs): fixtures locales para fila válida, cardinalidad 0/2, ID/fuente/hash/longitud/contenido/estado/nombre incorrectos.
- [scripts/factual-remediation-continuation-unit-test.mjs](../scripts/factual-remediation-continuation-unit-test.mjs): pruebas offline para uso asentado, uso desconocido, reserva sin uso real, Critic ausente, fallo y decisión Critic no aprobada. El caso positivo solo invoca el Publisher de prueba offline; no se ejecutó el Publisher de producción.
- [scripts/factual-remediation-final-resume-audit-preflight-12c2b2g1.ts](../scripts/factual-remediation-final-resume-audit-preflight-12c2b2g1.ts): preflight de lectura que parte de 26 llamadas y declara el gate histórico sin verificar TPM ni ejecutar resume.
- Se añadieron consultas SQL de diagnóstico/fixtures y el lector REST de solo lectura en `artifacts/` y `scripts/`.

## MIGRATION 31

No requerida por evidencia actual; no se preparó y no se aplicó. La lista remota confirma migración 30 como última. No hubo bypass, excepción por incidente ni relajación de guard.

## PUBLISHER ACCOUNTING GUARD

La guarda existente sigue exigiendo una petición Critic Groq despachada y uso de tokens real, conocido y conciliado (`input + output = total > 0`) antes de poder avanzar. Si falta Critic, hay solo una reserva, el uso es desconocido, el Critic falla o su decisión no es `pass`, el Publisher no se alcanza. El caso asentado confirma elegibilidad usando el stub offline; no se ejecutó el agente Publisher real ni hubo publicación.

## REGRESSIONS

- Suites offline de npm (`*:unit` y contratos): **57/57 PASS**.
- Migración 29: **PASS**.
- Migración 30: **PASS**.
- Fixtures de guard SQL: **17/17 PASS**.
- `npm run lint`: **PASS**, sin advertencias.
- `npx tsc --noEmit`: **PASS**.
- `npm run build`: **PASS**.
- `git diff --check`: **PASS** (exit code 0; los avisos CRLF corresponden a archivos preexistentes del árbol de trabajo).
- Proveedores/inferencia/resume remoto/escrituras remotas: **0**.

No se modificó ninguna superficie visual; las revisiones responsive y de temas no aplican.

## REAL PREFLIGHT

El preflight de auditoría terminó `PREFLIGHT_ONLY`: misma autorización reutilizable, mismo intento, artículo archivado, guard actual PASS, manifiesto PASS con cinco checkpoints, cero reservas/dispatches/checkpoint Critic, 26/30 llamadas y una llamada futura posible para Critic. La estimación es 5.197 entrada + 1.200 reserva de salida = 6.397 tokens; límite 8.000, margen 128 y margen restante 1.475.

TPM figura `STALE / NOT CHECKED`: la última prueba conocida fue a las `19:00:26.254Z`; no se hizo una prueba nueva. El preflight anota `resumeEligible=false` y `BLOCKED_HISTORICAL_GUARD_DISCREPANCY_UNRESOLVED`. `PREFLIGHT_ONLY` solo significa que esta inspección no ejecutó nada; no autoriza continuar.

## NEXT STEP

Mantener la continuación detenida. Antes de cualquier probe futuro o RPC de resume, recuperar el SQL exacto de la primera lectura falsa o producir evidencia nueva que identifique y explique la primera rama divergente. No volver a invocar esta RPC dentro de esta auditoría. No crear autorización ni intento 6.

**12C.2B.2g.1 READY: NO.** La lectura real actual es determinista, pero el rechazo histórico no se reprodujo ni se explicó a partir de evidencia exacta, y no hay causa raíz probada.
