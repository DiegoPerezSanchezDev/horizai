import "server-only";
import { requireEditorialOperator } from "../editorial-auth/server.ts";
import { resolveEditorialDataMode, type EditorialDataMode } from "./data-mode-policy.ts";
export { resolveEditorialDataMode } from "./data-mode-policy.ts";

/** Resolve a mode only after the canonical server-side operator guard. */
export async function getEditorialDataMode(): Promise<EditorialDataMode> {
  await requireEditorialOperator();
  return resolveEditorialDataMode(process.env.NODE_ENV, process.env.EDITORIAL_LIVE_DATA_ENABLED);
}
