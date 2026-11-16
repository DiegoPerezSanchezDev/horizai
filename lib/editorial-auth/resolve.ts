import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { authorizeVerifiedOperator, type OperatorAuthResult } from "./policy.ts";

/** Only the provider's verified getUser response is trusted, never getSession/cookie claims. */
export async function resolveEditorialOperator(
  client: Pick<SupabaseClient, "auth"> | null,
  allowlist: readonly string[],
  hadSessionCookie: boolean,
): Promise<OperatorAuthResult> {
  if (!client || allowlist.length === 0) return { status: "unavailable" };
  if (!hadSessionCookie) return { status: "anonymous" };
  try {
    const { data, error } = await client.auth.getUser();
    if (error) return { status: error.status && error.status >= 500 ? "unavailable" : "expired" };
    if (!data.user) return { status: "expired" };
    return authorizeVerifiedOperator(data.user, allowlist);
  } catch { return { status: "unavailable" }; }
}
