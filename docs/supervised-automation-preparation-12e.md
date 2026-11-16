# 12E — Preparación de automatización supervisada

**Resultado: 12E READY = NO.** La ruta de lectura privada volvió a funcionar y se confirmó con lecturas repetidas. La preparación se detuvo en el gate de aprobación: el esquema actual no conserva de forma durable el paquete que revisaría una persona, las decisiones approve/reject/hold ni el consumo de aprobación ligado a la publicación. Se preparó una única migración y no se aplicó. No se cambió código de ejecución.

La arquitectura V1 permanece congelada. No se reabrió Astra, no se activó el scheduler y no se publicaron ni alteraron artículos. Hubo cero llamadas a proveedores y cero escrituras de artículos.

## PRIVATE READ AUTH

Se repitió la lectura privada con el cliente normal `createSupabaseServerClient()` y una consulta de solo lectura a `pipeline_event_attempts`.

- Primera lectura: **HTTP 200**, `2026-10-05T19:27:43.590Z` local UTC antes de consultar; respuesta `Date: Mon, 05 Oct 2026 19:27:45 GMT`; sin código de error.
- Después se ejecutaron tres rondas secuenciales. Las 24 respuestas PostgREST fueron HTTP 200 y todas tuvieron cabecera `Date`.
- La clave actualmente seleccionada es la variable `SUPABASE_SECRET_KEY`, cargada desde `.env.local` por `node --env-file-if-exists=.env.local`; el cliente usa `NEXT_PUBLIC_SUPABASE_URL`. No se imprimió ningún valor secreto. El formato observado es `sb_secret_…`, no un JWT directo. La última escritura de `.env.local` registrada precede a la falla de 12D; las variables de proceso/usuario/máquina no estaban definidas en esta ejecución.
- Hora local observada: `2026-10-05T19:26:26Z`; cabeceras `Date` del servicio durante la repetición: `2026-10-05 19:31:14–19:31:17 GMT`. No hay evidencia de desfase del reloj local.

Las lecturas de las tres rondas fueron consistentes: 8 intentos en la tabla; dos intentos para el evento Astra, con el segundo en `TECHNICAL_FAILURE` y continuación `STOPPED`; artículo Astra `archived`; dos artículos con estado `published`; contabilidad Groq del día: 1 solicitud despachada, 75 tokens y uso conocido; 153 `agent_runs`; último `scheduler_run` bloqueado, con `dry_run=true`, `publish=false` y máximo de un evento.

Inventario de rutas de autenticación:

- Runtime server, pipeline, repositorios y scheduler: `NEXT_PUBLIC_SUPABASE_URL` + `SUPABASE_SECRET_KEY`, mediante `lib/supabase/server-client.ts`.
- Scripts e integraciones de validación que importan el cliente compartido: las mismas variables; los comandos npm de ejecución cargan `.env.local`.
- Algunas rutas antiguas de REST directo (`supabase-incident-article-lifecycle-repository.ts`, script de archivo y validaciones históricas) permiten `SUPABASE_URL` como URL alternativa y `SUPABASE_SERVICE_ROLE_KEY` como alternativa de secreto. Esas alternativas no fueron seleccionadas por el cliente que se probó.
- Lecturas públicas: `NEXT_PUBLIC_SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (con `NEXT_PUBLIC_SUPABASE_ANON_KEY` como compatibilidad), limitadas por el contrato público/RLS.
- Netlify protege la entrada del trigger con `SCHEDULER_TRIGGER_SECRET`; la ejecución interna usa el cliente privado compartido.
- Supabase CLI es una ruta distinta: sesión/token del CLI o `SUPABASE_ACCESS_TOKEN`, enlace de proyecto y credencial SQL. No se ejecutó `db push`, SQL remoto ni CLI en 12E. El `28P01` histórico del preflight SQL temporal no es el error PostgREST de la lectura privada.
- `AGENT_API_KEY` es una credencial de proveedor de modelos, no de Supabase.

## PGRST303 ROOT CAUSE

El registro de 12D conserva `PGRST303: JWT issued at future`, pero no guarda el estado HTTP, cabecera `Date`, variable efectiva en aquel proceso ni metadatos seguros del JWT (algoritmo, `iat`, `exp`). Por ello **no es posible atribuir con certeza la causa histórica exacta**. La respuesta actual no reprodujo el error: el runtime selecciona una clave Supabase de formato `sb_secret_…` y respondió correctamente en 25 de 25 solicitudes privadas observadas.

La evidencia descarta un desfase local actual y no muestra que `.env.local` se modificara después de la revisión 12D. Es compatible con un rechazo transitorio del JWT interno que valida PostgREST o con un contexto de credenciales distinto en el proceso de 12D; no hay evidencia para distinguir esas dos posibilidades. La ruta privada segura está restaurada y verificada; **no se requiere rotación de credenciales**. No se rotaron ni regeneraron claves.

## SUPERVISED FLOW

Flujo V1 objetivo:

`Discovery → Extraction → Clustering → Verifier → Translator → Editor → Classifier → Ranker → Critic → WAITING_FOR_HUMAN_REVIEW → HUMAN APPROVAL → deterministic Publisher`

El flujo actual no tiene el estado durable de espera. El orquestador llega a la etapa Publisher; `publish=false` convierte esa etapa en `Publisher.preview`, pero no crea una cola revisable. Con publicación habilitada, el repositorio llama directamente a `publish_article_atomic`.

## HUMAN REVIEW CONTRACT

El paquete previo a aprobación debe guardar el titular, resumen, “Por qué importa”, borrador, fuentes/URLs, resultado de Verifier, atribución e incertidumbre, decisión y hallazgos de Critic, clasificación, región/geografía, score de Ranker y estado de contabilidad.

La decisión APPROVE debe guardar event key/ID estable, attempt ID, identidad del borrador, hashes de los checkpoints Verifier/Translator/Editor/Classifier/Ranker/Critic, huella de linaje de fuentes, reviewer, hora del servidor y cada confirmación factual/editorial. El esquema actual no tiene una entidad para almacenar este paquete o esa aprobación. Antes de publicar debe confirmar facts, atribución, incertidumbre preservada, titular, resumen, ausencia de afirmaciones materiales sin sustento y cadena de fuentes.

Las acciones REJECT y HOLD no publican. REJECT es terminal para el intento; HOLD puede recibir posteriormente una decisión humana explícita sobre el mismo paquete. Ninguna acción inicia reintentos.

## APPROVAL GATE

**No implementado en código.** La tabla `pipeline_event_attempts` conserva identidad/reintentos y un JSON `continuation` usado por la remediación factual; no almacena borradores ni approvals editoriales. `agent_runs` conserva configuración/estadísticas y `agent_logs` conserva telemetría, no el cuerpo de cada etapa. Los checkpoints actuales se escriben en `artifacts/pipeline-checkpoints/<runId>` en el filesystem local, que no es una cola durable del runtime Netlify.

El publisher normal invoca directamente el RPC existente, que solo comprueba el resultado de Critic y la estructura de publicación; no comprueba una aprobación humana, factual, de atribución ni de un solo uso. Un booleano en memoria o en la lógica del scheduler permitiría bypass y reutilización. La condición de parada de la instrucción 13 se cumple: se preparó una migración durable y no se continuó con el gate de aplicación.

La migración preparada en [20261005194000_supervised_human_review_gate.sql](../supabase/migrations/20261005194000_supervised_human_review_gate.sql) crea `pipeline_human_reviews`, el estado de intento `WAITING_FOR_HUMAN_REVIEW`, RPC server-only para crear paquete y decidir APPROVE/REJECT/HOLD, y un wrapper transaccional de publicación que compara identidades/hashes, verifica Critic/contabilidad/linaje, consume una vez la aprobación y usa el payload guardado. Revoca la ejecución directa del RPC base al rol `service_role`; las rutas security-definer específicas de la remediación factual conservan su límite existente. Es un borrador preparado: no se ha aplicado ni validado contra una base remota, y todavía no existe el cliente TypeScript que lo utilice.

## STALE APPROVAL

**No está bloqueada en el runtime actual porque no existe aprobación que consumir; la política aún no está implementada.** El diseño preparado vincula la aprobación al attempt, run, borrador exacto, hashes de checkpoints y linaje de fuentes. La publicación guardaría el payload revisado en la fila y compararía hashes actuales; cambios de identidad o de material bloquean el RPC. La actualización de hashes y el consumo atómico requieren validación en 12E.1.

## SCHEDULER MODE

**Modo SUPERVISED no implementado; scheduler de producción no activado.** `netlify/functions/scheduler-trigger.ts` entra por un secreto server-side y llama a `runSchedulerTrigger()`, que ejecuta solo preflight. El bridge de ejecución actual exige namespace `test:*`, reclama un lease, limita a un evento y fija `dryRun=true`, `publish=false`, `automaticRevision=false`. No invoca un publisher de producción y no se activó.

La ruta supervisada deberá terminar tras Critic, guardar la cola y soltar el lease antes de Publisher. El Publisher solo se invocará por acción explícita de operador después de una aprobación válida. Un candidato fallido debe cerrar su intento sin afectar otro candidato.

## INITIAL LIMITS

Objetivo conservador: 3 candidatos/día, máximo 2 publicaciones/día, concurrencia 1, 0 reintentos de etapa, 0 fallback, Cloudflare OFF, Cerebras OFF y remediación factual automática OFF.

En el código actual, el bridge de ejecución es un evento por ejecución y hay lease/concurrencia efectiva 1 para esa ruta. No existe un límite durable de 3 candidatos/día ni 2 publicaciones/día. Las configuraciones de agentes usan `AGENT_MAX_RETRIES` con valor por defecto 2, así que el requisito de cero reintentos no está satisfecho. La contabilidad de proveedor ya usa `agent_logs` y bloques por uso desconocido; las decisiones de scheduler aún no están en modo supervisado. Cloudflare continúa sin enrutamiento productivo; Cerebras y fallback pagado permanecen excluidos.

## OPERATOR WORKFLOW

No existe comando usable de producción para listar, aprobar, rechazar o retener un borrador. La acción futura debe ser un CLI/script server-side sobre los RPC de la migración, con operador explícito; nunca una escritura SQL manual o un endpoint anónimo. Debe mostrar event/attempt, estado de espera, borrador y fuentes, Critic, verificaciones factual/atribución, preparación de publicación, contabilidad y acciones disponibles. Ese CLI/API y la vista del paquete quedan pendientes porque la migración no se ha aplicado.

## OBSERVABILITY

Hay registros de intentos, `agent_runs`, telemetría de `agent_logs`, contabilidad de proveedor y `scheduler_runs`; las consultas privadas repetidas funcionaron. La contabilidad de hoy fue consistente (1/1 requests, 75 tokens conocidos, cero desconocidos). El operador puede consultar ejecuciones, intentos, consumos y bloqueos técnicos con scripts existentes, pero no hay lista durable de pendientes de revisión ni decisiones REJECT/HOLD/APPROVE. No puede responder qué necesita aprobación porque esa cola aún no existe. No se creó dashboard.

## SECURITY

El contrato anónimo actual sigue exponiendo solo artículos publicados: en las tres rondas privadas el conteo `published` fue 2 y Astra siguió archivado; la lectura pública anónima de 12D también confirmó dos artículos y ausencia de Astra. La tabla propuesta tendrá RLS, sin grants directos para `anon`, `authenticated` o `service_role`; las funciones de revisión/publicación se concederán a `service_role` y validarán `auth.role()`. Las aprobaciones no serán visibles ni editables desde el cliente público.

## AUTOMATIC REMEDIATION POLICY

**OFF.** No se invocó ni reabrió el flujo de remediación Astra. Si aparece un problema factual, el manejo previsto es hold/archive, revisión humana y escalación; no un ciclo automático de remediación.

## ONE-EVENT VALIDATION

**No ejecutada en 12E.** Las pruebas offline existentes de orquestación, scheduler y Publisher pasaron salvo la suite histórica indicada en TESTS, pero no existe una implementación que produzca `WAITING_FOR_HUMAN_REVIEW`. No se creó ni aprobó un paquete sintético; no se hizo una publicación local o remota. Esta validación depende de la migración y del código que todavía no se implementó.

## TESTS

- Suites offline: **56/57 PASS**. Falló `pipeline:factual-remediation:final-resume:unit`: su guarda histórica requiere que no existan migraciones locales posteriores a la evidencia remota de migration 30. La migration 12E preparada, que no está aplicada, activa deliberadamente esa guarda. No se modificó ni debilitó la prueba; no se ejecutó ni autorizó una continuación Astra.
- Suites dedicadas: scheduler execution/wiring, Publisher/readiness y contrato público pasaron dentro de las suites offline.
- Fixtures estáticos existentes de migrations 29 y 30: **PASS**.
- Pruebas nuevas de aprobación supervisada: **NO IMPLEMENTADAS / NO EJECUTADAS**, porque el almacenamiento durable es el bloqueo que requiere migración.
- `npm run lint`: PASS.
- `npx tsc --noEmit`: PASS.
- `npm run build`: PASS (Next.js 16.3.4).
- `git diff --check`: PASS; Git mostró avisos de conversión LF/CRLF en archivos preexistentes.
- La migración nueva no se compiló ni aplicó contra PostgreSQL. Requiere revisión sintáctica y validación remota en 12E.1.
- Llamadas a proveedores/modelos: 0. Escrituras remotas de artículos: 0. Migraciones aplicadas: 0. Activación de scheduler: NO.

## READINESS

| Requisito 12E | Estado |
|---|---|
| Lectura privada confiable | PASS; 25/25 respuestas HTTP 200 en las lecturas realizadas |
| Causa histórica exacta PGRST303 | No demostrable con la evidencia guardada; ruta segura actual restaurada |
| Rotación de credenciales | NO requerida |
| Flujo y cola de aprobación humana | NOT IMPLEMENTED |
| Revisión factual y atribución obligatorias | Diseñadas en el contrato/migración; no exigibles por el runtime todavía |
| Publisher sin aprobación bloqueado | FAIL / no hay gate; activación productiva permanece OFF |
| Aprobación obsoleta bloqueada | NOT IMPLEMENTED en runtime |
| Scheduler supervisado | NOT READY; bridge actual de prueba/preflight |
| Límites 3 candidatos / 2 publicaciones / concurrencia 1 | Solo la concurrencia 1 existe en el bridge de prueba; los límites diarios no están implementados |
| Cero reintentos | FAIL; los agentes permiten hasta 2 por defecto |
| Fallback / Cloudflare / Cerebras | OFF |
| Contrato público | Sin cambios; 2 artículos publicados y Astra archivado |
| Migration requerida/preparada/aplicada | SÍ / un borrador / NO |
| Pruebas y build | 56/57 suites; lint, TypeScript, build y diff check PASS |

## NEXT STEP

**12E READY: NO.** Siguiente: **12E.1 — aplicar y validar remotamente la migración de aprobación supervisada**, con cero llamadas a proveedores. Esa fase debe revisar/validar este borrador, aplicarlo y después completar la integración del estado WAITING, comandos del operador y hard gate de Publisher con pruebas sintéticas antes de empezar un ciclo real 12F. No activar scheduler recurrente. Límite inicial en 12F: un candidato con aprobación humana.
