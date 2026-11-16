# Fase 10G.7a — auditoría de gates, calidad y capacidad

**Resultado de fase: READY YES para cerrar la auditoría offline. Esto no habilita producción.** No se hicieron llamadas a Groq, Cloudflare ni Cerebras; no se ejecutó pipeline/scheduler, no hubo publicaciones, cambios de cuota, cron, deploy o UI. Router y fallback automático de Cloudflare siguen desactivados.

## Alcance y evidencia

Se revisaron código, migraciones, configuración local proyectada sin imprimir valores secretos, reportes JSON y checkpoints. No se leyó Supabase remotamente: se detuvo el acceso después de que una comprobación local expusiera accidentalmente una variable de servicio en la salida de herramienta. Rota esa credencial antes de volver a usar acceso remoto; el valor no se copia aquí.

Las cifras históricas describen únicamente la telemetría/artifacts presentes en el workspace, no una extracción completa de agent_runs/agent_logs. Los datos ausentes o cuya provenance no queda guardada se marcan como insuficientes.

## A. Compatibilidad técnica y gate semántico

La matriz técnica sigue en **6/6**: Verifier, Translator, Editor, Classifier y Ranker REAL_VALIDATED; Critic REAL_VALIDATED_WITH_UNEXERCISED_NONEMPTY_EVIDENCE_BRANCH. Esto acredita compatibilidad de ejecución/schema/guards bajo la muestra supervisada, no calidad editorial.

| Etapa | Brecha semántica pendiente |
|---|---|
| Verifier | Calibración factual no certificada; un fixture dio confirmed/90; no hay calibración estadística de confidence. confidenceScore no constituye prueba factual. |
| Translator | No está certificada determinísticamente la fidelidad factual, calidad del español ni preservación de entidades/nombres. |
| Editor | Contrato, provenance numérica y nombres protegidos tienen controles validados; paridad de estilo editorial con Groq y calidad amplia no certificadas. |
| Classifier | Compatibilidad con registry validada; pertinencia semántica de categoría no certificada. |
| Ranker | Fórmula/campos deterministas validados; calibración subjetiva de impact, novelty y economicImpact no certificada. |
| Critic | Contrato y routing validados; el camino de findings con referencias no se ejercitó en Cloudflare; sensibilidad editorial ante drafts problemáticos no certificada. |

semanticQualityGateValidated permanece false. No se creó LLM-as-judge ni puntuación editorial agregada.

## B. Checkpoints candidatos al benchmark

Los checkpoints locales no incorporan proveedor/modelo dentro de su payload. Son referencias históricas candidatas solo después de confirmar provenance en telemetría persistente.

| Caso | Evidencia local y uso candidato | Trazabilidad/limitación |
|---|---|---|
| event-5c80fcd1a4e5b0d010308f37d646625a — Ars Technica, “Muse, Meta's extraordinarily privileged AI assistant, has a serious 0-day” | Verifier→Ranker y Critic separado; single_source, confidence 85; Critic revise_editorial, 1 issue y 1 unsupported claim. | Lineage coherente: mismo eventKey, sourceId y sourceItemId; estado común Ranker/Critic con fingerprint local idéntico. Supervised snapshot enlaza 1 source item, raw item y content hash. Tiene excerpt de 76 caracteres y 0 caracteres de contenido extraído; no guarda el artículo completo. Buen candidato problemático/input-only. El provider no está en los checkpoints. |
| event-2a0197acd23aa82ff91895e1464d2897 — MIT Technology Review, “The Download: AI’s trillion-dollar gamble and OpenAI’s biology data bid” | Seis etapas en una carpeta; Critic pass, 0 issues; Verifier confirmed/90. Candidato control y pregunta de calibración para confirmación con una fuente. | No se encontró snapshot local que enlace raw item/hash. “Limpio” es solo la decisión histórica del Critic; requiere QA factual y confirmar provenance/proveedor. |
| event-2cc8ba6bc398e171dcca9d833a6b8e31 — TechCrunch, “Flock reportedly tries to shrink workforce with employee buyouts” | Seis etapas; Verifier single_source/80, una claim incierta; Critic revise_editorial, 1 issue y 1 unsupported claim. | Candidato alternativo para Critic. Falta enlace local verificable a raw item/hash; no asumir que el finding es correcto ni que la salida sea Groq. |
| event-a8bad39d6b49d036e7d195796ce3c9d3 — OpenAI News, “Our framework for reporting model misalignment” | Verifier y Translator en dos checkpoints. | Caso parcial: sin outputs downstream ni raw-item snapshot local. |

### Diseño mínimo de primera comparación humana

Una vez confirmada la provenance de los checkpoints y la telemetría histórica, el primer benchmark útil son **8 llamadas Cloudflare**, una por output evaluado, sin repetir Groq:

1. Verifier en dos casos de una fuente: Ars (single_source) y MIT (confirmed/90 histórico, pregunta de calibración, no gold label).
2. Translator y Editor: una llamada cada uno sobre el input factual/name/numeric de Ars.
3. Classifier y Ranker: una llamada cada uno sobre el mismo evento y registry congelado.
4. Critic: una llamada sobre el draft revisado de Ars y otra sobre el control MIT que históricamente pasó.

Son dos eventos únicos y 8 outputs; es un screen inicial, no evidencia suficiente para cambiar el gate semántico. Ambos casos son single-source: no certifican corroboración independiente ni el comportamiento confirmed en cluster multi-source. Si no se obtiene un caso multi-source con lineage completo, limitar explícitamente el resultado de Verifier a estos casos.

El futuro preview humano debe separar SOURCE FACTS (ledger atómico con IDs), GROQ HISTORICAL OUTPUT (solo si provider/model/version/input hash se verifican), CLOUDFLARE OUTPUT, DETERMINISTIC CHECKS, DIFFERENCES, QUALITY QUESTIONS y veredicto humano PASS / REVIEW / FAIL por criterio. No elegir ganador automáticamente. Si la provenance Groq falta, indicar “no verificado”.

Copyright: enviar hechos atómicos y referencias, más solo el excerpt corto necesario para evaluar atribución; no enviar ni mostrar cuerpos completos. Ars local respalda este patrón (excerpt 76 caracteres; contenido extraído 0). Un hash acredita identidad, no sustituye los hechos necesarios al Verifier.

| Etapa | PASS / REVIEW / FAIL |
|---|---|
| Verifier | Ningún verified fact sin soporte; status defendible con las fuentes dadas; IDs resuelven; confidence no se interpreta como prueba. REVIEW ante fuente única o corroboración insuficiente. |
| Translator | Sin claims nuevas; facts/uncertainty uno-a-uno; entidades y números preservados; español legible; sin reproducir artículo completo. |
| Editor | Provenance numérica y nombres en PASS; sin claim no soportada; headline/summary fieles a facts; síntesis española original. |
| Classifier | Categorías existentes en registry; ninguna slug inválida; elección editorial defendible. |
| Ranker | Señales deterministas/fórmula exactas; dimensiones subjetivas plausibles, sin exigir igualdad numérica con Groq; sin extremo inexplicado. |
| Critic | Detecta defecto grave conocido; evidence refs resuelven; no rechaza control limpio por defecto inventado. |

## C. Telemetría Groq y límites efectivos

Los reports de fixtures locales usan el modelo openai/gpt-oss-20b, pero no guardan proveedor de forma explícita; los checkpoints de evento tampoco. La atribución Groq completa es INSUFFICIENT_SAMPLE. No calcular percentiles con N=1:

| Etapa | Reports locales success | Input/output/total tokens | Latencia | HTTP/provenance |
|---|---:|---:|---:|---|
| Verifier | 1 fixture | 976 / 206 / 1,182 | 986 ms | HTTP 200; provider no explícito |
| Translator | 1 fixture | 999 / 723 / 1,722 | 1,418 ms | HTTP 200; provider no explícito |
| Editor | 0 | — | — | Último artifact falla pre-dispatch, attempts=0 |
| Classifier | 1 fixture | 723 / 105 / 828 | 831 ms | HTTP 200; provider no explícito |
| Ranker | 1 fixture | 658 / 105 / 763 | 900 ms | Status success; HTTP no persistido |
| Critic | 0 telemetry | — | — | Report local not_run; checkpoint editorial sin telemetry/provider |

Median/p75/p90/max de llamadas Groq reales y estadística full-event: INSUFFICIENT_SAMPLE; obtener las filas `agent_runs`/`agent_logs` que acrediten proveedor/modelo requiere `REMOTE_DATA_REQUIRED_AFTER_CREDENTIAL_ROTATION`. Los cuatro registros de tokens pertenecen a event/fixture keys distintos y no se suman como un evento. Path nominal: 6 requests; hasta 2 retries en cada una de seis etapas permiten hasta 18 intentos, no 18 éxitos.

| Configuración | Estado auditado |
|---|---|
| AGENT_DAILY_REQUEST_LIMIT | Ausente en .env.local; default interno 20, máximo validado 20. Activo como ledger global, no solo Groq. |
| Reserva provider-scoped | Existe migración/método reserve_provider_agent_request, pero AgentRunner usa reserveRequest → RPC reserve_agent_request. El camino provider-scoped no está conectado al runtime común; no atribuir budgets separados a Groq/Cloudflare. |
| Groq daily caps de router | GROQ_FREE_DAILY_TOKEN_LIMIT y GROQ_FREE_DAILY_REQUEST_LIMIT ausentes; la capacity config del router queda sin configurar. |
| Soft ratio | 0.85 default del router. No suple los caps ausentes ni se aplica como capacidad diaria del guard global. |
| TPM/RPM | GROQ_FREE_MINUTE_TOKEN_LIMIT y GROQ_FREE_MINUTE_REQUEST_LIMIT ausentes. Dos reports conservan headers crudos tokens=8000 y requests=1000; provider/window no identificados en esos artifacts, no equivalen a configuración de cuenta. |
| HTTP 429/reset | El estado de fase informa al menos un 429 de Critic tras etapas secuenciales con cuota diaria disponible; artifact local no guarda respuesta ni headers. Reset y causa TPM/RPM exactos: desconocidos. |

Burst: **BURST_RISK** (429 reportado tras la cadena), pero no se afirma causalidad TPM. Diseño futuro: antes de asignar siguiente etapa/evento revisar tokensRemaining, requestsRemaining, reset, blockedUntil, tokens estimados para siguiente request y worst-case del evento. Sin headroom conocido: WAIT/DEFER o enrutar el próximo evento a Cloudflare solo si pasan todos los gates; nunca switch dentro del evento ni sleep arbitrario. No se implementa pacing.

Capacidad diaria basada solo en requests: floor(20/6)=3 paths nominales, antes de retries/skips/fallos. Capacidad por límite diario de tokens/soft tokens: INSUFFICIENT_SAMPLE, no configurada. TPM no se convierte en TPD.

## D. Cloudflare y settlement

| Parámetro | Valor |
|---|---:|
| Hard allocation | 10,000 Neurons/día |
| Soft limit | 85% = 8,500 Neurons/día |
| Reserva conservadora seis etapas | 2,381 Neurons/evento |
| Capacidad limpia sin settlement/retries | floor(8500/2381)=3 eventos/día |
| Reservas observadas en validaciones supervisadas | 2,388 total, N=1 por etapa; no es la reserva planner del full event |
| Estimación post-response token-derived | 405 Neurons/evento; floor(8500/405)=20 teóricos |

405 es TOKEN_DERIVED_ESTIMATE, N=1/STAGE, NOT_PROVIDER_ACTUAL. Cloudflare no reportó Neurons reales por request; 20 no es capacidad de admisión. La reserva de 2,381 sigue siendo el criterio operativo.

Rates del repo para el modelo de validación Llama: 26,668 input y 204,805 output Neurons por 1M tokens, margen 12,500 bps (1.25x); overrides no configurados. Fórmula central: ceil((ceil(inputTokens*inputRate/1M) + ceil(outputTokens*outputRate/1M))*margin/10000), con usage input/output devuelto por proveedor para la estimación post-response. Sin multiplicador oculto por stage. Sin usage real, no hay ajuste a la baja.

**Settlement: `UNDETERMINED_PENDING_REMOTE_TELEMETRY`; no implementar en 10G.7a.** Cloudflare conservador permite 3 eventos, pero el ledger global de 20 requests también limita el total combinado a 3 paths nominales; liberar Neurons no aumenta ese ledger. Faltan Neurons reales, límites Groq por tokens y yield editorial. Settlement no está probado necesario ni suficiente; primero se necesita provider-scoped accounting y más telemetría. Los tests cubren ramas hipotéticas de capacidad suficiente y de settlement potencialmente habilitante con uso real conocido; la decisión real queda pendiente de telemetría posterior a la rotación.

## E. Simulaciones y yield

No equiparar candidatos, paths completos, Critic pass o artículos. Historial de yield: YIELD_SAMPLE_INSUFFICIENT. Snapshot local registra 0 artículos; esta auditoría creó 0.

| Candidatos/día | Groq only (ledger global; 6 req/path) | Cloudflare conservador + ledger | Mixto con ledger global | Mixto hipotético con budgets scoped y gates en true |
|---:|---|---|---|---|
| 10 | 3 admitidos, 7 fuera; 60 requests requeridas | 3; 23,810 Neurons, 15,310 sobre soft | 3; Groq usa 18 requests, quedan 2 (<6); 7 bloqueados | 6 (3 Groq + 3 CF), 4 bloqueados |
| 12 | 3 admitidos, 9 fuera; 72 requests | 3; 28,572 Neurons, 20,072 sobre soft | 3; 9 bloqueados | 6; 6 bloqueados |
| 15 | 3 admitidos, 12 fuera; 90 requests | 3; 35,715 Neurons, 27,215 sobre soft | 3; 12 bloqueados | 6; 9 bloqueados |

Modelo conservador sin retries ni consumo previo. Provider-scoped es hipotético porque AgentRunner no lo usa. Router actual desactivado: asignaciones automáticas actuales=0. Ningún número de candidates/paths garantiza 10 artículos sin yield de insuficiencia de verificación, fallos, rechazo, revisión y Critic pass.

La simulación offline del router con un fixture de 10 eventos completa 6 rutas Groq (36 reservas stage) y bloquea el séptimo. Incluso al suministrar gates hipotéticos true, Cloudflare queda rechazado por `STRUCTURED_OUTPUT_NOT_PRODUCTION_APPROVED`; por tanto, no simula fallback Cloudflare hasta que exista una aprobación de modelo real. La simulación no cambia la configuración productiva ni realiza llamadas.

## F. Scheduler

- Tres slots conceptuales morning/afternoon/night; timezone por defecto Europe/Madrid.
- SCHEDULER_MAX_EVENTS_PER_RUN default 3 en planner: techo de planificación 3×3=9 candidatos/día si hubiera un trigger por slot.
- El bridge scheduler-execution fuerza EXECUTION_MAX_EVENTS_PER_RUN=1, dryRun=true, publish=false y trigger test:*.
- netlify.toml no declara schedule; techo automático activo=0. El repo no configura timeout/runtime de Netlify y no se consultó documentación externa.

El techo de planificación 9 es menor que 10 artículos target y 12–15 candidatos. Aumentar maxEvents no resuelve el ledger global ni el yield.

| Opción | Ventaja | Límite |
|---|---|---|
| A. 4 eventos/run × 3 slots = 12 candidatos/día | Puede alcanzar el mínimo de candidatos si cada slot drena el batch. | El bridge actual fija 1; no hay presupuesto comprobado para 12 paths ni ejecución Netlify configurada. |
| B. 5 eventos/run × 3 slots = 15 candidatos/día | Da margen para rechazos y revisión. | Mayor duración/burst; cuotas y rendimiento editorial no lo sostienen con la evidencia local. |
| C. Más slots con batches menores | Mejor frescura y dispersión del burst. | No aumenta presupuesto diario/LLM y hoy no hay schedule activo. |
| D. Cola capacity-driven (recomendado) | Descubre en slots, procesa un evento elegible, reevalúa headroom y conserva stickiness. | Primero requiere resolver scoped ledger, límites de ejecución y reanudación durable; no implementar aquí. |

**Propuesta inicial de techo: no aprobar todavía 12–15 candidatos/día.** El planner permite 9 teóricos, el bridge solo 1 por ejecución, la programación automática activa es 0 y la capacidad del proveedor/yield no respaldan el objetivo. 12–15 es una meta de diseño condicionada a telemetría, budget provider-scoped, disponibilidad real de ejecución y yield; hoy el estado es `SCHEDULER_THROUGHPUT_BELOW_PRODUCT_TARGET`.

Diseño futuro: slot → discovery/extraction/clustering → cola → leer headroom → claim evento → fijar proveedor → terminar sin switch → persistir outcome → recalcular antes del siguiente claim. Con rolling headroom bajo, deferir al reset conocido o elegir Cloudflare para el próximo evento solo si todos los gates pasan. No preasignar la cuota al iniciar el día.

## G. Activation gates y router

La elegibilidad Cloudflare exige independientemente 6/6 técnico, gate semántico, capacidad operacional, scheduler throughput, safety free-only y routing explícito, además del router y capacity momentánea. Gate ausente/false falla cerrado. Groq preferido no cambia.

| Gate | Estado actual |
|---|---|
| technicalAllStagesValidated | true (6/6, con caveat del Critic) |
| semanticQualityGateValidated | false |
| capacityProductionReady | false (límites Groq incompletos, ledger compartido, Cloudflare conservador 3, yield insuficiente) |
| schedulerThroughputReady | false (sin schedule, bridge 1, planner 9) |
| freeOnlySafetyValidated | PASS por policy auditada: allowlist free, sin paid fallback, Cerebras trial-only rechazado. El helper runtime queda fail-closed si no recibe aprobación explícita. |
| productionRoutingEnabled | false |

Tests retiran un gate cada vez y confirman bloqueo aunque 6/6 técnico y capacity hipotética estén true. No se activaron flags.

## H. Seguridad, rotación y cierre

`supabaseServiceCredentialRotationRequired=true`; `remoteOperationsAllowed=false`. El motivo es una exposición previa de la credencial de servicio en salida de herramienta. Esta fase no consultó Supabase remoto; no se incluyen valores secretos ni se intenta comprobar la credencial.

Checklist exclusivamente posterior a la rotación, aún pendiente:

1. Actualizar el secreto local por un canal seguro; no pegarlo en chat, documentación o logs.
2. Confirmar con el operador de Supabase que la credencial anterior está revocada y ya no funciona.
3. Verificar la nueva credencial mediante una comprobación de conectividad de solo lectura y alcance mínimo.
4. Buscar persistencia accidental en archivos, artifacts, logs y el historial del repositorio; no copiar el valor al reporte.
5. Solo entonces permitir la auditoría remota acotada de `agent_runs`/`agent_logs` y límites del proveedor.

No ejecutar estos pasos remotos como parte de 10G.7a.

## I. Pruebas y cierre

Nuevo test: `npm run cloudflare:production-gate:10g7a:unit` (offline). Cubre independencia de gates, selector fail-closed, techo global legacy, simulaciones 10/12/15, mezcla hipotética, slots/límites scheduler y ramas hipotéticas de settlement. Sin llamadas a proveedores. La simulación de router actualizada también valida el bloqueo real de Cloudflare por aprobación ausente.

Regresión offline final: 24/24 suites de agentes/proveedores/runtime y 22/22 suites de pipeline/scheduler/checkpoints pasaron; `npm run lint`, `npx tsc --noEmit` y `npm run build` pasaron. Una primera invocación exploratoria a `ranker:checkpoint:unit` devolvió “Missing script”; ese nombre no existe en package.json, el test `ranker:unit` sí pasó y la batería corregida terminó 22/22.

Snapshot machine-readable sin secretos: `artifacts/cloudflare-production-gate-10g7a.json`. Cada medición queda etiquetada mediante `measurementProvenance` (JSON-Pointer con wildcards y prioridad por regla más específica); la etiqueta por defecto es `LOCAL_ARTIFACT`, con overrides para `CONFIGURED`, `ESTIMATED`, `TOKEN_DERIVED_ESTIMATE`, `INSUFFICIENT_SAMPLE` y `REMOTE_DATA_REQUIRED`.

**10G.7a READY: YES como fase de auditoría offline; producción NO está lista.** Siguiente fase propuesta: 10G.7b — minimal real quality benchmark, solo después de validar provenance Groq y rotar/validar credencial para lectura segura de telemetría. 10G.7b no se ejecutó.
