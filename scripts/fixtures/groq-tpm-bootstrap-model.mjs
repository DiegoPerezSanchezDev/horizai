// Deterministic oracle for the proposed SQL predicate. It does not run against a DB or admit production requests.
export function localMinuteUsage({ readSucceeded = true, complete = true, rows = [], runs = [], now }) {
  if (!readSucceeded) throw new Error("ACCOUNTING_QUERY_FAILURE");
  if (!complete) throw new Error("PARTIAL_ACCOUNTING_STATE");
  const at = Date.parse(now);
  if (!Number.isFinite(at)) throw new Error("MALFORMED_ACCOUNTING_STATE");
  const cutoff = at - 60_000;
  let tokens = 0, included = 0, excludedLegacy = 0;
  const ids = new Set();
  for (const row of rows) {
    if (ids.has(row.id)) throw new Error("PARTIAL_ACCOUNTING_STATE");
    ids.add(row.id);
    const payload = row.payload;
    const created = Date.parse(row.createdAt);
    if (!Number.isFinite(created) || created > at || !payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("MALFORMED_ACCOUNTING_STATE");
    const run = runs.find((run) => run.id === row.runId);
    if (!run) throw new Error("PARTIAL_ACCOUNTING_STATE");
    const finish = Date.parse(run.finishedAt);
    const start = Date.parse(run.startedAt);
    const updated = Date.parse(run.updatedAt);
    const legacy = row.providerUnit === null && row.providerUnitAmount === null
      && ["providerRequestDispatched", "dispatchedAt", "estimatedTokens", "tokenUsageState"].every((name) => !Object.hasOwn(payload, name));
    if (legacy && run.provider === "groq" && ["succeeded", "failed"].includes(run.status)
      && Number.isFinite(finish) && Number.isFinite(start) && Number.isFinite(updated)
      && Math.max(finish, start, updated, created) <= cutoff) {
      excludedLegacy += 1;
      continue;
    }
    const marker = payload.providerRequestDispatched;
    if (marker !== undefined && typeof marker !== "boolean") throw new Error("MALFORMED_ACCOUNTING_STATE");
    const dispatched = marker === true;
    const dispatchAt = Date.parse(payload.dispatchedAt || row.createdAt);
    if (dispatched && (!Number.isFinite(dispatchAt) || dispatchAt > at)) throw new Error("MALFORMED_ACCOUNTING_STATE");
    if (dispatched && dispatchAt < cutoff) continue;
    included += 1;
    if (row.providerUnit !== "tokens" || !Number.isSafeInteger(row.providerUnitAmount) || row.providerUnitAmount < 1) throw new Error("GROQ_TPM_LOCAL_USAGE_UNKNOWN");
    tokens += row.providerUnitAmount;
    if (!Number.isSafeInteger(tokens)) throw new Error("MALFORMED_ACCOUNTING_STATE");
  }
  return { status: included ? "KNOWN_USAGE" : "KNOWN_ZERO", tokens, included, excludedLegacy, unknownReservations: 0 };
}
