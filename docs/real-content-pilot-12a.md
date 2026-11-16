# 12A — Piloto supervisado de contenido real (Groq only)

## PRE-FLIGHT

- Repositorio: `main`, commit base `4352bfb9046914fa5d7b4451c1b1e664a2baeac7`; el árbol estaba limpio al inicio.
- `supabase migration list` confirmó coincidencia local/remota hasta `20260927000026`. No se aplicaron migraciones ni se creó la 27.
- El contrato público anónimo devolvió 0 artículos antes del piloto.
- Preflight: Groq y `openai/gpt-oss-20b` en las seis etapas LLM; `maxRetries=0`, fallback de pago desactivado, router desactivado y endpoint oficial. Ejecución manual y secuencial.
- No se usaron service tier, flex ni performance; no se activaron scheduler, cron, router, Netlify ni deployment.

## CAPACITY

Snapshot inicial del `2026-09-28` UTC, leído del ledger canónico: 0 solicitudes, 0 tokens, 0 reservas despachadas desconocidas y ningún bloqueo temporal. Límites configurados: 1.000 RPD / 200.000 TPD hard; 850 RPD / 170.000 TPD soft; 30 RPM / 8.000 TPM.

El preflight canónico mostró 849 solicitudes utilizables bajo el límite soft estricto. El plan exigía 6 solicitudes y 12.934 tokens por evento. El saldo admitía hasta cinco eventos; no se reservó el presupuesto de cinco por adelantado. La admisión fue stage-by-stage.

El último TPM conocido antes de Discovery era del 25 de septiembre, por lo que estaba vencido y no se trató como estado en vivo. Durante el evento se usaron las cabeceras y resets devueltos por Groq.

## DISCOVERY

Discovery determinista consultó 15 fuentes activas en la ventana canónica reciente de 24 horas. Obtuvo 50 ítems, 0 URLs duplicadas, 0 hashes duplicados, 0 candidatos inválidos y 0 exclusiones por fecha no fiable. Se crearon 50 `raw_items`; hubo 0 errores de persistencia.

Once fuentes devolvieron feeds; cuatro estaban sin feed RSS/Atom configurado: MIT Technology Review en español, Sifted AI, VentureBeat AI y Rest of World AI. La fuente Ars Technica AI devolvió feeds, pero ningún ítem válido en la ventana. El resto de resultados por fuente está en el JSON del piloto.

## EXTRACTION

Se procesaron los 50 candidatos. Hubo 49 extracciones completas y frescas, 0 fallos y 1 bloqueo de extracción por la guarda existente en un ítem de EL PAÍS Tecnología. No se cambió ni se debilitó la guarda. Las 50 filas existentes se reutilizaron durante persistencia de extracción; no hubo errores.

## CLUSTERING

Clustering formó 49 eventos: 49 de una fuente, 0 corroborados por varias fuentes, 0 duplicados eliminados y 0 posibles falsos merges. No se fabricaron relaciones entre fuentes.

## CANDIDATE SELECTION

Se seleccionaron cinco eventos según la elegibilidad canónica y el orden temporal del pipeline. Ninguno tenía artículo publicado asociado. Todos eran de una fuente; no se alteró la selección ni la puntuación.

| Orden | Evento | Fuentes | Fecha publicada más reciente (UTC) |
| --- | --- | --- | --- |
| 1 | `event-cbbf85234317a442f59ece63ef1b40c8` — OpenAI agents tried to ‘bruteforce’ a UN website | The Verge AI | 2026-09-27 17:21 |
| 2 | `event-41d3cfeb20afd2c5bf4a6079db8fae17` — Can Muse overcome Meta’s trust issues? | TechCrunch AI | 2026-09-27 19:57 |
| 3 | `event-c59c564fbabf6f6ff5f1f9ba5ce8e1b7` — Anthropic’s CEO is about to have dinner with President Trump | TechCrunch AI | 2026-09-27 20:34 |
| 4 | `event-2e7fbe67dd428acf4f1b3871ed8e374c` — Engram is a sampler that turns broken AI hallucinations into music | The Verge AI | 2026-09-27 20:46 |
| 5 | `event-11ec02e10309b12d6bf140aebb631f5b` — Minute-scale training for microrobot navigation | Nature Machine Intelligence | 2026-09-28 00:00 |

## EVENT 1

- Pipeline attempt: `ce894b55-5c50-44dc-87db-58bcbf09834b`; persistent attempt 1 terminó como `TECHNICAL_FAILURE`, etapa `publisher`, con `LOCAL_SCHEMA_VALIDATION_ERROR`.
- Event ID: no se materializó; event key: `event-cbbf85234317a442f59ece63ef1b40c8`.
- Fuente única: [The Verge AI](https://www.theverge.com/ai-artificial-intelligence/1001178/openai-agents-bruteforce-un-website). Verifier: `single_source`, confianza 80, dos hechos verificados. No se afirmó corroboración.
- Groq/modelo: `groq` / `openai/gpt-oss-20b`. Seis solicitudes despachadas, cada una con un intento y cero reintentos. Tokens reales asentados: 8.574 entrada + 1.307 salida = 9.881.
- Versiones: Verifier `verifier-v1`; Translator `translator-v1`; Editor `editor-v2`; Classifier `classifier-v1`; Geo determinista `geo-resolver-v1`; Ranker `ranker-v1`; Critic `critic-v3`.
- Pacing: dos esperas basadas en cabeceras/reset TPM, 39.235 ms antes de Ranker y 9.542 ms antes de Critic; total 48.777 ms.
- Editor pasó sus guards. Clasificación: `empresas`, `modelos`; región `GLOBAL`, país `US`. Importancia Ranker: 49,3. Critic: `pass`, 0 issues.
- Publisher falló en validación local antes de materializar/publicar. No se saltó la validación ni se alteró el estado. No se creó artículo ni slug público.
- Contrato público después del intento: 0 artículos. El registro `pipeline_event_attempts` quedó finalizado y preservado con clase `TECHNICAL_FAILURE`.

## EVENT 2

No intentado: el stop técnico del Evento 1 cerró la ejecución del proveedor.

## EVENT 3

No intentado: el stop técnico del Evento 1 cerró la ejecución del proveedor.

## ADDITIONAL ATTEMPTS IF ANY

No hubo intentos adicionales. Total: 1 de 5 intentos máximos; 6 de 30 llamadas Groq máximas.

## PUBLICATIONS

Artículos publicados: **0**. No se creó una publicación parcial ni se insertaron artículos manualmente.

## PUBLIC CONTRACT

Lectura anónima de `public_published_articles`: 0 antes y 0 después. No había slug de publicación que verificar individualmente.

## LOCAL FRONTEND QA

No ejecutada porque no hubo ningún artículo publicado. La build de producción compiló correctamente, pero eso no se considera QA visual de contenido real. No se usaron mocks ni fixtures para fingir publicaciones.

## MAP

Publicados: 0; con marcador: 0; sin marcador: 0. No aplica una revisión de marcadores sin artículos publicados.

## EDITORIAL OBSERVATIONS

El único evento llegó a Critic con resultado `pass`, pero no superó la validación local de Publisher y no se publicó. La verificación lo mantuvo explícitamente como noticia de una sola fuente. La validación fallida requiere análisis antes de continuar; no se corrigió ni se reintentó en esta fase.

## CAPACITY AFTER PILOT

Lectura final del `2026-09-28 17:17:39 UTC`: 6 solicitudes contabilizadas y despachadas; 8.574 tokens de entrada y 1.307 de salida asentados; 0 solicitudes desconocidas y 0 bloqueo temporal. Quedaban 844 solicitudes y 160.119 tokens hasta los techos soft; quedaban 994 solicitudes hasta el hard RPD. Groq no expuso aquí un límite TPD en cabeceras, así que no se afirma uno.

La última cabecera TPM observada fue a las 17:10:20 UTC: 8.000 TPM, 5.138 tokens restantes y reset de 21,465 s. Ese estado ya estaba vencido en la lectura final. Cloudflare: 0 llamadas y 0 reservas nuevas; no se liberaron las 3.110 neurons históricas.

## LIMITATIONS

- La publicación se detuvo en `LOCAL_SCHEMA_VALIDATION_ERROR` dentro de Publisher. La telemetría canónica identifica etapa y código, pero no incluye las rutas de validación en el resumen de fallo.
- Sin publicaciones, no se pudieron comprobar rutas de artículo, Home/latest/hero, contenido público individual ni marcadores de mapa.
- El clustering no encontró eventos corroborados por varias fuentes dentro de los candidatos seleccionados.
- Las suites offline, lint, TypeScript y build pasaron; no ejecutaron llamadas de proveedor.

## NEXT STEP

**12A READY: NO.** El piloto terminó por un fallo técnico de Publisher y publicó 0 artículos. Siguiente paso indicado: **12A.1 — análisis del fallo del piloto**. No se ejecutó esa fase y no se hicieron más llamadas de proveedor.
