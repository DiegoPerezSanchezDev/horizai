# Orquestador de pipeline — Fases 10A/10B offline

## Alcance

El orquestador (`lib/agents/pipeline/`) coordina las etapas existentes. No contiene prompts ni lógica semántica de los agentes: cada adaptador recibe un contexto tipado y devuelve el contrato de su etapa. En esta fase solo se ejecuta el arnés offline; no se llama a Groq y no se publican artículos.

```text
Discovery → Extraction → Clustering
                         ↓ 1..N eventKey
Verification → Translation → Editorial → Classification → Geo
                                                        ↓
                                             Ranking → Critic → Publisher
                                                               ↓
                                                  dry-run write plan
```

Después de clustering, `eventKey` es la unidad de trabajo. Los eventos se ordenan de forma determinista por la fecha publicada más antigua disponible y, en empate, por `eventKey`. No se usa una importancia futura para ordenar antes de Ranker.

## Máquina de estados

El run y cada etapa usan estados explícitos:

```text
PENDING → RUNNING → SUCCESS
                  ├→ SKIPPED
                  ├→ FAILED
                  └→ BLOCKED
```

Cada etapa registra `not_started`, `running`, `success`, `skipped` o `failed`, además de inicio, fin, duración, requests realmente usados, checkpoint y error sanitizado. El estado global no es `FAILED` solo porque un evento independiente haya sido omitido; el resultado distingue `SUCCESS`, `SUCCESS_WITH_FAILURES`, `BLOCKED_BUDGET` y `FAILED`.

## Routing por evento

- `Verifier` con `verifiedFacts.length === 0`: `SKIPPED_VERIFICATION_INSUFFICIENT`. No se llaman etapas posteriores.
- `Verifier` `rejected`: `SKIPPED` con `VERIFICATION_REJECTED`.
- Error técnico de cualquier etapa: `FAILED`, se detiene ese evento y los demás pueden continuar.
- Critic `pass`: el evento puede llegar a Publisher.
- Critic `revise_*`: `BLOCKED` con `revisionRequired=true`; se guarda `revisionStage` y no hay loop automático.
- Critic `reject`: `BLOCKED_REJECTED`; Publisher no se ejecuta.
- Publisher en modo por defecto: `READY_FOR_PUBLICATION_DRY_RUN`, con cero writes.

Un evento bloqueado o fallido no aborta automáticamente a los siguientes. La ejecución downstream es secuencial por evento; no se procesa concurrencia LLM en 10A.

## Checkpoints y lineage

Los adaptadores de Verifier, Translator, Editor, Classifier, Ranker y Critic deben devolver una operación `checkpoint` que escriba y relea el checkpoint existente de su etapa. El orquestador exige que esa operación confirme escritura, lectura, validación y el mismo `eventKey`. Si falta, falla o contiene otro evento, el evento queda `FAILED` con `checkpoint_failed` y no avanza.

No se materializan checkpoints históricos ni se reconstruyen salidas anteriores. Publisher no requiere checkpoint posterior: su salida es un plan de escritura efímero en esta fase.

## Presupuesto y cuota

El orquestador reutiliza el ledger persistente provider-scoped mediante `PipelineQuota`; en esta composición el pipeline LLM se ejecuta solo con Groq, por lo que la admisión del run es explícitamente `provider=groq`. No crea un segundo contador ni reserva seis requests por adelantado. El cap canónico de requests Groq admite hasta 1.000/día; `AGENT_DAILY_REQUEST_LIMIT` es un fallback legado Groq-only con default conservador 20. Con soft ratio 0,85, el umbral se deriva dinámicamente. La política de capacidad de 10G.7a.5 añade el ledger atómico de tokens por etapa y una proyección N=1+25% para el router/capacity snapshot; no cambia la ejecución del scheduler. `remainingRequestsRequired(stage)` centraliza el peor caso normal:

```text
antes de Verifier: 6
antes de Translator: 5
antes de Editor: 4
antes de Classifier: 3
antes de Ranker: 2
antes de Critic: 1
Publisher: 0
```

La comprobación solo decide si existe margen suficiente en el ledger Groq; no representa ni combina Neurons Cloudflare. El runtime y el router mantienen snapshots separados por proveedor. Cada agente sigue reservando justo antes de su request real y el resultado suma `providerRequestsUsed`, no las reservas liberadas ni las etapas deterministas. Si no hay margen, el evento queda `BLOCKED_INSUFFICIENT_DAILY_BUDGET` sin llamar a un agente.

No existe fallback de proveedor ni retry global. Los retries pertenecen exclusivamente al runtime/agente que los declare; el orquestador nunca reejecuta una etapa fallida.

## Persistencia y observabilidad

`createLoggerPipelinePersistence` reutiliza `agent_runs` y `agent_logs` para un run padre del orquestador. Registra transiciones como `EVENT_STARTED`, `*_SUCCESS`, `*_FAILED` y `VERIFICATION_SKIPPED`, junto con claves, códigos sanitizados, attempts y requests; no guarda cuerpos completos, prompts, reasoning ni secretos.

No se necesita migración: el esquema actual de `agent_runs`/`agent_logs` admite el run padre y sus logs.

## Modos seguros

La configuración por defecto es `dryRun=true`, `publish=false`. Un write solo es elegible cuando existe la señal explícita `publish=true` y el modo no es dry-run; `undefined` nunca se interpreta como autorización. La integración con el Publisher reutiliza su gate del Critic, `PublicationPayload`, validaciones, lineage y write plan.

## Pruebas offline

`npm run pipeline:unit` usa `lib/agents/pipeline/pipeline-fixtures.ts` y no instancia proveedores. Cubre:

- happy path y Publisher dry-run;
- skip de Verification sin hechos;
- fallo de Translator, Editor, Classifier y Ranker;
- Critic revise y reject;
- checkpoint ausente/fallido y lineage stale;
- presupuesto insuficiente y presupuesto exacto;
- contabilidad de requests y ausencia de retries globales;
- aislamiento multi-evento: un evento falla y otro continúa;
- default `publish=false`.

El comando de ejecución real se conectará en una fase posterior, cuando existan adaptadores de pipeline que construyan inputs y checkpoints a partir de las implementaciones de cada agente. En 10A no se ejecuta ningún pipeline real.

## Límites deliberados

No se implementan loops de revisión automáticos en vivo, scheduler, cron, publicación real, UI conectada, RLS ni cambios en los agentes semánticos.

## Fase 10B — Revision orchestration

La revisión está modelada como un plan determinista, pero `automaticRevision` es `false` por defecto. En consecuencia, una decisión `revise_*` del Critic bloquea el evento con `BLOCKED_REVISION_REQUIRED`, conserva el resultado histórico y no realiza nuevas llamadas al modelo. La ejecución automática queda preparada para una fase posterior, sin activarse por configuración implícita.

El máximo de intentos automáticos por evento es `maxRevisionAttempts=1`. Si un Critic posterior vuelve a pedir revisión cuando ya se consumió ese intento, el estado es `BLOCKED_REVISION_LIMIT`; no se convierte en aprobación ni en rechazo editorial.

### Rutas, invalidación y coste

| Decisión del Critic | Etapas que se volverían a ejecutar | Checkpoints invalidados | Checkpoints preservados | Peor caso |
| --- | --- | --- | --- | ---: |
| `revise_verification` | verifier → translator → editor → classifier → geo → ranker → critic | verifier, translator, editor, classifier, ranker, critic | ninguno | 6 |
| `revise_translation` | translator → editor → classifier → geo → ranker → critic | translator, editor, classifier, ranker, critic | verifier | 5 |
| `revise_editorial` | editor → classifier → geo → ranker → critic | editor, classifier, ranker, critic | verifier, translator | 4 |
| `revise_classification` | classifier → geo → ranker → critic | classifier, ranker, critic | verifier, translator, editor | 3 |
| `revise_ranking` | ranker → critic | ranker, critic | verifier, translator, editor, classifier | 2 |

`geo` es una etapa derivada del resultado de clasificación y no tiene checkpoint independiente. Los costes se calculan mediante el mismo presupuesto del runtime; no se crea un contador paralelo ni se reservan requests por anticipado. Si el margen restante no cubre el peor caso de la ruta, el plan queda `BLOCKED_INSUFFICIENT_DAILY_BUDGET` antes de llamar al proveedor.

### Lineage y protección contra datos stale

Los checkpoints de una revisión se identifican por `runId`, `eventKey`, `revision-N` y etapa. La ruta lógica es:

```text
artifacts/pipeline-checkpoints/<runId>/<eventKey>/revision-<N>/<stage>.json
```

Los checkpoints anteriores no se sobrescriben ni se borran. El Publisher solo puede usar el conjunto completo de checkpoints de la revisión más reciente y con el mismo `revisionAttempt`; una mezcla, ausencia o etapa stale produce `STALE_REVISION_CHECKPOINT` o `INCOMPLETE_REVISION_CHECKPOINT_SET` y bloquea la publicación.

El `RevisionLineage` conserva el `revisionId`, el evento, el intento, la decisión que lo originó y la lista de checkpoints preservados/generados. Esto permite auditar la cadena sin mezclar resultados de eventos o revisiones distintas.

### Estados de una revisión

```text
PLANNED → RUNNING → COMPLETED
                  └→ FAILED
```

La planificación actual termina en `BLOCKED_REVISION_REQUIRED`; no hay transición automática a `RUNNING`. Una futura ejecución deberá iniciar la revisión con un `revisionId` nuevo, comprobar presupuesto y lineage, y fallar cerrada si cualquier etapa no produce un checkpoint compatible.

Las pruebas `npm run pipeline:revision:unit` cubren las cinco rutas y sus costes, precedencia, preservación/invalidez, presupuesto insuficiente, límite de segundo intento, aislamiento multi-evento, paths de lineage y el gate de Publisher para la revisión más reciente. No realizan llamadas a Groq.
