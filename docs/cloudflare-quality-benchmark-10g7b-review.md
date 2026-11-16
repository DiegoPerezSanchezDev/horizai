# Cloudflare quality benchmark — 10G.7b

## Resultado de la auditoría previa

**El benchmark se detuvo antes de la primera inferencia.** `qualityBenchmarkCompleted=false`; no hay salidas Cloudflare que revisar ni comparación Groq/Cloudflare. Se conserva `semanticQualityGateValidated=false` y `humanQualityDecisionRequired=true`.

La capacidad Cloudflare se leyó de forma remota y de solo lectura para el periodo UTC **2026-09-27** (captura 13:49:30Z): 0 requests reservadas, 0 despachadas, 0 Neurons reservadas, uso conocido, soft limit 8.500, hard limit 10.000 y sin bloqueo temporal. No se reservó capacidad para este benchmark.

## Bloqueo antes de inferencia

La RPC supervisada de etapas de la migración 24 solo permite un fixture fijo por etapa: Verifier `verifier:unit:confirmed-two-source`, Translator `translator:unit:gpt-5-launch-2026`, Editor `editor:canonical-editor-input`, Classifier `classifier:fixture-new-openai-model` y Ranker `ranker:confirmed-launch`. El validador local aplica la misma allowlist. Ninguno identifica los linajes Ars/MIT de esta solicitud. Verifier, además, solo permitiría el fixture de dos fuentes, mientras ambos casos auditados contienen una fuente.

El runner de validación de Critic construye `canonicalCriticInput`, un control sintético limpio; no selecciona los drafts históricos Ars y MIT. Aunque se pudiera enviar otro payload conservando las etiquetas o la identidad de fixture, se registraría como una validación distinta de la realmente ejecutada. Eso eludiría el propósito de la allowlist. No hice llamadas Cloudflare y no creé una migración para ampliar la autorización.

También se auditó el executor de snapshots supervisados. Solo autoriza el snapshot Ars ya existente y ejecuta el pipeline completo mediante `createProductionPipeline`; no ofrece la secuencia aislada de etapas/casos pedida y queda fuera del alcance.

## Linajes históricos auditados

La telemetría de `agent_runs` vincula las etapas históricas de ambos `eventKey` con `provider=groq`, modelo `openai/gpt-oss-20b`, versiones de agente correspondientes, HTTP 200 y salida Zod válida. Se etiquetan **`CONFIRMED_GROQ`**; no son outputs Cloudflare. En ambos Critic hubo también un intento histórico HTTP 429; el checkpoint conservado corresponde a una ejecución posterior exitosa. No se llamó a Groq en 10G.7b.

### Ars Technica AI — caso problemático

- **Linaje:** `event-5c80fcd1a4e5b0d010308f37d646625a`; una fuente. Raw item trazable al `sourceItemId` y `source_id` del checkpoint: raw item `93dea107-8bbf-42a5-8314-c0b4c70522ec`, hash SHA-256 `7aa373cdeeb56947806f21460d97042739cd62f7f8d3dd812c0a41d9e7dd7f84`. El registro remoto indica extracción completa de 8.729 caracteres; el snapshot local coincide. Solo el excerpt breve (76 caracteres) se conserva en el snapshot y este informe. Un documento local previo decía que la extracción era de 0 caracteres; la lectura del raw item y el snapshot contradicen esa nota anterior.
- **Hecho almacenado:** una vulnerabilidad en Muse permite cambiar el endpoint de transcripción y obtener el token de autenticación, con toma de control de la cuenta. Es el hecho del Verifier histórico, no una corroboración independiente.
- **Verifier histórico `CONFIRMED_GROQ`:** `single_source`, confianza 85, un hecho verificado y ninguna contradicción. Su explicación reconoce que solo hay una fuente. Output Cloudflare: `NOT_AVAILABLE`.
- **Translator histórico `CONFIRMED_GROQ`:** una traducción factual; conserva `Muse` y `Meta`. Output Cloudflare: `NOT_AVAILABLE`. La calidad del español requiere revisión humana.
- **Editor histórico `CONFIRMED_GROQ`:** titular “Meta expone vulnerabilidad de día cero en su asistente de IA Muse”. El resumen conserva la afirmación central. Un punto clave añade que “Meta aún no ha lanzado parche”, dato que no aparece en el hecho Verifier almacenado.
- **Classifier histórico `CONFIRMED_GROQ`:** categorías `empresas`, `modelos`, `investigacion`; región `US`. Las cuatro referencias existen y están activas en el registry remoto consultado. Su pertinencia editorial requiere revisión humana.
- **Ranker histórico `CONFIRMED_GROQ`:** impact 80, novelty 70, economicImpact 60; señales deterministas almacenadas: credibility 58, reach 34, momentum 50; importance 59,9. Plausibilidad de scores requiere revisión humana; no se recalculó el resultado para esta fase.
- **Critic histórico `CONFIRMED_GROQ`:** `revise_editorial`, severidad alta, un `UNSUPPORTED_CLAIM_EDITORIAL`. Identificó como no soportada la afirmación de que Meta confirmó la falla y aún no publicó una corrección. El checkpoint no conserva evidencia suficiente para afirmar que la rama de referencias no vacía quedara ejercitada. Output Cloudflare: `NOT_AVAILABLE`.

### MIT Technology Review — control histórico

- **Linaje:** `event-2a0197acd23aa82ff91895e1464d2897`; una fuente. El checkpoint relaciona el source item `e3a5ef5a-c4d8-42bf-bc3c-08284952d3e4:c609940a4b78f4cb7d186d29a5d45314`, pero no contiene `rawItemId`, excerpt ni cuerpo extraído. La consulta remota por ese external ID no encontró raw item. La búsqueda de título devolvió cero coincidencias para ese caso; se excluyó un registro distinto posterior de MIT con otro título y otro external ID. La identidad de la fuente está activa, pero el artículo original de este linaje no tiene trazabilidad raw-item verificable.
- **Hecho almacenado:** OpenAI Foundation financiaría la propuesta de Ruxandra Teslo para crear datasets científicos de empresas biotecnológicas fallidas. El hecho existe en el Verifier histórico; el input fuente primario no está disponible en el linaje local/remoto auditado.
- **Verifier histórico `CONFIRMED_GROQ`:** `confirmed`, confianza 90, un hecho y una fuente. “Confirmed” y 90 con una sola fuente requieren especial revisión humana; esto no valida calibración. Output Cloudflare: `NOT_AVAILABLE`.
- **Translator histórico `CONFIRMED_GROQ`:** conserva `Ruxandra Teslo` y `OpenAI Foundation`; una traducción factual almacenada. Output Cloudflare: `NOT_AVAILABLE`. La calidad del español requiere revisión humana.
- **Editor histórico `CONFIRMED_GROQ`:** titular “OpenAI financia iniciativa de datos biológicos tras la caída de empresas biotech”. El resumen y “Por qué importa” amplían el hecho almacenado; sin el artículo original, su consistencia factual queda sin determinar.
- **Classifier histórico `CONFIRMED_GROQ`:** categorías `investigacion`, `innovacion`, `empresas`; región `US`. Las referencias existen y están activas en el registry remoto consultado. Pertinencia editorial requiere revisión humana.
- **Ranker histórico `CONFIRMED_GROQ`:** impact 60, novelty 50, economicImpact 40; señales deterministas almacenadas: credibility 78, reach 34, momentum 50; importance 53,9. Plausibilidad de scores requiere revisión humana.
- **Critic histórico `CONFIRMED_GROQ`:** `pass`, cero findings. Es un control que pasó históricamente, no una etiqueta gold de calidad: falta el raw item para revisar de manera independiente sus afirmaciones. Output Cloudflare: `NOT_AVAILABLE`.

## Cobertura de la calidad solicitada

| Etapa/caso | Evidencia Cloudflare | Estado para revisión |
| --- | --- | --- |
| Verifier Ars y MIT | Sin llamada | `NOT_AVAILABLE`; estado y calibración histórica requieren revisión humana |
| Translator Ars | Sin llamada | `NOT_AVAILABLE`; revisar español, hechos, entidades y originalidad |
| Editor Ars | Sin llamada | `NOT_AVAILABLE`; revisar factualidad, claim sin soporte y originalidad |
| Classifier Ars | Sin llamada | `NOT_AVAILABLE`; slugs/región históricos resuelven, semántica pendiente |
| Ranker Ars | Sin llamada | `NOT_AVAILABLE`; fórmula histórica registrada, scores subjetivos pendientes |
| Critic Ars problemático | Sin llamada | `NOT_AVAILABLE`; el Critic Groq histórico encontró un defecto conocido |
| Critic MIT control | Sin llamada | `NOT_AVAILABLE`; el Critic Groq histórico pasó, pero no hay raw item para cotejo |

No se elige un ganador ni se da una puntuación global. La pregunta Verifier sigue limitada a casos de una fuente: **`MULTI_SOURCE_REAL_QUALITY_EVIDENCE: MISSING`**.

### Preguntas para Diego

- En Ars, ¿`single_source` y confianza 85 comunican suficiente cautela? ¿Las entidades, el español y la síntesis son correctos? ¿El claim sobre el parche debe permanecer fuera sin evidencia?
- En MIT, ¿es defendible `confirmed` con confianza 90 basándose en una fuente? ¿Las entidades, el español, el resumen y “Por qué importa” se sostienen con el único hecho almacenado?
- ¿Las categorías elegidas describen cada historia con criterio editorial? ¿Son plausibles los scores de impacto, novedad e impacto económico? ¿Hay valores extremos sin justificación?
- En el control MIT, ¿hay defectos factuales que el Critic histórico no señaló? La ausencia del raw item impide resolverlo desde esta auditoría.
- Los outputs Cloudflare no existen todavía; una decisión de calidad sobre Cloudflare requiere primero una capacidad supervisada que autorice y registre estos casos concretos.

## Registro de llamadas y gates

Plan previsto: 8 requests Cloudflare, todas `NOT_DISPATCHED_PRE_INFERENCE_BLOCKER`; cero requests Groq, Cerebras o a otros proveedores. No hubo retries, repair calls, fallback, settlements, escrituras de eventos/artículos, Publisher, scheduler, cron, routing ni deploy. No se cambió ningún gate ni esquema y no se persistieron secretos.

`technicalAllStagesValidated=true`; `semanticQualityGateValidated=false`; `capacityArchitectureProviderScoped=true`; `groqCapacityPolicyDefined=true`; `groqPacingPolicyDefined=true`; `capacityProductionReady=false`; `schedulerThroughputReady=false`; `productionRoutingEnabled=false`.

## Verificación offline

Pasaron las suites de seis agentes, contratos, evidencia/resolución de Critic, provenance numérica de Editor, registry de Classifier, Ranker, Cloudflare, budget/router/cost policy, reservas, telemetry, pipeline, scheduler, Publisher readiness y production gates. También pasaron `npm run lint`, `npx tsc --noEmit` y `npm run build`. Todas las pruebas fueron offline; las pruebas Cloudflare reportaron cero inferencias.

**10G.7b READY: NO.** El benchmark no se ejecutó: la allowlist supervisada no identifica estos casos reales. Me detengo aquí, sin iniciar 10G.7c ni realizar nuevas llamadas.
