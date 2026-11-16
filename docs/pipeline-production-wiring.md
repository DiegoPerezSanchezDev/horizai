# Fase 10A.1 — composición de producción

La composición de producción está en `lib/agents/pipeline/create-production-pipeline.ts`. Es un composition root server-side: crea el cliente Supabase de servidor, el provider configurado por entorno, el logger, el presupuesto común y los adaptadores de las etapas. Importarlo no ejecuta el pipeline ni realiza llamadas al modelo.

## Flujo conectado

```text
Discovery → Extraction → Clustering → Verifier → Translator → Editor v2
                                                  ↓
                         Classifier → Geo Resolver → Ranker → Critic v3 → Publisher v1
```

Discovery, extracción y clustering siguen siendo deterministas respecto al modelo; los agentes reciben inputs construidos desde los tipos de sus contratos existentes. El Verifier recibe la metadata estricta sin campos internos adicionales. Las etapas posteriores conservan `sourceItemId` en una metadata interna del pipeline para que la trazabilidad no se pierda.

## Guardas de ejecución

- `pipeline:test` entra en modo `preflight` por defecto; una ejecución real requiere explícitamente `--execute --hours=N --limit=1`.
- `--preflight-only` y `--execute` son mutuamente excluyentes. Los flags desconocidos, los argumentos incompletos y `--limit` distinto de `1` fallan antes de crear el pipeline.
- La composición aplica `maxRetries: 0` explícitamente a Verifier, Translator, Editor, Classifier, Ranker y Critic.
- Se reutiliza el guard de coste del runtime: el pipeline de esta composición consume exclusivamente la cuota provider-scoped de Groq (`GROQ_DAILY_REQUEST_HARD_CAP`, con `AGENT_DAILY_REQUEST_LIMIT` solo como fallback legado), `AGENT_MAX_OUTPUT_TOKENS`, fail-closed ante rate limit y sin fallback pagado. La cuota de Neurons Cloudflare no se suma ni se resta de requests Groq.
- `pipeline:test` fuerza `dryRun=true` y `publish=false`; `--publish=true` se rechaza.
- La ejecución trazable real activa explícitamente `persistTraceability=true`; esa
  señal solo persiste `raw_items`. `events` y `event_sources` quedan reservados
  para la futura transacción de publicación.
- `--preflight-only` comprueba configuración, conexión de Supabase, cuota persistente, presupuesto de seis requests y que todos los adaptadores estén conectados, sin ejecutar Discovery ni ningún agente.

## Checkpoints

Los escritores existentes se reutilizan con una ruta explícita bajo:

```text
artifacts/pipeline-checkpoints/<runId>/<stage>-<eventKey>.json
```

Esto evita que dos eventos sobrescriban el checkpoint singleton histórico. Los checkpoints se escriben atómicamente y se vuelven a leer y validar antes de permitir que el evento continúe. Los paths singleton anteriores se mantienen para replay histórico y no se usan en esta composición.

## Publisher

El adaptador usa `Publisher` y `SupabasePublisherRepository` reales. Para evitar inferir silenciosamente scores de categorías, roles de entidades o confidence que no existen en las salidas de las etapas, exige un `publicationPayloadFactory` explícito. La ausencia de ese materializador produce un bloqueo fail-closed. La prueba de wiring inyecta un payload fixture y verifica únicamente el camino dry-run; no escribe artículos.

La preview de Publisher también puede consumir un Critic checkpoint cuando el evento todavía no está persistido: conserva `eventKey` como identidad lógica, resuelve referencias existentes mediante lecturas y marca el evento/artículo como `would_create` sin crear UUIDs. La publicación real puede materializar el evento dentro de la RPC atómica cuando cada fuente aporta su `rawItemId` validado; la RPC sigue sin crear sources, regions ni categories.

## Pruebas

```bash
npm run pipeline:cli:unit
npm run pipeline:wiring:unit
npm run pipeline:test -- --hours=48 --limit=1 --preflight-only
npm run pipeline:preflight -- --hours=48 --limit=1
npm run pipeline:test -- --execute --hours=48 --limit=1
```

La prueba de wiring no tiene provider ni Supabase reales: valida las transformaciones, los contratos, el presupuesto de requests, los checkpoints y el publisher dry-run con dobles locales. El preflight sí hace una lectura mínima de `regions` para confirmar conectividad, pero no llama a Groq ni crea reservas.
