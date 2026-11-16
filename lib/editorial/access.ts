import "server-only";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { canAccessEditorialFixtures } from "./access-policy.ts";
import { requireEditorialOperator } from "../editorial-auth/server.ts";

export async function requireEditorialDevelopmentAccess(): Promise<void> {
  await requireEditorialOperator();
  // Check before request APIs or importing fixtures; no production escape switch.
  if (process.env.NODE_ENV !== "development") notFound();
  if (!canAccessEditorialFixtures(process.env.NODE_ENV, (await headers()).get("host"))) notFound();
}
