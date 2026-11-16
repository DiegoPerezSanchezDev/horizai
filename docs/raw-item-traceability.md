# Raw-item traceability — Fase 10F-A.1

## Responsabilidad

La cadena persistente es:

```text
source
  ↓
DiscoveryCandidate (sourceItemId)
  ↓
raw_items (rawItemId UUID real)
  ↓
ExtractedItem
  ↓
lineage interno del pipeline
  ↓
events / event_sources / articles (solo publicación futura)
```

Discovery descubre candidatos y Extraction obtiene material determinista. La
materialización de `raw_items` vive en
`lib/agents/ingestion/raw-item-repository.ts`, que es la única operación
canónica usada por ambas etapas. Publisher no crea raw items: solo acepta un
`rawItemId` ya persistido y verifica que pertenezca a la fuente declarada.

## Dos identidades distintas

`sourceItemId` es la identidad determinista del elemento upstream. En la
implementación actual es `DiscoveryCandidate.externalId`, derivado de
`source.id` y de la URL canónica.

`rawItemId` es el UUID generado por PostgreSQL para la fila de
`public.raw_items`.

Nunca se convierten entre sí ni se resuelve uno mediante título, fecha o URL
parecida. La materialización interna conserva ambos valores junto con
`sourceId` y la acción `created`/`reused`.

## Idempotencia y concurrencia

La migración `20260922000016_raw_item_identity.sql` añade el índice único
`(source_id, external_id)` para valores no nulos. Es necesario porque el
schema inicial solo hacía único `(source_id, content_hash)`, que no conserva
la identidad entre el hash de título/extracto de Discovery y el hash del
contenido extraído.

La persistencia usa un `INSERT` atómico como árbitro. Si otra ejecución gana
la misma identidad, el conflicto único se resuelve con una consulta exacta
por `(source_id, external_id)` y ambas ejecuciones reciben el mismo UUID.
No hay un patrón `SELECT → INSERT` como mecanismo de deduplicación.

## Dry run y trazabilidad

`dryRun`/`publish=false` sigue significando que no se crean artículos,
relaciones editoriales, actividad ni se llama al RPC de publicación.

La composición productiva conserva por defecto el comportamiento previo y no
persiste ingesta. Un caller interno puede activar explícitamente
`persistTraceability: true`; eso persiste únicamente la cadena de ingesta
(`raw_items`) y propaga el UUID real al contexto interno. No persiste
`events` ni `event_sources`, y no es una autorización de publicación.

Con `persistTraceability` desactivado, el mapa de lineage contiene
`rawItemId: null`; una nueva publicación falla cerrado en readiness.

## Candidato histórico de 10F-A

El checkpoint histórico conserva `sourceItemId`, pero no conserva el UUID de
`raw_items`, la URL original/canónica exacta ni un `ExtractedItem` completo
que permita demostrar la equivalencia del artefacto. Supabase tampoco tiene
ningún `raw_item` correspondiente. Por tanto, el candidato no es exactamente
backfilleable y no se crea una fila histórica heurística.

La próxima ejecución fresca debe activar `persistTraceability` desde el
origen; esa ejecución queda fuera de esta fase.

## Seguridad

`raw_items` permanece interno. No se conceden permisos a `anon` ni a
`authenticated`; la persistencia solo usa el cliente server-side con la
configuración de servicio existente. El contenido bruto no aparece en views
públicas.
