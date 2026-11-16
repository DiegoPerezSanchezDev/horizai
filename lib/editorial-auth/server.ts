import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createEditorialAuthClient } from "./client.ts";
import { getEditorialAuthConfiguration } from "./config.ts";
import { isEditorialSessionCookie, type OperatorIdentity } from "./policy.ts";
import { resolveEditorialOperator } from "./resolve.ts";

/** Canonical data boundary. Also call this inside every future editorial API/action. */
export const requireEditorialOperator = cache(async (): Promise<OperatorIdentity> => {
  const store = await cookies();
  const client = createEditorialAuthClient({ getAll: () => store.getAll() });
  // Proxy refreshes and forwards cookies before rendering; Server Components only read.
  const result = await resolveEditorialOperator(client, getEditorialAuthConfiguration()?.allowlist ?? [],
    store.getAll().some((cookie) => isEditorialSessionCookie(cookie.name)));
  if (result.status !== "authorized") redirect(`/editorial/login?state=${result.status}`);
  return result.operator;
});
