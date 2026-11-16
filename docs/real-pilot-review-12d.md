# 12D — revisión del piloto real y preparación de automatización supervisada

**Revisión: `READY YES` como evaluación basada en evidencia. Decisión: `GO_WITH_PRECONDITIONS`.** Esto autoriza preparar la operación en 12E; no activa un scheduler ni autoriza publicación automática.

No se hicieron llamadas Groq, Cloudflare, Cerebras ni otras inferencias; tampoco escrituras de artículos o intentos, migraciones, activaciones del scheduler o acciones de Netlify. El árbol ya contenía cambios y artefactos de fases anteriores; no se hizo commit.

## EXECUTIVE SUMMARY

El piloto ejercitó tres historias reales. Dos siguen públicas y el incidente factual Astra está archivado. La publicación del Astra falló editorialmente, pero el sistema de seguridad retiró la historia de la vista pública y detuvo su única continuación autorizada cuando el RPC rechazó el resume. Es un **resultado de seguridad fail-closed**, aunque no se recuperó el contenido.

La arquitectura del pipeline V1 puede congelarse. La calidad editorial y factual permite continuar **solo bajo revisión humana antes de publicar**. Accounting y capacity guards están suficientemente probados para ese modo. El scheduler todavía es de pruebas: exige namespace `test:*` y fija `dryRun=true`, `publish=false`. La lectura privada de estado devolvió `PGRST303` en esta revisión; hay que resolverla antes de ejecutar automatización supervisada.

| Área | Resultado |
| --- | --- |
| Intentos del piloto | 5/5; intento 6 ausente en el último readback privado exitoso |
| Llamadas Groq del piloto | 28/30; esta fase añadió 0 |
| Estado público | 2 historias públicas; 1 historia factual archivada |
| Editorial | `READY_WITH_LIMITATIONS` |
| Seguridad factual | `READY_WITH_LIMITATIONS`; los controles de estado fallan cerrado, la semántica no es infalible |
| Accounting del proveedor | `YES`, con límites de frescura y muestra reducida |
| Scheduler | `PRECONDITIONS`; no está listo para ejecución productiva |
| Arquitectura V1 | `FREEZE_V1_ARCHITECTURE: YES` |
| Automatización | `GO_WITH_PRECONDITIONS`, solo hacia preparación 12E |

## PILOT OUTCOMES

El historial documenta 19 llamadas en los tres recorridos originales de contenido. El quinto intento del piloto se consumió en la remediación factual: Verifier, Translator, Editor, Classifier y Ranker; Critic se bloqueó antes del despacho en esa ejecución. Las sondas autorizadas elevaron el contador final a 28/30. La capacidad de intentos está agotada: no se permite un intento 6.

La lectura anónima de `public_published_articles` del 5 de octubre a las 17:31:27 UTC confirmó 2 filas, los dos slugs enumerados en la matriz y ausencia del slug archivado. La vista pública excluye los IDs internos por diseño; los IDs de las dos historias se enlazan desde el artefacto canónico 12C. El intento de lectura privada mediante el cliente server a las 17:30:43 UTC devolvió `PGRST303: JWT issued at future`. Por ello, intento, continuación y dispatch Critic se informan desde el último readback privado exitoso de 12C.2B.2g.3a, cuyo artefacto posterior a la ejecución registra: 2 intentos del evento, piloto 5/5, continuación `STOPPED`, sin resume consumido, sin intento 6 y sin run/reserva/dispatch Critic V4. La limitación de frescura queda explícita; no se presenta como una lectura privada nueva de 12D.

| Resultado | Dato al cierre |
| --- | --- |
| Intentos piloto | 5/5; intento 6 ausente según el readback privado de 12C.2B.2g.3a |
| Llamadas Groq piloto | 28/30; 0 nuevas en 12D |
| Cloudflare / Cerebras / fallback pagado | 0 / 0 / ninguno |
| Historias públicas | 2 |
| Artículo archivado | 1; incidente Astra; no aparece en la vista pública |
| Scheduler, automatización, migraciones, Netlify | Sin activar / sin cambios |

## STORY MATRIX

| Historia / fuente / publicación | Etapas y resultado editorial | Estado factual y disposición |
| --- | --- | --- |
| **Agentes de OpenAI y UNCTADstat** — The Verge AI; artículo `6203559f-413a-4f06-9346-1720bbeb0e7a`, evento `c5575e04-85fb-4b5e-adbb-b3acc6368c4f`; slug `openai-emplea-agentes-para-escanear-el-sitio-de-estadisticas-de-la-onu-mas-de-16-000-veces`. Una fuente. | Verifier: `single_source`, confianza 80, dos hechos. Translator conserva el tema. Editor produce el titular español y el matiz “objetivo aparente”. Classifier: Empresas/Modelos y región `GLOBAL`; el defecto histórico de coordenadas se corrigió para usar el punto regional `(20, 0)`. Ranker: 49,3; momentum neutral. Critic: `pass`, sin issues en la revalidación final. Publisher tuvo primero `LOCAL_SCHEMA_VALIDATION_ERROR`; la recuperación normal validó y publicó mediante el Publisher determinista, sin escritura manual. | **PASS.** Síntesis atribuida y legible; revisión 12B.1 y revisión factual 12C no encontraron la escalada del incidente Astra. Sigue pública. |
| **Fallas de torres de vigilancia fronteriza** — MIT Technology Review; artículo `7415c685-04ed-4956-a77a-4bc372c9b060`, evento `d762aa9c-6be6-44f4-9761-ec21323e2722`; slug `mas-de-mil-fallecidos-tras-fallas-en-torres-de-vigilancia-fronteriza`. Una fuente. | Verifier: `single_source`, confianza 80, un hecho verificado. Translator conserva el tema del artículo fuente. Editor genera titular, resumen, “Por qué importa” y cuerpo en español. Classifier: investigación, `GLOBAL` con país `US`; Geo usa `(20, 0)`. Ranker: 50,9; momentum neutral. Critic: `pass`, sin issues. Publisher publicó la misma fila y slug de forma determinista. | **PASS_WITH_FINDINGS.** El resumen atribuye el reporte a MIT, pero la revisión 12C no pudo comparar la página primaria completa por restricciones de robots/suscripción. El cuerpo usa causalidad y lenguaje de eficacia más firmes que esa verificación disponible. Sigue pública; requiere revisión humana de claims antes de ampliar volumen. |
| **Astra 6.1 / seguridad de OpenAI** — TechCrunch AI, que atribuye detalles materiales al Wall Street Journal; artículo `756b0ee0-b5e6-4153-846f-278a12c9afe3`, evento `5138e509-f4c3-4020-9d13-6a6efac99a39`; slug `openai-suspende-el-lanzamiento-del-modelo-astra-6-1-por-cuestiones-de-seguridad`. Una fuente ingerida. | Verifier: `single_source`, confianza 70; perdió “reportedly” en el hecho verificado. Translator conservó “supuestamente” en el título, pero heredó el hecho ya endurecido. Editor quitó el calificador y añadió detalles de revisión interna y riesgos no mitigables sin respaldo. Classifier/Geo: `US`, coordenadas canónicas del registro. Ranker: 45,9; momentum neutral. Critic V3 real: `pass`, cero issues, aunque no recibió el extracto fuente necesario para verificar la atribución secundaria. Publisher publicó el contenido recibido sin reescribirlo. | **ARCHIVED_BY_SAFETY_SYSTEM.** La revisión posterior detectó pérdida de atribución e incertidumbre y detalles no sustentados. El artículo sigue archivado y fuera de la vista pública. La remediación del intento 5/5 terminó en `STOPPED_RESUME`; no se llamó a Critic ni Publisher después del rechazo. |

## EDITORIAL

**`EDITORIAL_READY_FOR_SUPERVISED_PRODUCTION: READY_WITH_LIMITATIONS`.** La historia de The Verge conserva fuente, fechas y formulaciones cautelosas en el resumen. La pieza MIT es clara y en español, pero no se validó el texto fuente primario línea por línea y su cuerpo contiene afirmaciones causales más fuertes. El artículo Astra demuestra que la aprobación automática de Critic no sustituye la revisión editorial.

Los dos registros públicos tienen titular, resumen, “Por qué importa”, cuerpo, fuente HTTPS y síntesis en español; no reproducen íntegramente el material fuente. Antes de cada publicación supervisada, una persona debe comparar el titular, cada afirmación material, la atribución de segundo nivel y los calificadores con la evidencia fuente. Revisar la historia MIT contra su fuente disponible antes de ampliar el piloto. Esta revisión 12D no cambió ninguno de los artículos.

## FACTUAL SAFETY

**`FACTUAL_SAFETY: READY_WITH_LIMITATIONS`.** El flujo falla cerrado en contratos estructurados, identidad/cobertura de evidencia, linaje, manifiesto, estado de archivo, ownership de continuación, dispatch, accounting y publicación atómica. La vista pública excluye artículos archivados; la prueba anterior confirmó 404 para el slug Astra.

La protección es real para fronteras y estados, no una garantía de juicio semántico correcto. Critic aprobó el Astra en ejecución real y solo después se agregaron el extracto de evidencia acotado, referencias tipadas y controles offline de atribución, incertidumbre y detalles no sustentados. Tres historias no bastan para estimar la tasa de falsos negativos de Critic. Mantener aprobación humana final.

Las migraciones 27–30 y sus RPCs fueron validadas históricamente con permisos de servicio, límites de intento, uso único, locking, concurrencia sintética, manifiesto semántico y guardas de Publisher. La migración 30 fue última y la 31 ausente en esa validación remota; los archivos locales 27–30 existen y el repositorio no contiene una 31. La fase g3 se detuvo antes del proveedor cuando la conexión SQL con rol temporal devolvió `28P01`; g3a no volvió a usar ese canal. 12D no hizo consulta de historial SQL ni modificación de esquema, así que migration state se presenta como evidencia histórica, no como un refresh de 12D.

## INCIDENT RETROSPECTIVE

La historia Astra pasó de un reporte TechCrunch que mantenía “reportedly” y atribuía detalles de pruebas al WSJ a una pieza que lo presentó como decisión confirmada. Verifier endureció la proposición; Translator conservó cautela en el título pero recibió hechos más firmes; Editor quitó el calificador y agregó revisión interna y riesgos imposibles de mitigar; Critic aprobó sin extracto textual suficiente; Publisher publicó la prosa aprobada sin alterarla.

**Resultado de contenido:** la historia corregida no se publicó y queda archivada para este piloto. **Resultado fail-safe:** el incidente se retiró del contrato público, su snapshot e historial se conservaron, las guardas de lifecycle rechazaron continuar en condiciones no verificadas y no se introdujo un bypass ni intento 6. No clasificar el archivado como un fallo de seguridad.

### Ya corregido

- Se endurecieron los prompts de Verifier, Translator y Editor para distinguir reporte directo, atribución secundaria y especulación; conservar atribución/incertidumbre y rechazar detalles internos sin respaldo.
- Critic recibe un extracto acotado con identidad, URL, hash y referencias de evidencia; los prechecks validan cobertura e identidad antes de inferir.
- Geo resuelve coordenadas desde la región semántica elegida y conserva el contrato estricto del Publisher.
- Se implementaron lifecycle, continuación y resume de un solo uso con permisos de servicio, locking, checkpoints y accounting; el comparador de manifests es canónico e independiente del orden de claves.
- Se corrigió la validación de delta de accounting para comparar baseline y post-probe, no totales absolutos.

### Limitaciones aceptadas y anomalía

El rechazo real `FACTUAL_REMEDIATION_CONTINUATION_RESUME_BLOCKED:INCIDENT_LINEAGE_OR_ARCHIVE_CHANGED` sigue sin causa raíz probada. La auditoría g1 encontró que las cinco ramas actuales de linaje pasan de forma determinista; el SQL y valores completos de la primera consulta histórica que devolvió falso no se conservaron. También se corrigió una omisión del preflight local que no comprobaba todos los enlaces raw/source; esto no demuestra que fuera la causa del rechazo original. No reinterpretar el rechazo como bug de RPC, carrera o error transitorio.

Esta anomalía bloquea **reanudar automáticamente la remediación factual del incidente**. No bloquea el pipeline normal para nuevas historias con su preflight, Critic y Publisher, siempre bajo revisión humana. El Astra queda terminalmente archivado para el piloto; no se propone otra remediación.

## PROVIDER ACCOUNTING

**`PROVIDER_ACCOUNTING_READY: YES` para el modo secuencial supervisado.** Antes del despacho, el runtime reserva request y tokens; registra el marcador de dispatch; después liquida uso real confiable. Si el uso posterior al dispatch es desconocido, conserva la reserva conservadora; si no puede leer o liquidar el ledger, bloquea. La reserva diaria es provider-scoped y utiliza caps RPD/TPD hard y soft. El pacing TPM requiere headers frescos del mismo evento/modelo y conserva 128 tokens de margen.

La sonda g3a quedó conciliada por el ledger: 74 tokens de entrada + 1 de salida = 75; delta `0/0/0 → 1/1/75`, reservas desconocidas `0 → 0`. El guard de Publisher exige un Critic `pass`, request despachada y usage real asentado. La validación remota sintética de migration 30 probó esas condiciones y sus rechazos; no es una calibración semántica del proveedor.

Limitaciones: la contabilidad diaria no sustituye el TPM en vivo; una lectura TPM caduca rápido. RPM 30 y TPD 200.000 proceden de confirmación del plan, mientras RPD/TPM también se observaron en headers. No hay load test ni limitador RPM distribuido para concurrencia mayor que uno. El límite y las admisiones actuales requieren un único evento a la vez.

## FREE CAPACITY

Límites FREE usados en la política: 30 RPM, 1.000 RPD, 8.000 TPM, 200.000 TPD; umbrales soft 850 RPD y 170.000 TPD. La muestra full-path Groq N=1 fue 6 requests y 10.347 tokens; el plan añade 25% y estima 12.934 tokens por candidato. En 12C, dos nuevos full paths consumieron 8.597 y 8.250 tokens cada uno, seis llamadas por evento.

Con el plan conservador, **10 candidatos full-path/día** proyectan 60 requests y 129.340 tokens: caben bajo ambos umbrales soft. Doce proyectan 72 requests y 155.208 tokens: también caben. Quince proyectan 90 requests y 194.010 tokens y exceden 170.000 TPD; el propio cálculo provisional admite 13 equivalentes, no 15.

Esto demuestra espacio para 10 candidatos bajo el estimador; **no demuestra 10 publicaciones seguras/día**. La conversión de candidatos a publicaciones seguras es desconocida, solo hubo tres historias y una terminó archivada después de detectar un fallo factual. Por tanto 10 publicaciones/día no es un objetivo operativo respaldado. Recomiendo empezar con 3 candidatos que entren al pipeline de modelo y máximo 2 publicaciones/día, secuenciales y revisadas. No se usa fallback pagado.

## CLOUDFLARE

**Cloudflare no es requisito para el lanzamiento.** `semanticQualityGateValidated=false` y `productionRoutingEnabled=false` siguen vigentes. Groq-only es aceptable para un volumen inicial bajo si las admisiones frescas pasan. Activar un segundo proveedor no resolvería por sí solo la escalada de certeza observada; mantener el router apagado.

## ACTIVITY HISTORY

**`POST_LAUNCH`.** Publisher no materializa agregados; no hay job de agregación. Home, artículos y mapa no dependen de `activity_history`; Ranker usa momentum neutral 50 cuando no hay historia. Definir owner, frecuencia y recálculo idempotente antes de prometer momentum como señal activa, no antes de publicar contenido.

## SCHEDULER

**`PRECONDITIONS`, no listo para producción.** El código tiene claim de trigger idempotente, lease persistente con owner/TTL, rechazo de duplicados y runs simultáneos, límite de un evento en el bridge actual, cuota dinámica, stop ante 429/fallo, release en `finally` y resúmenes compactos. Las pruebas offline cubren slots UTC/Madrid, lease, presupuesto, deduplicación, fallos y puente.

La frontera de ejecución todavía exige `test:*`, fija `maxEventsPerRun=1`, `dryRun=true`, `publish=false` y desactiva revisión automática. `netlify.toml` no declara cron; la function manual usa secreto server-side y no se ha activado. No hay evidencia de una ejecución productiva del scheduler ni de publicación desde él. El resume por checkpoints es un flujo factual independiente, no una capacidad de recuperación automática del scheduler. Para supervisarlo en producción falta una ruta explícita de un solo evento que incorpore aprobación humana antes de Publisher, verificación de quotas, logging y rollback/stop. No habilitarla en esta fase.

## OBSERVABILITY

Las tablas `pipeline_event_attempts`, `agent_runs`, `agent_logs`, `scheduler_runs` y el ledger permiten reconstruir etapa/estado, error code, proveedor/modelo, dispatch, uso y quota; los checkpoints y artefactos preservan snapshots e identidad. Un lease persistente permite distinguir un run activo de uno vencido. El Publisher y el contrato público permiten confirmar qué quedó visible.

Faltan una vista operativa consolidada, alertas de runs atascados y reservas desconocidas, y un resumen que conecte intento → run → logs → publicación sin consultar varias fuentes. Algunos runs históricos tampoco tienen fila remota `agent_runs` enlazada como cabría esperar; sus intentos y checkpoints siguen como evidencia. En esta pasada, `PGRST303` impidió la lectura privada fresca: esto es P0 para operar con seguridad hasta restablecer el acceso de lectura. Dashboard/alertas son P2 bajo el volumen manual inicial.

## FRONTEND

El read público actual confirma los dos artículos con título, resumen, “Por qué importa”, cuerpo, fuente HTTPS y categoría. La QA previa verificó Home, rutas de artículo, mapa/data contract, filtros y enlaces; `fuentes`, `metodologia`, páginas legales, empty/error/not-found y slug archivado 404 tienen evidencia en 11A/11B/12B.1/12C.2A. La build actual genera esas rutas estáticas y SSR de artículos/Home.

La QA 11B cubre tamaños 375–1920px, temas, teclado y click de mapa usando fixtures. 12B.1/12C no verificaron el contenido real actual con navegador en viewports, Tab/Enter y click/tap de mapa. No está probado el host canónico absoluto porque `NEXT_PUBLIC_SITE_URL` no estaba configurado en esa revisión. No se rediseñó el frontend.

No hay bloqueador funcional P0 observado. Antes del lanzamiento público: repetir QA responsive/accesible con las dos filas reales y confirmar el dominio canonical del entorno de hosting; revisar MIT en el mismo pase editorial.

## SECURITY

La evidencia remota previa confirma RLS en tablas base, acceso público limitado a views explícitas, y RPCs de lifecycle/Publisher/reservation disponibles solo para `service_role`; las funciones sensibles usan `SECURITY DEFINER` y `search_path` fijo. El frontend consulta la vista pública con publishable/anon key, el cliente elevado es server-side y `.env.local` está ignorado por Git. Los contratos y prompts tratan texto de artículos como datos no confiables. No se muestran secretos ni se cambian permisos.

12D no refrescó ACLs remotas debido al `PGRST303` de lectura privada. No hay evidencia de fuga o ampliación de permisos; no identifico un blocker de seguridad separado. Resolver la lectura privada sigue siendo un prerequisito operativo.

## TECH DEBT

### P0 — bloquea automatización supervisada

- **PGRST303 en lectura privada:** la consulta server-side de 12D fue rechazada. Restablecer una lectura fiable de intentos/continuaciones/ledger y verificarla antes de operación automática.
- **Scheduler sin ruta productiva supervisada:** hoy solo admite test namespace y `publish=false`. Diseñar y probar explícitamente el boundary humano de un evento antes de habilitar scheduler.

### P1 — antes del lanzamiento público o de escalar

- Revisión humana de afirmaciones MIT contra la fuente completa; mantener sign-off de atribución, incertidumbre y claims antes de cada publicación mientras Critic no tenga una muestra de calibración suficiente.
- QA en navegador con las historias reales: responsive, teclado, enlaces del mapa, artículo archivado/404 y URL canonical absoluta.

### P2 — posterior o solo antes de reactivar la capacidad relacionada

- El resume factual real rechazado por `INCIDENT_LINEAGE_OR_ARCHIVE_CHANGED` sigue sin causa raíz demostrada. No bloquea publicaciones nuevas supervisadas; mantener la remediación automática deshabilitada y no reabrir el Astra.
- Dashboard/alertas para cuota, errores, reservas desconocidas y leases atascados; mejorar correlación legacy de attempts/runs.
- `activity_history` requiere un agregador antes de usar momentum histórico; ampliar la muestra para estimar yield y calibrar el Critic semántico.
- Concurrencia RPM mayor que uno exige limitador distribuido y prueba de carga; no forma parte del modo inicial.

### P3 — mejora futura

- No hay `og:image` en la proyección pública actual; los enlaces sociales son textuales. No inventar imágenes mientras el contrato no las proporcione.
- Ajustes visuales y de variedad editorial cuando haya más historias reales; no justifican rediseño ahora.

## ARCHITECTURE FREEZE

**`FREEZE_V1_ARCHITECTURE: YES`.** Mantener Discovery → Extraction → Clustering → Verifier → Translator → Editor → Classifier/Geo → Ranker → Critic → Publisher, accounting, checkpoints y los lifecycles versionados. Los contratos, gates y Publisher determinista tienen cobertura suficiente para congelar la forma del sistema. Los blockers encontrados son de operación, revisión y disponibilidad del camino supervisado; no justifican rediseñar el pipeline. El resume factual permanece aislado y apagado.

## AUTOMATION DECISION

**`GO_WITH_PRECONDITIONS` para preparar 12E; `NO` a cualquier activación en 12D.** Antes de una ejecución supervisada deben cumplirse como máximo estas tres precondiciones:

1. Resolver `PGRST303` y demostrar lectura privada de intento, continuación, historial y accounting por el camino runtime normal.
2. Preparar y probar el bridge productivo de un evento con concurrencia uno, quota gates y aprobación humana antes de Publisher; el bridge actual es test-only/dry-run.
3. Exigir revisión humana de la evidencia y claims de cada historia (incluida la atribución secundaria) y mantener automática la remediación factual **desactivada**; el incidente Astra queda terminalmente archivado.

## INITIAL OPERATING MODE

| Control | Valor inicial |
| --- | --- |
| Candidatos que entran al pipeline de modelo | 3 por día; Discovery/Extraction deterministas pueden observar más antes de seleccionar |
| Publicaciones máximas | 2 por día |
| Concurrencia | 1 evento y 1 worker |
| Retries / fallback | 0 automáticos / ninguno; Groq only |
| Revisión humana | Aprobar candidato/fuente antes de gastar el path; revisar claims, atribución y qualifiers tras Critic y antes de Publisher |
| Stop diario | Rechazar si uso desconocido, TPM headers faltantes/vencidos, bloqueo activo o proyección superaría 850 RPD / 170.000 TPD soft; obedecer pacing TPM por etapa |
| Incidente factual | Preservar snapshot y evidencia; archivar mediante lifecycle exacto, verificar ausencia pública/404 y escalar a persona. No auto-unarchive, no resume del Astra, no bypass |

Tres candidatos equivalen a 18 requests y, con 12.934 tokens planificados por path, unos 38.802 tokens/día antes de desperdicio por fallos. Mantener las admisiones reales por etapa; esta proyección no reemplaza los headers TPM frescos.

## LAUNCH PATH

### BEFORE SUPERVISED AUTOMATION

1. Resolver el `PGRST303` de lectura privada.
2. En 12E, diseñar y validar el bridge one-event con aprobación humana y evidencia de quota/settlement; dejar activación apagada hasta revisión del resultado.
3. Revisar MIT contra fuente y acordar el checklist final de claims.

### BEFORE PUBLIC LAUNCH

1. Completar QA browser con los dos artículos reales en tamaños responsive, teclado, mapa, fuentes, legales, canonical y 404 archivado.
2. Configurar y verificar el canonical absoluto del host previsto.
3. Confirmar el flujo de revisión humana y el stop/runbook de seguridad antes de aumentar publicaciones.

### POST-LAUNCH

Materializar `activity_history` antes de prometer momentum; agregar panel/alertas de operación; ampliar muestra real antes de cambiar concurrencia o aumentar el target; incorporar imagen solo con un contrato de datos real.

## NEXT PHASE

**NEXT: 12E — SUPERVISED AUTOMATION PREPARATION.** Sin activación automática de producción. 12D termina con 0 llamadas de proveedores, 0 mutaciones de contenido/intento, 0 migraciones y 0 despliegues.

## EVIDENCE AND VERIFICATION

Evidencia principal: informes y artefactos 12A, 12A.1, 12A.1b, 12A.2, 12B.1, 12C, 12C.1, 12C.2A, 12C.2B.0/1/2a/2b/2c/2d/2d.1/2e/2f/2f.1a/2g/2g.1/2g.2/2g.3/2g.3a; checkpoints de las tres historias; políticas de capacidad Groq, scheduler, security, observability y QA frontend. Entre los readbacks canónicos se incluyen [piloto 12C](../artifacts/complete-real-content-pilot-12c.json), [incidente factual 12C.1](../artifacts/published-factual-incident-12c1.json), [validación remota migration 30](../artifacts/checkpoint-manifest-resume-remote-12c2b2f1a.json), [auditoría de linaje g1](../artifacts/incident-lineage-guard-audit-12c2b2g1.json) y [cierre g3a](../artifacts/factual-remediation-hot-path-12c2b2g3a.json).

Resultados locales actuales: 57/57 suites offline PASS; static fixtures migration 29 PASS y migration 30 PASS; lint PASS; TypeScript PASS; build Next.js 16.3.4 PASS. Los fixtures SQL remotos no se ejecutaron. `git diff --check` se registra en el artefacto al terminar esta documentación.

La lectura anónima actual pasó a las 17:31:27 UTC y devolvió exactamente dos slugs públicos, sin el incidente. La lectura privada de 12D falló con `PGRST303`; los detalles privados citados aquí conservan la marca temporal de la última lectura exitosa de 12C.2B.2g.3a. No se llamó a proveedores.
