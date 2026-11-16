# 12F.1 — First supervised rejection audit + operational cleanup

**12F.1 READY = YES.** Auditoría del 7 de octubre de 2026, sin llamadas de IA ni mutaciones remotas. La fase termina aquí; 12F.2 no se ejecutó.

## 12F OUTCOME

Un candidato MIT y una llamada Verifier Groq en 12F. Resultado guardado: rejected, confianza 10, 0 hechos verificados, razón: “No verifiable evidence of the claimed event in the supplied source.” La respuesta fue estructuralmente válida y el pipeline terminó de forma segura. Esta auditoría leyó completos el documento y el artefacto de 12F y conservó el checkpoint original.

## SOURCE / RAW LINEAGE

PASS. Fuente MIT Technology Review: e3a5ef5a-c4d8-42bf-bc3c-08284952d3e4; registry URL https://www.technologyreview.com/ y RSS https://www.technologyreview.com/feed/. Candidato: e3a5ef5a-c4d8-42bf-bc3c-08284952d3e4:ad0ddc99994ef7d45021c8321152105d. Raw item: bf446840-8bf9-44d0-8ad0-8315bc174d45, perteneciente a esa misma fuente. external_id coincide exactamente; URL original y canónica coinciden con la URL del candidato. La URL del registry es la homepage de la misma fuente, mientras que la URL enviada al modelo es la del artículo. No hay drift.

Event key: event-ee5412887603e4914658137010f51d08. Run: 45ee9e60-92a4-4b11-a736-bb2f005b50d8. Attempt: 1cf75dc8-cd03-4aa2-b2db-b847286d9745, número 1. Reclustering offline del único item reconstruye exactamente el mismo event key y confianza 45. Hash normalizado del texto: sha256:a18068e7055ce08ea4fd650f0d1725c946a0c5d2873192aecfe06238d127818d, recalculado y coincidente.

## EXTRACTION

Título: 2026 Climate Tech Companies to Watch. URL: https://www.technologyreview.com/2026/10/06/1143800/2026-climate-tech-companies-to-watch. Fecha: 2026-10-06T10:35:00.000Z; autor Amy Nordrum; idioma en. MIME guardado en metadata: text/html; charset=utf-8; content_type de raw_items: article.

Texto: **703 caracteres**, 4 segmentos separados por párrafos: 2 encabezados y 2 bloques de prosa. **0 párrafos informativos sobre las empresas o el evento del título.** Los segmentos son un encabezado corporativo, la biografía de MIT Technology Review, “Advertise with MIT Technology Review” y un bloque de publicidad comercial. El teaser describe una lista anual pero no nombra empresas ni aporta hechos verificables sobre ellas.

La metadata JSON-LD identifica NewsArticle, el título, fecha y autora; OpenGraph conserva título, URL y teaser. No existe articleBody en el JSON-LD guardado. La extracción quedó quality=full y processing_status=extracted. El código marca full cuando Readability devuelve al menos 200 caracteres; esa etiqueta no valida pertinencia editorial. El artefacto incluye metadata completa y los cuatro segmentos exactos expuestos al modelo.

raw_content contiene el texto **ya extraído**, según rawItemInputFromExtraction; el HTML original no fue persistido. No hay evidencia guardada para demostrar que un cuerpo editorial útil estuvo accesible y se perdió, ni para atribuir el resultado a un paywall. No se hizo ningún fetch nuevo.

## VERIFIER INPUT

Se reconstruyó offline con buildVerifierModelInput desde raw_items, su metadata y el evento del checkpoint. Resultado: una fuente; sourceType=null, autor Amy Nordrum, título, URL, fecha, teaser y los 703 caracteres corporativos. JSON serializado: **1455 caracteres**. originalContentChars=[703], sentContentChars=[703], truncated=[false]. Todas estas métricas coinciden con agent_log 791. Prompt local: 3064 caracteres, también coincide; schemaChars registrado 1228 y bodyBytes 6131.

SHA256 del JSON reconstruido: 739db738cf0cad183d21c83cf899bd21f2211b6b961bffe7779fc054597dbef4. SHA256 del checkpoint original: 01c16ba795096a5e309033530d573a4967130c0a2756b5b3936dc2eceeadff28. El artefacto guarda el model input completo. La solicitud HTTP original no está guardada; la reconstrucción se basa en datos persistidos, código de construcción y métricas de la llamada, no en un hash de wire bytes registrado originalmente. No se observa truncación ni defecto de construcción: Verifier recibió íntegro el texto disponible, que era ajeno al candidato.

## REJECTION CLASSIFICATION

**DISCOVERY_QUALITY_FILTER_GAP.** El defecto comprobable es la admisión previa al proveedor de un cuerpo formado exclusivamente por boilerplate corporativo/publicidad. El título y el teaser no sustentan una síntesis factual. **Verifier rejection appropriate: YES**, para la evidencia efectivamente suministrada.

No se declara VALID_WEAK_EVIDENCE_REJECTION como diagnóstico de la página editorial original: su cuerpo útil no está guardado. Tampoco se prueba SOURCE_ACCESS_LIMITATION ni EXTRACTION_DEFECT de pérdida de contenido disponible; falta el HTML original para discriminar esas causas. La clasificación identifica el punto que sí puede demostrarse y corregirse con lo almacenado.

Corrección mínima: non-editorial-content.ts compara el hostname www.technologyreview.com y el hash **recalculado** del bloque exacto observado. create-production-pipeline.ts lo excluye en modo supervisado antes de clustering/admisión. No usa título, longitud ni una regla general sobre MIT o listas; contenido diferente sigue elegible. Las pruebas cubren el texto exacto, normalización de espacios, otro host, cuerpo con evidencia adicional y el adapter real de producción. No se alteró Verifier ni la arquitectura de ranking.

## LIFECYCLE

EventId absence: **EXPECTED**. El adapter de clustering registra 0 escrituras en events/event_sources; la materialización editorial pertenece a la transacción posterior de publicación. Un rechazo aquí conserva eventKey y attempt sin crear un evento publicable.

Intento completado a 2026-10-06T21:23:42.007+00:00: VERIFICATION_INSUFFICIENT, stop_stage=verifier, stop_reason=SKIPPED_VERIFICATION_INSUFFICIENT, retry_class=VERIFICATION_INSUFFICIENT, counts_toward_retry_limit=false, next_eligible_at=null. Es un desenlace editorial terminal, no TECHNICAL_FAILURE. Hay exactamente un intento para ese event key y 0 filas events.

## NO-DOWNSTREAM PROOF

El único agent_run asociado mediante config.pipelineRunId es Verifier 39ab0c89-5926-4d5f-b062-c9ffab8f550b; la única reserva es 788, liquidada. El directorio del run contiene solo el checkpoint Verifier. El branch de pipeline-orchestrator.ts retorna al encontrar 0 verifiedFacts antes de Translator y de createReview/Publisher. El checkpoint conserva rejected y 0 hechos.

Translator / Editor / Classifier / Ranker / Critic: **0 dispatches**. Publisher: **0 invocaciones**. Review rows para este candidato: **0**; WAITING_FOR_HUMAN_REVIEW global: **0**. Reservas huérfanas/dispatches desconocidos para 12F: **0**. Prueba offline supervisada con dos eventos y limit=1 confirma que el rechazo no procesa reemplazo, no crea review y no entra en downstream.

## NPM COMMAND

Root cause: **PACKAGE_SCRIPT_ARGUMENT_FORWARDING**. En este PowerShell, npm resuelve al shim npm.ps1: la invocación originalmente documentada deja argv=[] y npm_config_execute_supervised=true. El guard estricto rechaza correctamente antes de Supabase/proveedor. npm.cmd entrega argv=["--execute-supervised"]. La reproducción usó un paquete temporal con el mismo package script y un entrypoint que solo importa el parser, sin .env, DB ni proveedores.

Comando canónico único para este entorno Windows:

```powershell
npm.cmd run pipeline:supervised:run -- --execute-supervised
```

Corrección operativa: documentación y error usan npm.cmd; parser compartido estricto y --help offline. No se acepta npm_config_execute_supervised como autorización implícita cuando argv está vacío. La prueba del comando con ejecución explícita usa exclusivamente el entrypoint aislado; en el entrypoint real solo se ejecutó npm.cmd run pipeline:supervised:run -- --help, con salida antes de crear el cliente o adquirir lease. No se ejecutó el pipeline real.

## READMISSION POLICY

**SAFE; NO CHANGE** de política. El mismo item vuelve a producir event-ee5412887603e4914658137010f51d08. evaluateNormalEligibility sobre el intento real devuelve eligible=false, reason=PERMANENT_OUTCOME. filterEligibleEvents ocurre antes de slice(limit); claim_pipeline_event_attempt también bloquea VERIFICATION_INSUFFICIENT. counts_toward_retry_limit=false no convierte el resultado en reintentable. Reintentos de proveedor de producción: 0. No se autorizó ningún retry de este candidato.

Las pruebas existentes cubren terminal outcomes y selección antes del límite. La prueba supervisada adicional redescubre el candidato terminal: 0 intentos nuevos y 0 dispatches. El filtro estrecho de boilerplate añade protección para ese mismo cuerpo antes de formar eventos.

## PUBLIC HASH VERIFICATION

Se recuperó la consulta exacta pre-12F de la evidencia local guardada a 2026-10-06T21:22:41.344Z y se ejecutó de nuevo en PostgreSQL dentro de BEGIN READ ONLY. Método:

```sql
md5(concat_ws(chr(31), a.slug, a.headline_es, coalesce(a.summary_es,''), coalesce(a.why_it_matters_es,''), coalesce(a.body_es,''), a.metadata::text))
```

Se mantienen chr(31), el orden de campos, coalesce y la serialización PostgreSQL metadata::text. No se sustituyó por un hash del body o del JSON REST.

| Artículo ID | Pre-12F | Lectura actual | Resultado |
| --- | --- | --- | --- |
| 6203559f-413a-4f06-9346-1720bbeb0e7a | ccef966880d85663b8fd5049e9995f5f | ccef966880d85663b8fd5049e9995f5f | UNCHANGED |
| 7415c685-04ed-4956-a77a-4bc372c9b060 | 4cf1ecf2990a5dca582c95e5733a484f | 4cf1ecf2990a5dca582c95e5733a484f | UNCHANGED |

Conteo público **2 → 2**, mismos IDs/slugs. Astra **archived**, ausente de public_published_articles. El candidato no tiene events/article/review. La lectura actual cierra la falta de recálculo posterior documentada en 12F.

## ACCOUNTING

Ledger canónico de 12F, fecha UTC 2026-10-06: **+1 request / +1479 tokens**. Groq openai/gpt-oss-20b; Verifier input1302/output177. Reserva 788: estimación 4202, delta de liquidación -2723, actual1479, settled. Agent log 790 y telemetría del run confirman liquidación, HTTP200, retries0, fallback0, 429=0. Cloudflare/Cerebras/inference=0. Uso desconocido y reservas huérfanas de este run=0. El día completo 2026-10-06 también registra 1/1479.

Baseline 12F.1 2026-10-07T17:40:13.418725+00:00; lectura final 2026-10-07T17:46:34.390314+00:00. Ledger global: 135 reservas y hash 5a6d82ab6ca91dfc038796a694b989ef en ambas lecturas. Intentos: 9 y hash 5840585dce7ec5419f28cdaa5f9a320d sin cambios. Reviews: 0 y hash d41d8cd98f00b204e9800998ecf8427e sin cambios. **Delta de requests=0; delta de tokens=0; llamadas de proveedores en esta fase=0.** No se activó scheduler, remediación automática ni Publisher; no se creó/editó/aplicó migración ni hubo mutaciones reales.

## READINESS FOR SECOND CYCLE

OBSERVE: evidencia almacenada, baseline y código. PLAN: clasificar el defecto observable y limitar correcciones a admission/CLI. EXECUTE: catálogo de un solo hash observado, parser y comando Windows. CRITIQUE: no inferir paywall/cuerpo perdido, no heurística general, no fallback de autorización por environment. VERIFY: 63/63 suites de unidad/simulación de package; fixtures29 y30 standalone; fixture31 incluida; publisher failure analysis y contracts adicionales. **67/67 invocaciones offline finales PASS**.

lint PASS; npx tsc --noEmit --pretty false PASS; npm run build PASS (Next16.3.4); git diff --check PASS. Las pruebas de scheduler/proveedores/review/Publisher usaron fixtures locales, sin acciones reales. Se preservaron cambios previos del workspace.

**12F.1 READY = YES.** Rechazo explicado y apropiado al input, lineage PASS, defecto concreto previo al proveedor acotado y probado, lifecycle conocido, entrada npm canónica probada, readmisión segura, hashes públicos UNCHANGED y accounting consistente. Siguiente fase propuesta: 12F.2 — SECOND REAL SUPERVISED CYCLE, un candidato máximo, objetivo Critic PASS → WAITING_FOR_HUMAN_REVIEW. Requiere autorización del nuevo ciclo. **DETENERSE.**
