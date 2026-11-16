import "server-only";

import { mapWithdrawalError, type WithdrawalCommand, type WithdrawalOutcomeCode } from "./withdrawal-policy.ts";

type FetchLike = typeof fetch;

/** Calls the two service-role-only RPCs. The operator email comes from the verified session, never from the form. */
export class SupabaseWithdrawalRepository {
  private readonly baseUrl: string;
  private readonly serviceKey: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: { baseUrl: string; serviceKey: string; fetchImpl?: FetchLike }) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.serviceKey = options.serviceKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
    if (!this.baseUrl || !this.serviceKey) throw new Error("WITHDRAWAL_SERVER_CONFIGURATION_MISSING");
  }

  static fromEnvironment(fetchImpl?: FetchLike): SupabaseWithdrawalRepository {
    const baseUrl = process.env.SUPABASE_URL?.trim() || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
    const serviceKey = process.env.SUPABASE_SECRET_KEY?.trim() || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
    if (!baseUrl || !serviceKey) throw new Error("WITHDRAWAL_SERVER_CONFIGURATION_MISSING");
    return new SupabaseWithdrawalRepository({ baseUrl, serviceKey, fetchImpl });
  }

  async execute(command: WithdrawalCommand, operatorEmail: string): Promise<WithdrawalOutcomeCode> {
    const isWithdraw = command.action === "withdraw";
    const fn = isWithdraw ? "withdraw_published_article" : "restore_withdrawn_article";
    const body = isWithdraw
      ? { p_slug: command.slug, p_reason_code: command.reason, p_note: command.note, p_operator: operatorEmail }
      : { p_slug: command.slug, p_operator: operatorEmail };

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/rest/v1/rpc/${fn}`, {
        method: "POST",
        cache: "no-store",
        headers: {
          apikey: this.serviceKey,
          Authorization: `Bearer ${this.serviceKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      return "error";
    }
    if (!response.ok) return mapWithdrawalError(await response.text().catch(() => ""));

    const result: unknown = await response.json().catch(() => null);
    if (!result || typeof result !== "object" || typeof (result as { changed?: unknown }).changed !== "boolean") return "error";
    const changed = (result as { changed: boolean }).changed;
    if (!isWithdraw) return "restored";
    return changed ? "withdrawn" : "already_withdrawn";
  }
}
