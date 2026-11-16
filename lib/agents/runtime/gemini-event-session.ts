import { AgentError, PaidProviderForbiddenError } from "./agent-errors.ts";
import { normalEventStages } from "./event-model-stages.ts";
import { GEMINI_PROVIDER_ID, type GeminiProviderId } from "./gemini-policy.ts";
import { GeminiLocalLimitError, type GeminiLimitAccountant } from "./gemini-capacity.ts";
import type { GeminiAccountedProvider } from "./gemini-provider.ts";
import type { GenerateStructuredRequest, ModelProviderResponse } from "./runtime-types.ts";

export type GeminiEventAssignment = Readonly<{ eventKey: string; provider: GeminiProviderId; model: string }>;

export function assertGeminiStageAssignment(assignment: GeminiEventAssignment, eventKey: string, provider: string, model: string): void {
  if (assignment.eventKey !== eventKey || assignment.provider !== provider || assignment.model !== model) throw new Error("EVENT_PROVIDER_ASSIGNMENT_MISMATCH");
}

/**
 * Pins one event to Gemini end to end. There is no router and no fallback: the session admits the whole event
 * up front (blocks and daily limits only; minute windows self-heal), refuses any stage that names another
 * provider/model, caps the event's model requests, and once a stage fails on capacity or a 429 every later
 * stage of the same event fails immediately instead of being sent anywhere else.
 */
export class GeminiEventSession implements GeminiAccountedProvider {
  readonly providerId = GEMINI_PROVIDER_ID;
  readonly assignment: GeminiEventAssignment;
  private readonly inner: GeminiAccountedProvider;
  private readonly maxRequests: number;
  private requests = 0;
  private haltedBy: string | null = null;

  constructor(inner: GeminiAccountedProvider, input: { eventKey: string; model: string; maxRequests?: number; stageTokens?: number }) {
    if (!input.eventKey.trim()) throw new AgentError("cost_guard_violation", "Gemini event session needs an event key");
    inner.assertRequestApproved(input.model);
    this.inner = inner;
    this.maxRequests = input.maxRequests ?? normalEventStages.length;
    if (!Number.isSafeInteger(this.maxRequests) || this.maxRequests < 1 || this.maxRequests > normalEventStages.length) throw new AgentError("cost_guard_violation", "Invalid Gemini event request cap");
    this.assignment = Object.freeze({ eventKey: input.eventKey, provider: GEMINI_PROVIDER_ID, model: input.model });
    const stageTokens = input.stageTokens ?? 1;
    inner.accountant.admitEvent({ requests: this.maxRequests, tokens: stageTokens * this.maxRequests, largestRequestTokens: stageTokens });
  }

  get accountant(): GeminiLimitAccountant { return this.inner.accountant; }
  get halted(): string | null { return this.haltedBy; }
  assertRequestApproved(model: string): void { this.inner.assertRequestApproved(model); }

  async generateStructured<T>(request: GenerateStructuredRequest<T>): Promise<ModelProviderResponse<T>> {
    if (this.haltedBy) throw new GeminiLocalLimitError("RATE_LIMITED_429", `Gemini event halted after ${this.haltedBy}; no fallback provider exists`, null);
    if (request.config.model !== this.assignment.model) throw new PaidProviderForbiddenError();
    if (this.requests >= this.maxRequests) throw new AgentError("cost_guard_violation", "Gemini event request cap reached");
    this.requests += 1;
    try {
      return await this.inner.generateStructured(request);
    } catch (error) {
      if (error instanceof AgentError && (error.code === "FREE_TIER_LIMIT_REACHED" || error.code === "PROVIDER_CAPACITY_EXHAUSTED")) this.haltedBy = error.code;
      throw error;
    }
  }
}
