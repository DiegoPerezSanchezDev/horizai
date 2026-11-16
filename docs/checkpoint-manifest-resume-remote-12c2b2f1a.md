# 12C.2B.2f.1a — migración 30 y validación remota del resume

## FIRST APPLY FAILURE

El primer db push de la migración 30 devolvió PostgreSQL 42601: syntax error at end of input. El cursor señalaba la comparación del marcador syntheticFixture con un CASE inline. La transacción revirtió por completo: la migración 30 seguía pendiente y la función no existía.

## SQL ROOT CAUSE

La expresión original dentro del predicado IF era:

    v_continuation ->> 'syntheticFixture' is distinct from case
      when v_is_synthetic then 'true' else 'false' end

Debía comprobar que el valor almacenado coincidiera con la condición derivada: "true" en una fixture sintética y "false" para el incidente real. La lectura íntegra no encontró un END, paréntesis, punto y coma o delimitador $$ sin pareja: el archivo tenía 18 bloques IF/END IF, paréntesis balanceados y el par de delimitadores de la función completo. El CASE inline era la única expresión de ese tipo y coincidía con el cursor de PostgreSQL.

Se quitó la expresión del predicado: la función calcula v_expected_synthetic_fixture := v_is_synthetic::text y luego compara syntheticFixture con esa variable. Se conserva exactamente el resultado booleano en texto y se elimina la forma que provocó el error.

No había PostgreSQL local disponible (psql no está instalado y el daemon de Docker no estaba iniciado). La prueba estática impide restaurar esa comparación inline. La aplicación remota correcta de la migración y el ejercicio posterior de la función dieron la comprobación sintáctica de PostgreSQL.

Una consulta ad hoc de solo lectura para capturar estado se envió al CLI sin el SQL multilínea y recibió 42601 en la línea 0. No ejecutó una escritura y no fue un segundo intento de aplicar la migración.

## CORRECTED MIGRATION 30

Se editó en sitio 20261002211000_factual_remediation_continuation_resume.sql, porque nunca había sido aplicada. No se creó una migración 31. El namespace sintético se ajustó al prefijo exigido 12c2b2f1a:<uuid>.

La política de ciclo de vida se mantiene: se valida el mismo intento y la autorización existente, se admite únicamente el estado STOPPED elegible, se conservan las comprobaciones de no despacho de Critic, ausencia de checkpoint de Critic, checkpoints Verifier→Ranker, manifest canónico, límite de un resume, intento piloto 5/5, aislamiento por advisory lock y auditoría del STOP anterior. El resume reinicia en Critic y no crea una autorización, un intento ni un run de agente.

## LOCAL VALIDATION

- 56 suites offline, incluido agent contracts: PASS.
- Tests de continuación, migración 29 y migración 30: PASS.
- npm run lint: PASS.
- npx tsc --noEmit: PASS.
- npm run build: PASS.
- git diff --check: PASS.
- El análisis estático encontró un solo CASE en el SQL original; la regresión ahora comprueba que no vuelva a aparecer inline en esa comparación.

Durante la preparación remota se corrigieron tres defectos del harness antes de alcanzar la validación del RPC: una referencia local a lineageNamespace, un valor provider fuera del CHECK existente y un marcador sintético que inicialmente entraba en el ledger diario. En cada intento se limpió por IDs generados y la consulta residual dio cero. El harness final dejó el ledger sin delta y terminó PASS.

## REMOTE APPLY

El proyecto confirmado fue skrthgpurquypgdwxast. El historial antes de aplicar mostraba 27/28/29 aplicadas, 30 pendiente y ninguna 31. Tras pasar las comprobaciones locales, supabase db push aplicó únicamente la migración 30. El historial posterior muestra 30 como última migración y 31 ausente.

## REMOTE OBJECTS

- Función: public.resume_incident_factual_remediation_continuation(uuid, uuid, uuid, jsonb).
- Argumentos: p_attempt_id uuid, p_pipeline_run_id uuid, p_resume_execution_id uuid, p_checkpoint_manifest jsonb.
- Propietario: postgres; SECURITY DEFINER; search_path=pg_catalog, public.
- Único cambio de constraint: pipeline_event_attempts_remediation_metadata_check para aceptar el namespace sintético de esta fase.
- Tablas, columnas e índices nuevos: ninguno.

## SECURITY

La ejecución está permitida a service_role. anon, authenticated y PUBLIC no tienen EXECUTE; las llamadas bajo anon y authenticated fueron rechazadas.

## JSONB ROUND-TRIP

PostgreSQL reordenó las claves de los objetos al convertir el manifest a JSONB; por eso JSON.stringify local y remoto no coincidieron. El esquema estricto aceptó ambos valores, la comparación semántica canónica pasó y SHA-256 coincidió. La igualdad JSONB del RPC ignora el orden de claves de objetos y conserva el orden de arrays.

## VALID RESUME

Una fixture sintética elegible pasó a RUNNING con etapa critic, usando el mismo intento y la autorización existente. El estado STOPPED completo quedó guardado en resumeHistory. No se creó otro intento ni autorización, no apareció el intento 6 y no hubo reserva, despacho ni run de Critic.

Se rechazaron 31 variantes: cambios de hash, ID, etapa, evento, run, autorización, claves faltantes o extra, checkpoints faltantes o extra, intento incorrecto, autorización incorrecta, stop reason incorrecto, despacho/reserva/checkpoint de Critic existente, artículo no archivado, estado/purpose incorrecto y segundo resume.

## INVALID CASES

Todos los casos inválidos devolvieron BLOCKED. Los marcadores de reserva y despacho solo fueron datos sintéticos para ejercitar los rechazos. El marcador de reserva quedó fuera de la fecha del ledger activo y se verificó que no cambiara capacidad de Groq, Cloudflare ni otro proveedor.

## ONE-RESUME RULE

El segundo resume de la fixture ya reanudada fue rechazado. La fila registra resumeGeneration: 1 y la identidad del resume admitido.

## CONCURRENCY

Dos solicitudes concurrentes sobre otra fixture produjeron exactamente una admisión y un rechazo.

## HISTORICAL STOP

El STOP previo de la fixture se preservó completo en resumeHistory. El intento real permaneció TECHNICAL_FAILURE, con su continuación STOPPED y sin resumeGeneration.

En la lectura real, el campo continuation.stopReason contiene CONTINUATION_RUNNER_ABORTED y el campo superior del intento contiene cost_guard_violation; el JSON real no contiene failureCode. La clasificación del preflight identifica el fallo previo de serialización del manifest. Se conservó esa lectura real, sin escribir un motivo supuesto en el incidente.

## ATTEMPT / AUTHORIZATION INVARIANTS

La fixture pasó de 2 filas de intento a las mismas 2; intentos nuevos: 0; intento piloto 6: 0. La autorización se mantuvo en 1 antes y después. En el incidente real, el piloto sigue 5/5 y la autorización existente es la única autorización.

## NORMAL LIFECYCLE

Los hashes de las rutinas normales auditadas antes y después coinciden. No cambiaron el scheduler, el bridge, las funciones de lifecycle de migraciones 27/28/29 ni la finalización normal de publicación.

## CAPACITY ISOLATION

Delta de solicitudes, tokens y solicitudes desconocidas: Groq 0; Cloudflare 0; Cerebras 0. No se hizo ninguna llamada a Groq, Cloudflare, Cerebras ni otro proveedor; tampoco una inferencia. El ledger diario quedó idéntico tras limpiar.

## REAL INCIDENT ISOLATION

- Intento a82482be-58d8-4fc6-ac16-946d0906257b: sin cambios, TECHNICAL_FAILURE, piloto 5/5.
- Continuación f140d01b-b7f1-4f05-b8f7-9ad0081e7105: STOPPED, sin resume real.
- Autorizaciones: 1; reserva/dispatch/checkpoint Critic: ausentes; intento 6: ausente.
- Artículo 756b0ee0-b5e6-4153-846f-278a12c9afe3: archivado; artículo público del incidente: ausente; total público: 2.
- Filas sintéticas residuales: 0 en attempts, events, articles, raw_items, sources, event_sources, agent_runs y agent_logs.
- Baseline de artículo, publicación, intento y ledger restaurado.

## RUNNER PREFLIGHT

npm run pipeline:factual-remediation:continuation:preflight termina en PREFLIGHT_ONLY. Se añadió la carga de .env.local a ese script para que la orden del proyecto funcione. El preflight leyó el estado real, reutiliza la autorización existente, no crea autorización ni escribe en remoto y no supone que el TPM actual sea fresco.

La estimación Critic V4 es 6397 tokens con límite configurado 8000, margen de seguridad 128 y headroom ajustado 1475. La cobertura de atribución, la incertidumbre y los detalles no soportados pasan sus comprobaciones offline. Critic es la siguiente etapa, con un máximo futuro de una solicitud. El TPM debe refrescarse antes de cualquier ejecución.

## NEXT STEP

12C.2B.2f.1 queda listo. La siguiente fase es 12C.2B.2g: reanudar la continuación ya autorizada solo después de obtener estado TPM fresco. No se debe volver a autorizar ni crear un intento 6. Esta fase se detuvo en PREFLIGHT_ONLY; no ejecutó el resume, no reservó ni despachó Critic y no publicó el artículo.
