# 12F.12F — observabilidad del límite del runner de preflight

Modo: preflight canónico de solo lectura; claim, resume, proveedores y escrituras remotas permanecen desactivados.

## Clasificación

Clasificación final: REMOTE_PREFLIGHT_FAILURE. Estado: REMOTE_PREFLIGHT_FAILURE. READY FOR CRITIC RESUME: false.

12F.12E actual failure class: LOCAL_BEFORE_NETWORK. Outermost catch: {"file":"scripts/supervised-cycle-12f12e-critic-resume.mjs","function":"main().catch","boundary":"outermost asynchronous entrypoint catch"}. Previous generic masking: {"persistedFailureCode":"PREFLIGHT_OR_RESUME_FAILED","remoteRequestCount":0,"remoteFailureDiagnostics":null,"exactLocalErrorRecoverable":false}.

Intento 12F.12F previo: {"invocationCount":1,"classification":"LOCAL_PREFLIGHT_FAILURE","remoteRequestCount":0,"reason":"REMOTE_NETWORK_GUARD rejected the permitted /rest/v1/regions path before fetch"}. Guard de lectura corregido y probado: {"implementation":"isAllowedSupabaseRequest","basePath":"/rest/v1","routeShape":"three resource segments or four RPC segments","tests":"PASS"}.

## Límite de ejecución

Invocaciones del runner: 1; invocaciones del preflight canónico: 1.

Última fase completada: "PREFLIGHT_CLIENT_READY"; fase fallida: "PREFLIGHT_START"; paso: "pipeline.preflight".

Fases: [{"phase":"RUNNER_START","step":"validate historical construction evidence","timestamp":"2026-10-20T18:49:58.108Z"},{"phase":"RUNNER_START","step":"historical construction evidence available","timestamp":"2026-10-20T18:49:58.109Z"},{"phase":"ENV_VALIDATED","step":"validate server environment presence","timestamp":"2026-10-20T18:49:58.109Z"},{"phase":"ENV_VALIDATED","step":"server environment present; values not recorded","timestamp":"2026-10-20T18:49:58.110Z"},{"phase":"ARTIFACT_PRECONDITION_VALIDATED","step":"reserve versioned 12F.12F artifact paths","timestamp":"2026-10-20T18:49:58.110Z"},{"phase":"ARTIFACT_PRECONDITION_VALIDATED","step":"versioned artifacts reserved without overwriting prior evidence","timestamp":"2026-10-20T18:49:58.112Z"},{"phase":"PIPELINE_CONSTRUCTION_START","step":"createCapacityResumeProductionPipeline","timestamp":"2026-10-20T18:49:58.114Z"},{"phase":"PIPELINE_CONSTRUCTION_COMPLETE","step":"production pipeline constructed","timestamp":"2026-10-20T18:49:58.127Z"},{"phase":"PREFLIGHT_CLIENT_READY","step":"Supabase client and production preflight function ready","timestamp":"2026-10-20T18:49:58.127Z"},{"phase":"PREFLIGHT_START","step":"pipeline.preflight","timestamp":"2026-10-20T18:49:58.128Z"},{"phase":"FIRST_REMOTE_REQUEST_START","step":"production privileged client preflight","timestamp":"2026-10-20T18:49:58.134Z"}].

## Contador de red y precondición de artefactos

Contador: {"remoteRequestCount":4,"firstRemoteOperation":"production privileged client preflight","firstRemoteHttpStatus":null}. Política: {"type":"versioned-phase-paths","refusesExistingPaths":true,"overwriteExistingEvidence":false,"outputPath":"artifacts/supervised-cycle-12f12f-runner-observability-rerun.json","invocationPath":"artifacts/supervised-cycle-12f12f-runner-observability-invocation-rerun.json","documentationPath":"docs/supervised-cycle-12f12f-runner-observability-rerun.md"}.

## Error seguro

Serialización: {"implementation":"captureSafeRunnerError","nameMessageCodeCauseStack":true,"postgrestDetailsHint":true,"secretsRedacted":true}; pruebas de redacción: {"status":"PASS","suite":"scripts/supervised-cycle-12f12f-runner-observability-unit-test.mjs"}.

{"phase":"PREFLIGHT_START","step":"pipeline.preflight","name":"Error","message":"Supabase preflight connection failed","code":null,"details":null,"hint":null,"causeChain":[{"name":"NonErrorThrow","message":"Error: REMOTE_REQUEST_FAILED","code":"","details":"Error: REMOTE_REQUEST_FAILED\n\nCaused by: TypeError: fetch failed\nTypeError: fetch failed\n    at node:internal/deps/undici/undici:13502:13\n    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)\n    at async globalThis.fetch (file:///C:/Users/Diego/OneDrive/Desktop/horizai/horizai/scripts/supervised-cycle-12f12e-critic-resume.mjs:174:22)\n    at async fetchWithRetry (file:///C:/Users/Diego/OneDrive/Desktop/horizai/horizai/node_modules/@supabase/postgrest-js/dist/index.mjs:203:10)\n    at async executeWithRetry (file:///C:/Users/Diego/OneDrive/Desktop/horizai/horizai/node_modules/@supabase/postgrest-js/dist/index.mjs:407:18)\n    at async Object.preflight (file:///C:/Users/Diego/OneDrive/Desktop/horizai/horizai/lib/agents/pipeline/create-production-pipeline.ts:312:124)\n    at async runObservedPhase (file:///C:/Users/Diego/OneDrive/Desktop/horizai/horizai/lib/agents/pipeline/preflight-runner-observability.ts:244:18)\n    at async baselineRead (file:///C:/Users/Diego/OneDrive/Desktop/horizai/horizai/scripts/supervised-cycle-12f12e-critic-resume.mjs:285:22)\n    at async main (file:///C:/Users/Diego/OneDrive/Desktop/horizai/horizai/scripts/supervised-cycle-12f12e-critic-resume.mjs:504:13)","hint":""}],"safeStack":"Error: Supabase preflight connection failed\n    at Object.preflight (file:///C:/Users/Diego/OneDrive/Desktop/horizai/horizai/lib/agents/pipeline/create-production-pipeline.ts:312:204)\n    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)\n    at async runObservedPhase (file:///C:/Users/Diego/OneDrive/Desktop/horizai/horizai/lib/agents/pipeline/preflight-runner-observability.ts:244:18)\n    at async baselineRead (file:///C:/Users/Diego/OneDrive/Desktop/horizai/horizai/scripts/supervised-cycle-12f12e-critic-resume.mjs:285:22)\n    at async main (file:///C:/Users/Diego/OneDrive/Desktop/horizai/horizai/scripts/supervised-cycle-12f12e-critic-resume.mjs:504:13)","safeStackFingerprint":"9211daa236d828f1ee20199fdc5da889c55e661ef41f88bb335337afb413baab"}

## Solicitudes y baseline

Primera operación remota: "production privileged client preflight"; total de solicitudes remotas: 4.

Canonical preflight: {"runnerInvocationCount":1,"invocationCount":1,"status":"FAIL"}.

Resultado de lectura del attempt: null.

Baseline si está disponible: null; evidencia: null.

## Límites

Provider calls=0; claims=0; resumeInvocations=0; remoteWrites=0; scheduler runs: 0; intentos nuevos: 0.
