# Free provider strategy — 10G.2b (offline)

HorizAI's rule is **NEVER PAY FOR MODEL API**. This phase changes only provider policy, adapter capability, capacity accounting and offline simulation. It makes zero Groq, Cerebras or Cloudflare inference calls. `FREE_PROVIDER_ROUTER_ENABLED` remains false, production composition still defaults to Groq, and no pipeline, scheduler, publisher, hosting or UI wiring is enabled.

## Provider policy

| Provider | Policy class | Router eligibility | Model allowlist |
| --- | --- | --- | --- |
| Groq | `PERMANENT_FREE_APPROVED` | Primary | `openai/gpt-oss-20b` |
| Cloudflare Workers AI | `PERMANENT_FREE_APPROVED` candidate | Secondary | `@cf/openai/gpt-oss-20b` only |
| Cerebras | `TRIAL_ONLY` | Ineligible | Historical adapter retained; not approved by free router |

Classification is explicit in `provider-cost-policy.ts`; it is never inferred from provider or model names. A paid, trial-only or unknown provider/model/endpoint is rejected before dispatch. Groq's existing model/client path is unchanged. The Cerebras adapter remains for historical/offline compatibility, but `createProviderClient` and `FreeProviderRouter` cannot select it. Historic Cerebras accounting rows stay attributed to Cerebras.

## Cloudflare adapter and structured-output status

`cloudflare-workers-ai-provider.ts` is server-only and shares `OpenAICompatibleModelProvider` transport, timeout/abort handling, HTTP error normalization, response parsing, Zod validation in the common runner, and deterministic agent guards. It uses only `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_AI_API_TOKEN`; neither is `NEXT_PUBLIC`. Its endpoint is the account-scoped Workers AI Chat Completions API. The exact allowed model is `@cf/openai/gpt-oss-20b`.

Offline fixtures cover `response_format: { type: "json_object" }`, strict schema generation through the same adapter, malformed JSON, schema-invalid output, JSON-mode/API errors, 400, 401/403, 429, 500, timeout and network failure. All outputs continue through JSON parsing → Zod → deterministic guard. A 429 is canonical `PROVIDER_RATE_LIMIT`, is not retried against another provider, and blocks continuation of the current event. The router may consider Cloudflare only for a *new* event.

**Structured output compatibility: `MOCK_COMPATIBLE` only.** Passing mocked requests/responses proves adapter and fail-closed behavior, not that this model supports JSON mode in the real API. That is reserved for 10G.3's single authorized validation request.

## Neuron capacity and estimates

Workers AI is metered in **Neurons**, not requests or tokens. Cloudflare currently documents 10,000 Neurons/day for Workers Free, reset at 00:00 UTC; usage beyond this requires Workers Paid, and an internal HorizAI hard cap must stop requests before that point. The internal allocation is required as `CLOUDFLARE_DAILY_NEURON_LIMIT`; an unset allocation disables Cloudflare. Configure no more than the remaining free allocation actually reserved for HorizAI, accounting for other use on the account. No auto-upgrade, prepaid AI Gateway credits, billing action, or paid-only model is allowed.

The current published catalog rates for `@cf/openai/gpt-oss-20b` are centralized as 18,182 input neurons / million tokens and 27,273 output neurons / million tokens. They can be overridden with `CLOUDFLARE_INPUT_NEURONS_PER_MILLION_TOKENS` and `CLOUDFLARE_OUTPUT_NEURONS_PER_MILLION_TOKENS`; an integer basis-point safety margin (default 12,500 = 1.25×) is applied centrally. The deterministic estimator returns a **forecast**, never an actual usage measurement. Runtime telemetry keeps `estimatedNeurons` separate from `actualProviderUnitUsage`; actual usage remains null unless later supplied by provider metrics.

The router preserves Groq's existing request/token limits. Cloudflare's primary capacity is the configured Neuron allocation with usage visibility, 85% soft threshold and hard cap; unknown Neuron usage fails closed. A daily Cloudflare request limit is optional and is enforced only if `CLOUDFLARE_FREE_DAILY_REQUEST_LIMIT` is explicitly configured; it is not treated as a Cloudflare plan quota. UTC daily accounting is used.

## Capacity evidence and 10-story target

The historical estimate must use only persisted, successful Groq telemetry from events with a complete six-stage run and known token usage. It reports median/p75/p90 only when there are at least 20 complete events; otherwise it reports `INSUFFICIENT_SAMPLE` and uses the conservative documented simulation fixture (12,000 input tokens and 3,000 output tokens/event, then the model-rate estimator and safety margin). The 10-event simulation is a deterministic planning fixture, not a capacity guarantee or a forecast of production demand. Its split is driven by test-only Groq/Cloudflare fixture limits; the printed total is labelled `ESTIMATED_CAPACITY_ONLY`.

## Accounting and migration

The provider-scoped storage introduced in migrations 19/20 had a closed `groq | cerebras` constraint, so Cloudflare needs the forward-only migration `20260923000021_cloudflare_workers_ai_capacity.sql`. It extends provider identity without updating any historic Cerebras values; adds nullable provider-unit reservation columns; and provides an atomic, service-role-only Cloudflare neuron reservation RPC that locks by provider/UTC day and checks the configured neuron hard cap. A request-count cap is optional and only enforced if explicitly configured. The RPC accepts only the current UTC accounting day. Estimated reservation is labeled as estimated, not actual. Existing migrations are not rewritten; migration 21 was applied to the linked remote project in 10G.3 after confirming it was pending.

`SupabaseAgentLogger.reserveCloudflareNeuronCapacity` targets the existing `agent_logs` ledger. The remote fixture test verified atomic hard-cap reservations, provider isolation, pre-dispatch release, non-release after dispatch, UTC-day enforcement, concurrency and cleanup. Catalog privilege checks confirmed anon/authenticated cannot read the ledger or execute the RPC; `service_role` can. RLS/public table grants and publication schema were not changed. Historical Groq/Cerebras accounting is not reinterpreted. Real Cloudflare structured-output compatibility remains unverified until the single 10G.3 request.

## Routing and production boundary

The pure router order is Groq → Cloudflare; only `PERMANENT_FREE_APPROVED` entries can pass the free-only assertion. Provider assignment remains sticky for an event. No mid-event fallback occurs; a provider 429 fails closed, and only a later new event may be routed to a different provider from fresh capacity state. No paid provider is registered. `FREE_PROVIDER_ROUTER_ENABLED` must remain false and production's configured provider remains Groq until 10G.3 validates Cloudflare against the actual account, including model access, structured output, usage/accounting and free-plan behavior.

## Configuration names

Set Cloudflare variables only in local/server deployment secret storage, never client-exposed variables:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_AI_API_TOKEN`
- `CLOUDFLARE_DAILY_NEURON_LIMIT`
- optional `CLOUDFLARE_FREE_DAILY_REQUEST_LIMIT`
- optional model-rate overrides and `CLOUDFLARE_NEURON_SAFETY_MARGIN_BPS`

No credential is required by the unit tests or simulation. No API key or prompt is logged. Hosting remains on the current platform; Cloudflare is inference only.

## Official references

- [Workers AI pricing and Neurons](https://developers.cloudflare.com/workers-ai/platform/pricing/)
- [OpenAI-compatible endpoints](https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/)
- [gpt-oss-20b model card](https://developers.cloudflare.com/workers-ai/models/gpt-oss-20b/)
- [Workers AI JSON Mode](https://developers.cloudflare.com/workers-ai/features/json-mode/)
- [Workers AI errors and rate limits](https://developers.cloudflare.com/workers-ai/platform/errors/)
