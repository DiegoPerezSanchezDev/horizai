# 12F.12F — observabilidad del límite del runner de preflight

Modo: preflight canónico de solo lectura; claim, resume, proveedores y escrituras remotas permanecen desactivados.

## Clasificación

Clasificación final: LOCAL_PREFLIGHT_FAILURE. Estado: LOCAL_PREFLIGHT_FAILURE. READY FOR CRITIC RESUME: false.

12F.12E actual failure class: LOCAL_BEFORE_NETWORK. Outermost catch: {"file":"scripts/supervised-cycle-12f12e-critic-resume.mjs","function":"main().catch","boundary":"outermost asynchronous entrypoint catch"}. Previous generic masking: {"persistedFailureCode":"PREFLIGHT_OR_RESUME_FAILED","remoteRequestCount":0,"remoteFailureDiagnostics":null,"exactLocalErrorRecoverable":false}.

## Límite de ejecución

Invocaciones del runner: 1; invocaciones del preflight canónico: 1.

Última fase completada: "PREFLIGHT_CLIENT_READY"; fase fallida: "PREFLIGHT_START"; paso: "pipeline.preflight".

Fases: [{"phase":"RUNNER_START","step":"validate historical construction evidence","timestamp":"2026-10-20T18:01:21.040Z"},{"phase":"RUNNER_START","step":"historical construction evidence available","timestamp":"2026-10-20T18:01:21.043Z"},{"phase":"ENV_VALIDATED","step":"validate server environment presence","timestamp":"2026-10-20T18:01:21.043Z"},{"phase":"ENV_VALIDATED","step":"server environment present; values not recorded","timestamp":"2026-10-20T18:01:21.043Z"},{"phase":"ARTIFACT_PRECONDITION_VALIDATED","step":"reserve versioned 12F.12F artifact paths","timestamp":"2026-10-20T18:01:21.043Z"},{"phase":"ARTIFACT_PRECONDITION_VALIDATED","step":"versioned artifacts reserved without overwriting prior evidence","timestamp":"2026-10-20T18:01:21.046Z"},{"phase":"PIPELINE_CONSTRUCTION_START","step":"createCapacityResumeProductionPipeline","timestamp":"2026-10-20T18:01:21.048Z"},{"phase":"PIPELINE_CONSTRUCTION_COMPLETE","step":"production pipeline constructed","timestamp":"2026-10-20T18:01:21.071Z"},{"phase":"PREFLIGHT_CLIENT_READY","step":"Supabase client and production preflight function ready","timestamp":"2026-10-20T18:01:21.071Z"},{"phase":"PREFLIGHT_START","step":"pipeline.preflight","timestamp":"2026-10-20T18:01:21.074Z"}].

## Contador de red y precondición de artefactos

Contador: {"remoteRequestCount":0,"firstRemoteOperation":null,"firstRemoteHttpStatus":null}. Política: {"type":"versioned-phase-paths","refusesExistingPaths":true,"overwriteExistingEvidence":false,"outputPath":"artifacts/supervised-cycle-12f12f-runner-observability.json","invocationPath":"artifacts/supervised-cycle-12f12f-runner-observability-invocation.json","documentationPath":"docs/supervised-cycle-12f12f-runner-observability.md"}.

## Error seguro

Serialización: {"implementation":"captureSafeRunnerError","nameMessageCodeCauseStack":true,"postgrestDetailsHint":true,"secretsRedacted":true}; pruebas de redacción: {"status":"PASS","suite":"scripts/supervised-cycle-12f12f-runner-observability-unit-test.mjs"}.

{"phase":"PREFLIGHT_START","step":"pipeline.preflight","name":"Error","message":"Supabase preflight connection failed","code":null,"details":null,"hint":null,"causeChain":[{"name":"NonErrorThrow","message":"Error: REMOTE_NETWORK_GUARD","code":"","details":"Error: REMOTE_NETWORK_GUARD\n    at globalThis.fetch (file:///C:/Users/Diego/OneDrive/Desktop/horizai/horizai/scripts/supervised-cycle-12f12e-critic-resume.mjs:159:48)\n    at file:///C:/Users/Diego/OneDrive/Desktop/horizai/horizai/node_modules/@supabase/supabase-js/dist/index.mjs:263:22\n    at file:///C:/Users/Diego/OneDrive/Desktop/horizai/horizai/node_modules/@supabase/supabase-js/dist/index.mjs:313:10\n    at async fetchWithRetry (file:///C:/Users/Diego/OneDrive/Desktop/horizai/horizai/node_modules/@supabase/postgrest-js/dist/index.mjs:203:10)\n    at async executeWithRetry (file:///C:/Users/Diego/OneDrive/Desktop/horizai/horizai/node_modules/@supabase/postgrest-js/dist/index.mjs:407:18)\n    at async Object.preflight (file:///C:/Users/Diego/OneDrive/Desktop/horizai/horizai/lib/agents/pipeline/create-production-pipeline.ts:312:124)\n    at async runObservedPhase (file:///C:/Users/Diego/OneDrive/Desktop/horizai/horizai/lib/agents/pipeline/preflight-runner-observability.ts:244:18)\n    at async baselineRead (file:///C:/Users/Diego/OneDrive/Desktop/horizai/horizai/scripts/supervised-cycle-12f12e-critic-resume.mjs:281:22)\n    at async main (file:///C:/Users/Diego/OneDrive/Desktop/horizai/horizai/scripts/supervised-cycle-12f12e-critic-resume.mjs:500:13)","hint":""}],"safeStack":"Error: Supabase preflight connection failed\n    at Object.preflight (file:///C:/Users/Diego/OneDrive/Desktop/horizai/horizai/lib/agents/pipeline/create-production-pipeline.ts:312:204)\n    at async runObservedPhase (file:///C:/Users/Diego/OneDrive/Desktop/horizai/horizai/lib/agents/pipeline/preflight-runner-observability.ts:244:18)\n    at async baselineRead (file:///C:/Users/Diego/OneDrive/Desktop/horizai/horizai/scripts/supervised-cycle-12f12e-critic-resume.mjs:281:22)\n    at async main (file:///C:/Users/Diego/OneDrive/Desktop/horizai/horizai/scripts/supervised-cycle-12f12e-critic-resume.mjs:500:13)","safeStackFingerprint":"8bb838c79797b0a6c7f2e0908dcb8492f0d0451fa58343e766b169931ed04d86"}

## Solicitudes y baseline

Primera operación remota: null; total de solicitudes remotas: 0.

Canonical preflight: {"runnerInvocationCount":1,"invocationCount":1,"status":"FAIL"}.

Resultado de lectura del attempt: null.

Baseline si está disponible: null; evidencia: null.

## Límites

Provider calls=0; claims=0; resumeInvocations=0; remoteWrites=0; scheduler runs: 0; intentos nuevos: 0.
