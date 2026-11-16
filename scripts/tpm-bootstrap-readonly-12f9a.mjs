import { writeFile } from "node:fs/promises";
import { createSupabaseServerClient } from "../lib/supabase/server-client.ts";

const fetchRead = globalThis.fetch.bind(globalThis);
const origin = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).origin;
let reads = 0;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  if (url.origin !== origin || !url.pathname.startsWith("/rest/v1/") || !["GET", "HEAD"].includes(method)) throw new Error("TPM_AUDIT_READONLY_GUARD");
  const response = await fetchRead(input, init);
  if (!response.ok) throw new Error(`TPM_AUDIT_HTTP_${response.status}`);
  reads += 1;
  return response;
};
const client = createSupabaseServerClient();
const rows = [];
for (let start = 0; ; start += 500) {
  const page = await client.from("agent_logs").select("id,run_id,agent_name,created_at,provider,provider_unit,provider_unit_amount,payload")
    .eq("step", "provider_request_reserved").or("provider.eq.groq,provider.is.null").order("id").range(start, start + 499);
  if (page.error || !page.data) throw new Error(`TPM_AUDIT_QUERY_FAILED:${page.error?.code ?? "NO_DATA"}`);
  rows.push(...page.data);
  if (page.data.length < 500) break;
}
const ids = [...new Set(rows.map((row) => row.run_id))];
const runs = [];
for (let offset = 0; offset < ids.length; offset += 100) {
  const result = await client.from("agent_runs").select("id,provider,status,started_at,finished_at,updated_at,config,stats").in("id", ids.slice(offset, offset + 100));
  if (result.error || !result.data) throw new Error(`TPM_AUDIT_RUN_QUERY_FAILED:${result.error?.code ?? "NO_DATA"}`);
  runs.push(...result.data);
}
if (runs.length !== ids.length) throw new Error("TPM_AUDIT_PARTIAL_RUN_READ");
const record = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const explain = (referenceTime) => {
  const at = Date.parse(referenceTime);
  const cutoff = at - 60_000;
  const utcDay = referenceTime.slice(0, 10);
  const historicalRows = rows.filter((row) => Date.parse(row.created_at) <= at);
  const inM35Window = historicalRows.filter((row) => {
    const payload = record(row.payload);
    return String(payload.providerRequestDispatched ?? "false") !== "true"
      || Date.parse(payload.dispatchedAt || row.created_at) >= cutoff;
  });
  const unknown = inM35Window.filter((row) => row.provider_unit !== "tokens" || row.provider_unit_amount === null || row.provider_unit_amount < 1);
  return {
    referenceTime, cutoff: new Date(cutoff).toISOString(),
    currentDayReservations: historicalRows.filter((row) => row.created_at.slice(0, 10) === utcDay).length,
    m35ConsideredReservations: inM35Window.length,
    m35UnknownReservations: unknown.length,
    unknownRows: unknown.map((row) => {
      const payload = record(row.payload);
      const run = runs.find((run) => run.id === row.run_id);
      const config = record(run.config);
      const telemetry = record(record(run.stats).telemetry);
      return { id: row.id, runId: row.run_id, agent: row.agent_name, createdAt: row.created_at,
        reservationProvider: row.provider, providerUnit: row.provider_unit, providerUnitAmount: row.provider_unit_amount,
        providerRequestDispatched: payload.providerRequestDispatched ?? null,
        dispatchMarkerPresent: Object.hasOwn(payload, "providerRequestDispatched"), dispatchedAt: payload.dispatchedAt ?? null,
        legacyShape: row.provider_unit === null && row.provider_unit_amount === null
          && row.payload !== null && typeof row.payload === "object" && !Array.isArray(row.payload)
          && ["providerRequestDispatched", "dispatchedAt", "estimatedTokens", "tokenUsageState"].every((key) => !Object.hasOwn(payload, key)),
        payloadAccountingFieldPresence: Object.fromEntries(["providerRequestDispatched", "dispatchedAt", "estimatedTokens", "tokenUsageState"].map((key) => [key, Object.hasOwn(payload, key)])),
        tokenUsageState: payload.tokenUsageState ?? null, estimatedTokens: payload.estimatedTokens ?? null,
        requestDate: payload.requestDate ?? null,
        ageSeconds: (at - Date.parse(row.created_at)) / 1000,
        runProvider: run.provider, runStatus: run.status, runStartedAt: run.started_at, runFinishedAt: run.finished_at, runUpdatedAt: run.updated_at,
        model: config.model ?? null, configProvider: config.provider ?? null,
        telemetryProvider: telemetry.provider ?? null, telemetryDispatched: telemetry.providerRequestDispatched ?? null,
        telemetryRequests: telemetry.providerRequestsUsed ?? null, telemetryTotalTokens: telemetry.totalTokens ?? null,
      };
    }),
  };
};
const output = { completeRead: true, totalReservationsRead: rows.length, totalRunsRead: runs.length,
  historical12f9: explain("2026-10-15T19:40:41.008Z"), current: explain(new Date().toISOString()),
  network: { reads, remoteWrites: 0, providerCalls: 0 }, historicalRowsMutated: false };
await writeFile("artifacts/supervised-cycle-12f9a-tpm-audit.json", `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify({ completeRead: output.completeRead, totalReservationsRead: rows.length, totalRunsRead: runs.length,
  historicalUnknownReservations: output.historical12f9.m35UnknownReservations,
  currentUnknownReservations: output.current.m35UnknownReservations,
  currentDayReservations: output.current.currentDayReservations, network: output.network,
  artifact: "artifacts/supervised-cycle-12f9a-tpm-audit.json" }, null, 2));
