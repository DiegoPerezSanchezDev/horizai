import { mkdir, writeFile } from "node:fs/promises";
import { buildCloudflareStageCapacityReport } from "../lib/agents/runtime/cloudflare-stage-capacity.ts";
import { estimateCloudflareNeurons, readCloudflareNeuronRates } from "../lib/agents/runtime/free-provider-router.ts";
import {
  cloudflareAllRequiredStagesValidated,
  getCloudflareActivationGateState,
  normalEventStages,
  supervisedValidationAgentVersionAllowlist,
  supervisedValidationFixtureAllowlist,
} from "../lib/agents/runtime/cloudflare-stage-validation.ts";
import { CLOUDFLARE_LLAMA_VALIDATION_MODEL } from "../lib/agents/runtime/provider-cost-policy.ts";
import { createSupabaseServerClient } from "../lib/supabase/server-client.ts";

type JsonObject = Record<string, unknown>;

function check(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code);
}

function object(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : {};
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`BLOCKED_MISSING_${name}`);
  return value;
}

async function latestValidatedStageSample(db: ReturnType<typeof createSupabaseServerClient>, stage: (typeof normalEventStages)[number]) {
  const purpose = `${stage}_stage_validation`;
  const response = await db.from("agent_logs")
    .select("id,run_id,created_at,payload,provider")
    .eq("step", `${stage}_stage_validation_result`)
    .eq("provider", "cloudflare_workers_ai")
    .order("created_at", { ascending: false })
    .limit(100);
  check(!response.error && response.data, "BLOCKED_STAGE_VALIDATION_LOG_READ");

  for (const summaryLog of response.data) {
    const payload = object(summaryLog.payload);
    const details = object(payload.details);
    if (payload.validationPurpose !== purpose
      || details.validationPurpose !== purpose
      || details.stageValidationStatus !== "REAL_VALIDATED"
      || (stage !== "critic" && details.fixture !== supervisedValidationFixtureAllowlist[stage])
      || details.agentVersion !== supervisedValidationAgentVersionAllowlist[stage]
      || details.provider !== "cloudflare_workers_ai"
      || details.model !== CLOUDFLARE_LLAMA_VALIDATION_MODEL) continue;

    const runResponse = await db.from("agent_runs")
      .select("id,status,provider,dry_run,config,stats,started_at")
      .eq("id", summaryLog.run_id)
      .maybeSingle();
    check(!runResponse.error && runResponse.data, "BLOCKED_STAGE_VALIDATION_RUN_READ");
    const run = runResponse.data;
    const config = object(run.config);
    const stats = object(run.stats);
    const telemetry = object(stats.telemetry);
    if (run.status !== "succeeded" || run.provider !== "cloudflare_workers_ai" || run.dry_run !== true
      || config.validationPurpose !== purpose
      || (stage !== "critic" && config.fixture !== supervisedValidationFixtureAllowlist[stage])
      || config.agentName !== stage
      || config.agentVersion !== supervisedValidationAgentVersionAllowlist[stage]
      || telemetry.provider !== "cloudflare_workers_ai" || telemetry.model !== CLOUDFLARE_LLAMA_VALIDATION_MODEL
      || telemetry.providerHttpStatus !== 200 || telemetry.attempts !== 1 || telemetry.retries !== 0) continue;

    const reservationResponse = await db.from("agent_logs")
      .select("provider,provider_unit,provider_unit_amount,payload,created_at")
      .eq("run_id", run.id)
      .eq("step", "provider_request_reserved")
      .maybeSingle();
    check(!reservationResponse.error && reservationResponse.data, "BLOCKED_STAGE_RESERVATION_LOG_READ");
    const reservation = reservationResponse.data;
    const reservationPayload = object(reservation.payload);
    const inputTokens = telemetry.inputTokens;
    const outputTokens = telemetry.outputTokens;
    check(reservation.provider === "cloudflare_workers_ai" && reservation.provider_unit === "neurons"
      && Number.isSafeInteger(reservation.provider_unit_amount) && (reservation.provider_unit_amount ?? 0) > 0,
    "BLOCKED_STAGE_RESERVATION_TELEMETRY_INVALID");
    check(reservationPayload.validationPurpose === purpose && reservationPayload.providerRequestDispatched === true,
      "BLOCKED_STAGE_RESERVATION_NOT_DISPATCHED");
    check(Number.isSafeInteger(inputTokens) && Number.isSafeInteger(outputTokens)
      && Number.isSafeInteger(telemetry.totalTokens) && (inputTokens as number) + (outputTokens as number) <= (telemetry.totalTokens as number),
    "BLOCKED_STAGE_TOKEN_TELEMETRY_UNKNOWN");

    const rates = readCloudflareNeuronRates(process.env, CLOUDFLARE_LLAMA_VALIDATION_MODEL);
    const postResponseEstimatedNeurons = estimateCloudflareNeurons({ inputTokens: inputTokens as number, outputTokens: outputTokens as number, ...rates });
    const recordedPostResponseEstimate = details.postResponseEstimatedNeurons
      ?? details.postResponseEstimateNeurons
      ?? details.postResponseNeuronEstimate;
    if (!Number.isSafeInteger(recordedPostResponseEstimate) || recordedPostResponseEstimate !== postResponseEstimatedNeurons) {
      const recordedSafe = Number.isSafeInteger(recordedPostResponseEstimate) ? String(recordedPostResponseEstimate) : "UNKNOWN";
      throw new Error(`BLOCKED_STAGE_POST_RESPONSE_ESTIMATE_MISMATCH_${stage.toUpperCase()}_RECORDED_${recordedSafe}_CALCULATED_${postResponseEstimatedNeurons}`);
    }
    check(details.estimatedReservationNeurons === reservation.provider_unit_amount, "BLOCKED_STAGE_RESERVATION_ESTIMATE_MISMATCH");

    return {
      stage,
      status: details.stageValidationStatus,
      runId: run.id,
      validatedAt: summaryLog.created_at,
      agentVersion: supervisedValidationAgentVersionAllowlist[stage],
      fixture: {
        expected: supervisedValidationFixtureAllowlist[stage],
        persisted: config.fixture ?? details.fixture ?? null,
        evidence: stage === "critic" ? "critic-v3 supervised harness uses canonicalCriticInput; historical run did not persist the fixture slug" : "persisted in supervised validation metadata",
      },
      model: CLOUDFLARE_LLAMA_VALIDATION_MODEL,
      attempts: telemetry.attempts,
      retries: telemetry.retries,
      inputTokens,
      outputTokens,
      totalTokens: telemetry.totalTokens,
      reservedNeurons: reservation.provider_unit_amount,
      postResponseEstimatedNeurons,
      actualProviderNeurons: "UNKNOWN",
      reservationToPostResponseEstimateRatio: Number(((reservation.provider_unit_amount as number) / postResponseEstimatedNeurons).toFixed(2)),
      estimateMethod: "Persisted input/output tokens × current model-specific rates and safety margin; not provider-reported actual usage",
    };
  }
  throw new Error(`BLOCKED_NO_REAL_VALIDATED_SAMPLE_${stage.toUpperCase()}`);
}

async function main(): Promise<void> {
  requiredEnv("NEXT_PUBLIC_SUPABASE_URL");
  requiredEnv("SUPABASE_SECRET_KEY");
  const db = createSupabaseServerClient();
  const stageSamples = await Promise.all(normalEventStages.map((stage) => latestValidatedStageSample(db, stage)));
  check(cloudflareAllRequiredStagesValidated(), "BLOCKED_STAGE_MATRIX_INCOMPLETE");

  const capacityReport = buildCloudflareStageCapacityReport();
  const reservedTotal = stageSamples.reduce((sum, stage) => sum + (stage.reservedNeurons as number), 0);
  const postResponseTotal = stageSamples.reduce((sum, stage) => sum + stage.postResponseEstimatedNeurons, 0);
  const softCap = capacityReport.softNeuronCap;
  const snapshot = {
    phase: "10G.6e",
    generatedAt: new Date().toISOString(),
    samples: "one real supervised technical validation per stage (N=1/stage)",
    status: "OFFLINE_OBSERVED_ESTIMATE_NOT_PRODUCTION_GUARANTEE",
    provider: "cloudflare_workers_ai",
    model: CLOUDFLARE_LLAMA_VALIDATION_MODEL,
    stageSamples,
    sumRealValidationReservations: reservedTotal,
    sumPostResponseNeuronEstimates: postResponseTotal,
    overallReservationToPostResponseEstimateRatio: postResponseTotal > 0 ? Number((reservedTotal / postResponseTotal).toFixed(2)) : null,
    estimateLabel: "Post-response Neurons are token-based estimates, not provider-reported actual Neurons; no settlement is implemented.",
    conservativeFullEventReservationEstimate: capacityReport.conservativeFullEventReservationEstimate,
    conservativeAdmissionCapacity: Math.floor(softCap / capacityReport.conservativeFullEventReservationEstimate),
    observedStyleFullEventNeuronEstimate: postResponseTotal,
    observedStyleTheoreticalCapacity: postResponseTotal > 0 ? Math.floor(softCap / postResponseTotal) : null,
    observedStyleCapacityLabel: "Informational only; N=1 per stage; estimate, not provider actual usage or production guarantee.",
    softCapNeurons: softCap,
    hardAllocationNeurons: capacityReport.dailyNeuronAllocation,
    conservativeStageEstimates: capacityReport.stages.map(({ stage, fixture, reservationNeurons, estimatedInputTokens, maxOutputTokens }) => ({
      stage, fixture, reservationNeurons, estimatedInputTokens, maxOutputTokens,
    })),
    technicalAllStagesValidated: cloudflareAllRequiredStagesValidated(),
    activationGateState: getCloudflareActivationGateState(),
    semanticRankingQuality: "NOT_CERTIFIED",
    productionRouterEnabled: false,
    publishedArticles: 0,
  };
  check(snapshot.activationGateState.technicalAllStagesValidated === true
    && snapshot.activationGateState.semanticQualityGateValidated === false
    && snapshot.activationGateState.capacityProductionReady === false
    && snapshot.activationGateState.productionRoutingEnabled === false,
  "BLOCKED_ACTIVATION_GATES_COLLAPSED_OR_ENABLED");

  await mkdir("artifacts", { recursive: true });
  await writeFile("artifacts/cloudflare-capacity-snapshot-10g6e.json", `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
}

main().catch((error: unknown) => {
  const code = error instanceof Error && /^[A-Z0-9_:-]{3,120}$/.test(error.message)
    ? error.message
    : "BLOCKED_CLOUDFLARE_CAPACITY_SNAPSHOT";
  process.stderr.write(`${JSON.stringify({ status: "SNAPSHOT_BLOCKED", code })}\n`);
  process.exitCode = 1;
});
