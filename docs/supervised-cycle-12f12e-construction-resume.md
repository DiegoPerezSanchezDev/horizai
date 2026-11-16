# 12F.12E — diagnóstico de construcción y reanudación protegida

## Resultado 12F.12D

12F.12D falló antes de una lectura remota: sí. El PGRST303 histórico sigue clasificado INSUFFICIENT_EVIDENCE; no se atribuye a auth ni ACL.

## Construcción local

Camino: createCapacityResumeProductionPipeline → createProductionPipeline. Reproducción local: true; causa: NON_REPRODUCIBLE; error capturado: null.

Pasos: resume.supabase-client → resume.agent-logger → resume.create-production-pipeline → provider-router.guard → supabase.client → runtime.agent-logger → provider.client → provider.groq-capacity-limits → provider.model-config.verifier → provider.model-config.translator → provider.model-config.editor → provider.model-config.classifier → provider.model-config.ranker → provider.model-config.critic → provider.cost-guard.verifier → provider.cost-guard.translator → provider.cost-guard.editor → provider.cost-guard.classifier → provider.cost-guard.ranker → provider.cost-guard.critic → provider.request-budget → pipeline.quota → pipeline.checkpoint-root → agent.verifier → agent.translator → agent.editor → agent.classifier → agent.ranker → agent.critic → repository.event-attempt-registry → repository.factual-remediation → repository.human-review → classifier.reference-registry-promise → pipeline.stage-wiring → pipeline.config → pipeline.orchestrator → pipeline.preflight-function → pipeline.return.

Traza de construcción: cliente Supabase → logger → provider/configuración Groq y modelos → presupuesto/cuota → seis agentes → repositorios → stage wiring → config → orquestador → función preflight. La función preflight se crea; no se ejecuta durante el diagnóstico local.

## Configuración y paridad

Estados de configuración (sin valores): {"supabaseUrl":{"presence":"PRESENT","format":"VALID_FORMAT"},"supabaseServerSecret":{"presence":"PRESENT","format":"VALID_FORMAT","credentialClass":"Supabase server secret"},"groq":{"provider":"VALID_FORMAT","endpoint":"VALID_FORMAT","key":"PRESENT","modelIdentifiers":{"AGENT_MODEL_VERIFY":"PRESENT","AGENT_MODEL_TRANSLATE":"PRESENT","AGENT_MODEL_EDITOR":"PRESENT","AGENT_MODEL_CLASSIFY":"PRESENT","AGENT_MODEL_RANK":"PRESENT","AGENT_MODEL_CRITIC":"PRESENT"}},"supervisedMode":"CONFIGURED_BY_RUNNER","freeProviderRouter":"DISABLED"}.

Construcción fresh-process/resume/daily y configuración canónica: {"productionFactory":"PASS","freshProcess":"PASS","resumeOriented":"PASS","dailyRunOriented":"PASS","sameCanonicalConfiguration":"PASS","remoteRequests":0,"providerCalls":0}.

## Gates locales

Focused suites: PASS; lint PASS; TypeScript PASS; build PASS; diff-check PASS; secret audit PASS.

## Preflight y reanudación

Preflight remoto canónico: FAIL (invocaciones 1). Diagnóstico remoto: null.

Intento: 4658d5c0-857c-4ed5-b97f-afb133b2bf22; estado: null; claim: NOT_RUN; resume: {"invocationCount":0,"stage":"critic","generationBefore":1,"generationAfter":null}; Critic: null; M34: null; M32: null; review: null.

Provider accounting: {"providerCalls":0,"remoteWrites":0,"remoteReadsAttempted":0}; publisher: NOT RUN.

Estado público final: null; clasificación: REMOTE_PREFLIGHT_FAILURE; ready for human action: false.
