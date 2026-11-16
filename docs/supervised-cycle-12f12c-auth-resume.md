# 12F.12C — autenticación de preflight y Critic pendiente

Fecha UTC observada: 2026-10-20. Clasificación primaria: **INSUFFICIENT_EVIDENCE**.
READY FOR HUMAN ACTION: **NO**.

## OBSERVE — resultado y límite de la evidencia

Las cuatro solicitudes de la matriz autorizada devolvieron HTTP 200, sin código,
message, details ni hint de error PostgREST. Se probaron status y list de M32
primero con una instancia del helper usado en 12F.10C y después con otra instancia
del helper usado en 12F.12B. Es el mismo constructor en ambos casos.

No se reprodujo PGRST303. La evidencia de 12F.12B conservó únicamente ese código;
no conservó HTTP status, message, details ni hint. No es posible recuperar su
subcausa exacta. El caso histórico «JWT issued at future» es una hipótesis
compatible, no una explicación demostrada de 12F.12B.

La clasificación no atribuye un fallo al secreto, a los permisos, al schema ni
al estado del intento. Tampoco prueba una causa temporal remota.

## PLAN — decisión y alcance

El bloqueo de autenticación es IMPORTANT para el recorrido operativo. La regla
de Part L exige causa probada y corrección local validada antes del preflight
completo; Part P exige todos los gates antes del resume. Esas condiciones no se
cumplen aunque la matriz actual funcione. Se detuvo el recorrido antes de leer
el intento, inspeccionar su snapshot, calcular TPM o reclamarlo.

No se cambió código de producción: no hay una causa de construcción probada que
justifique sustituir el cliente. No se rotaron credenciales ni se ampliaron ACL.
Migration required: NO. Migrations applied: 0.

## Inventario de clientes

| Archivo / función | Uso y construcción |
| --- | --- |
| lib/supabase/server-client.ts / createSupabaseServerClient | Única fábrica privilegiada compartida; lee NEXT_PUBLIC_SUPABASE_URL y SUPABASE_SECRET_KEY en cada llamada. |
| lib/supabase/server.ts | Reexporta la misma fábrica con import server-only. |
| scripts/supervised-pipeline-run.ts / main | Crea el cliente e inyecta la instancia en producción y scheduler. No ejecutado. |
| lib/agents/pipeline/create-production-pipeline.ts / createProductionPipeline | Usa options.supabase o la misma fábrica; inyecta la instancia en servicios. No ejecutado. |
| lib/agents/pipeline/event-attempt-repository.ts / SupabasePipelineEventAttemptRegistry | Cliente inyectado; SELECT filtrado de snapshot; claim/defer/release M35. No ejecutados. |
| lib/agents/runtime/agent-logger.ts / SupabaseAgentLogger | Cliente inyectado o misma fábrica; operaciones M35/M36. No ejecutadas. |
| lib/agents/publisher/human-review-read-repository.ts / SupabaseHumanReviewReadRepository | server-only; cliente inyectado o misma fábrica; RPC M32 status/list/inspect. |
| scripts/supervised-cycle-readonly-12f10.mjs y ...12f10a.mjs | Mismo helper para lecturas. |
| scripts/tpm-bootstrap-readonly-12f9a.mjs | Mismo helper para accounting. |
| 12F.10C instrumentado / evidencia JSON y documento retenidos | Mismo helper; GET privado HTTP 200. El harness temporal no está retenido. |
| 12F.12B / evidencia JSON y documento retenidos | Mismo helper; paging amplio de attempts; PGRST303 sin cuerpo retenido. Harness temporal no retenido. |
| lib/public-content.ts / createPublicContentClient | Cliente independiente para contenido publicado con publishable/anon; no usado por este preflight. |

Los validadores históricos que construyen clientes directamente para comparar
roles públicos/privados no forman parte del runtime supervisado ni del resume.

## Comparación exacta de los recorridos retenidos

Constructor, variables, opciones auth, ausencia de headers globales explícitos y
loader coinciden. No hay singleton de cliente privilegiado a nivel de módulo.
La fábrica lee variables después del bootstrap y en cada construcción.

10C terminó usando un GET filtrado por attempt/event/pipeline; 12B empezó con
paging amplio select("*"). La forma de SELECT difiere; no demuestra una causa de
validación JWT ni un problema de privilegios. Tampoco existe material retenido
para comparar los valores secretos históricos.

El SDK instalado genera apikey con la Secret key y, sin sesión, Authorization
mediante su fallback Bearer. Las cuatro solicitudes instrumentadas confirmaron
igualdad con la variable server-side mediante booleanos; ningún header se guardó.
No hubo cookie. auth.persistSession, autoRefreshToken y detectSessionInUrl son
false; no se suministra adaptador SSR/cookies, storage ni headers globales.

Se revisaron SupabaseClient._getSessionToken y fetchWithAuth del SDK instalado.
La fábrica devuelve el cliente mutable del SDK: no se ha demostrado un contrato
absoluto que impida invocar auth o sustituir Authorization deliberadamente.
No se encontraron esas operaciones en los recorridos privilegiados revisados.
La fábrica tampoco valida el formato si alguien pone una clave pública dentro de
SUPABASE_SECRET_KEY. Son límites de garantía, no causas probadas de PGRST303.
No se presentan las nueve garantías solicitadas como completamente cumplidas.

## Entorno y sesiones

Proceso nuevo: node --env-file-if-exists=.env.local, antes de evaluar módulos.
Sin ese loader, las cinco variables auditadas están ausentes en el entorno
heredado de un proceso nuevo. Con él:

| Variable | Estado |
| --- | --- |
| SUPABASE_URL | ABSENT; no la usa la fábrica |
| NEXT_PUBLIC_SUPABASE_URL | PRESENT |
| SUPABASE_SECRET_KEY | PRESENT; clase Secret key |
| NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY | PRESENT; no sustituye la Secret key |
| NEXT_PUBLIC_SUPABASE_ANON_KEY | ABSENT |

Los valores presentes coinciden con .env.local; solo se guardó la igualdad
booleana, sin valores, fragmentos ni fingerprints de secretos. .env.local está
ignorado por Git. Node da precedencia al entorno heredado, pero no se observó
una sustitución heredada en esta ejecución. Next build carga .env.local por su
propio bootstrap; no implica un singleton creado antes de cargar variables.

## EXECUTE — matriz remota acotada

| Cliente | RPC | HTTP | PostgREST |
| --- | --- | --- | --- |
| Helper de 10C, instancia nueva | M32 status | 200 | NONE |
| Misma instancia | M32 list | 200 | NONE |
| Helper de 12B, instancia nueva | M32 status | 200 | NONE |
| Misma instancia | M32 list | 200 | NONE |

Son RPC existentes de solo lectura y service_role. El script permite únicamente
esos dos endpoints POST en el origen configurado y cuatro solicitudes como
máximo. No hay retry automático del diagnóstico. Ahora rechaza repetir la
ejecución cuando ya existe su artefacto. La matriz se ejecutó remotamente una vez.
No se consultó pipeline_event_attempts ni se llamó inspect: el gate de causa
probada no se alcanzó.

## Contrato de lectura y cliente canónico

Se reutilizó createSupabaseServerClient; no se añadió otra fábrica privilegiada.
M32 resuelve lecturas de reviews. El método existente loadCapacityResumeSnapshot
lee el snapshot con filtros de linaje, mediante SELECT service_role ya soportado
por el contrato conocido. Ninguna RPC mutadora M35 sirve como lectura de prueba.
No se solicitó un permiso nuevo ni se creó M37.

El helper compartido sigue sin cambios. No se declara implementada una
sustitución endurecida ni resuelta la causa intermitente.

## Intento, baseline y capacidad

Intento: 4658d5c0-857c-4ed5-b97f-afb133b2bf22.
Evento: event-5c7d0ef5ea6f72bec96704aded750851.
Pipeline: f7b27a2c-dfdd-426b-98b8-b4756b0bbf9d.

El último estado confirmado por 12F.12A, el 17 de octubre, es
DEFERRED_PROVIDER_CAPACITY, Critic, generación 1, cinco checkpoints previos y
Critic ausente. Baseline histórico: attempts 19; active/deferred/stuck 0/1/0;
reviews/WAITING 0/0; public 2; Astra archivado; unknown reservations 0.

Nada de ese baseline se revalidó remotamente en 12F.12C. No se presenta como
estado actual observado. TPM actual: NOT_EVALUATED. Los 8365 tokens acumulados
históricos no se trasladaron a una ventana TPM actual.

Claim 0. Resume 0. Reruns Verifier/Translator/Editor/Classifier/Ranker 0.
Critic dispatch 0; decision NONE. Sin nuevo checkpoint, proof M34 o review.
M32 status/list: PASS en la matriz; inspect NOT_RUN.
M34/M35/M36 remotos y scheduler: NOT_REVALIDATED.

Acumulado histórico, sin revalidar: cinco reservas/despachos, 6748 tokens de
entrada, 1617 salida, 8365 total; cap 18. Delta de esta fase: 0 en todos esos
campos. Provider calls, retries, fallback, Cloudflare y Cerebras: 0.
No nuevas ejecuciones diarias, triggers, attempts, acciones humanas ni writes
remotos. Publisher NOT RUN. Public/fingerprints actuales: NOT_REVALIDATED.

## CRITIQUE y VERIFY

El diagnóstico distingue autenticación actualmente funcional de causa histórica
resuelta. No usa el HTTP 200 actual para dar por cerrado PGRST303 ni para saltar
el gate exigido. No introduce un fix especulativo.

Las cuatro pruebas nuevas son offline y usan fetch simulado en procesos nuevos:
lecturas secuenciales correctas sin cookies; cuerpo PGRST303 y redacción; ausencia
de secreto falla antes de la red pese a existir variable pública; artefacto
existente evita repetir el diagnóstico. Cero solicitudes de red reales.

Pasaron las quince suites offline detalladas en
artifacts/supervised-cycle-12f12c-offline-tests.json: M35, generación, checkpoints
durables/resume desde Critic, M36, admisión Groq normal/resume, bootstrap TPM,
token budget, schema/checkpoint Critic, revisión/semántica, M34, M32 y human review.
Estos resultados no sustituyen los invariantes remotos no revalidados.

Lint, TypeScript, build y git diff --check: PASS (exit 0). El build conserva el
warning ya conocido de NEXT_PUBLIC_SITE_URL ausente/inválida; metadata de
indexación desactivada. Diff check mostró avisos LF/CRLF de archivos previamente
modificados, sin errores de whitespace. Safe secret audit: PASS, 913 archivos,
0 archivos con hallazgos, env_local_ignored=true.
Verificación visual: no aplicable; no se modificó producto visual.

## Cierre

Estado de la fase: detenida en ROOT_CAUSE_NOT_PROVEN.
Clasificación: INSUFFICIENT_EVIDENCE.
El estado durable del intento no se cambió ni se finalizó como TECHNICAL_FAILURE.
READY FOR HUMAN ACTION: NO. No se ejecuta otro diagnóstico remoto ni un resume.
