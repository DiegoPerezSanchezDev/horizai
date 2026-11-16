import { ProviderScopedDailyRequestBudget, type RequestBudgetClock } from "../runtime/request-budget.ts";
import type { CapacityResumeSnapshot } from "./provider-capacity-resume.ts";
import { SUPERVISED_PROVIDER_REQUEST_LIMIT } from "./supervised-throughput-policy.ts";

/** Reconstruct only the local execution guard from validated durable accounting.
 * This never reserves in the provider ledger or makes a network request.
 */
export function createCapacityResumeRequestBudget(snapshot: Pick<CapacityResumeSnapshot, "providerAccounting">, clock: RequestBudgetClock = () => new Date()): ProviderScopedDailyRequestBudget {
  const budget = new ProviderScopedDailyRequestBudget(clock, SUPERVISED_PROVIDER_REQUEST_LIMIT);
  for (const telemetry of Object.values(snapshot.providerAccounting)) {
    if (!telemetry || telemetry.provider !== "groq" || !Number.isSafeInteger(telemetry.providerRequestsUsed) || telemetry.providerRequestsUsed < 0) {
      throw new Error("SUPERVISED_RESUME_REQUEST_ACCOUNTING_INVALID");
    }
    for (let request = 0; request < telemetry.providerRequestsUsed; request += 1) {
      // Replay historical local reservations under the execution cap. Live calls
      // still pass the independent provider RPD to AgentRunner.reserveLocalRequest.
      budget.reserve("groq", SUPERVISED_PROVIDER_REQUEST_LIMIT);
    }
  }
  return budget;
}

export type SupervisedRequestCapContract = {
  providerRpdHardLimit: number;
  providerRpdSoftLimit: number;
  providerRpdRemaining: number;
  supervisedExecutionRequestCap: number;
  cumulativeAttemptRequests: number;
  remainingExecutionRequests: number;
  outcome: "READY" | "PROVIDER_RPD_CAPACITY_EXHAUSTED" | "SUPERVISED_EXECUTION_REQUEST_CAP_EXHAUSTED";
};

/** Validate independent provider and execution domains; equality is not required. */
export function inspectSupervisedRequestCapContract(input: {
  providerRpdHardLimit: number;
  providerRpdSoftLimit: number;
  providerRpdRemaining: number;
  requestBudget: ProviderScopedDailyRequestBudget;
}): SupervisedRequestCapContract {
  const { providerRpdHardLimit, providerRpdSoftLimit, providerRpdRemaining } = input;
  if (!Number.isSafeInteger(providerRpdHardLimit) || providerRpdHardLimit < 1
    || !Number.isSafeInteger(providerRpdSoftLimit) || providerRpdSoftLimit < 1 || providerRpdSoftLimit > providerRpdHardLimit
    || !Number.isSafeInteger(providerRpdRemaining) || providerRpdRemaining < 0 || providerRpdRemaining > providerRpdSoftLimit) {
    throw new Error("PROVIDER_RPD_PREFLIGHT_CONTRACT_INVALID");
  }
  const execution = input.requestBudget.executionSnapshot();
  if (execution.cap !== SUPERVISED_PROVIDER_REQUEST_LIMIT || execution.remaining === null
    || execution.requests > SUPERVISED_PROVIDER_REQUEST_LIMIT) throw new Error("SUPERVISED_EXECUTION_REQUEST_CAP_MISMATCH");
  return {
    providerRpdHardLimit, providerRpdSoftLimit, providerRpdRemaining,
    supervisedExecutionRequestCap: execution.cap,
    cumulativeAttemptRequests: execution.requests,
    remainingExecutionRequests: execution.remaining,
    outcome: execution.remaining === 0 ? "SUPERVISED_EXECUTION_REQUEST_CAP_EXHAUSTED"
      : providerRpdRemaining === 0 ? "PROVIDER_RPD_CAPACITY_EXHAUSTED" : "READY",
  };
}
