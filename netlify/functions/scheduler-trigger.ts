import { timingSafeEqual } from "node:crypto";
import { runSchedulerTrigger } from "../../lib/agents/pipeline/scheduler/scheduler-runner.ts";

type NetlifyFunctionEvent = {
  httpMethod?: string;
  headers?: Record<string, string | undefined>;
};

type NetlifyFunctionResponse = {
  statusCode: number;
  headers: { "content-type": string; "cache-control": string };
  body: string;
};

function json(statusCode: number, body: Record<string, unknown>): NetlifyFunctionResponse {
  return { statusCode, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(body) };
}

function suppliedSecret(event: NetlifyFunctionEvent): string {
  const headers = event.headers ?? {};
  return headers["x-horizai-scheduler-secret"] ?? headers["X-HorizAI-Scheduler-Secret"] ?? "";
}

function authorized(event: NetlifyFunctionEvent): boolean {
  const expected = process.env.SCHEDULER_TRIGGER_SECRET ?? "";
  const provided = suppliedSecret(event);
  if (!expected || !provided) return false;
  const expectedBytes = Buffer.from(expected);
  const providedBytes = Buffer.from(provided);
  return expectedBytes.length === providedBytes.length && timingSafeEqual(expectedBytes, providedBytes);
}

export async function handler(event: NetlifyFunctionEvent): Promise<NetlifyFunctionResponse> {
  if (event.httpMethod !== "POST") return json(405, { ok: false, error: "method_not_allowed" });
  if (!authorized(event)) return json(401, { ok: false, error: "unauthorized" });
  try {
    const result = await runSchedulerTrigger();
    return json(200, { ok: true, result });
  } catch {
    return json(500, { ok: false, error: "scheduler_preflight_failed" });
  }
}
