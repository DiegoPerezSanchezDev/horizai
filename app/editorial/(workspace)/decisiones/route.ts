import { NextResponse, type NextRequest } from "next/server";
import { revalidatePath } from "next/cache";
import { getEditorialAuthOrigin } from "@/lib/editorial-auth/config";
import { isSameOriginAuthPost } from "@/lib/editorial-auth/policy";
import { requireEditorialOperator } from "@/lib/editorial-auth/server";
import { isEditorialDecisionEnabled, parseEditorialDecisionForm, type EditorialDecisionOutcome } from "@/lib/editorial/decision-policy";
import { executeEditorialDecision } from "@/lib/editorial/decision-service";
import { createEditorialReviewOperations } from "@/lib/editorial/review-operations";

const privateHeaders = {
  "Cache-Control": "private, no-store, max-age=0",
  "Referrer-Policy": "same-origin",
  "X-Robots-Tag": "noindex, nofollow, noarchive, nosnippet",
};

async function readSmallForm(request: NextRequest): Promise<URLSearchParams | null> {
  if (!request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")) return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    length += chunk.value.byteLength;
    if (length > 4096) { await reader.cancel(); return null; }
    chunks.push(chunk.value);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function back(request: NextRequest, state: EditorialDecisionOutcome, reviewId?: string): NextResponse {
  const origin = getEditorialAuthOrigin(request.url) ?? request.url;
  // Fixed destinations only: the redirect never takes a user-controlled URL. The id is re-validated as a UUID by the parser.
  const url = new URL(reviewId ? `/editorial/reviews/${reviewId}` : "/editorial", origin);
  url.searchParams.set("state", state);
  const response = NextResponse.redirect(url, 303);
  for (const [key, value] of Object.entries(privateHeaders)) response.headers.set(key, value);
  return response;
}

/**
 * Mutating endpoint for approve / hold / reject / publish. Order matters: same-origin check, verified operator from
 * the session (the proxy has already gated /editorial/*), feature flags, strict form parse, then the SAME shared
 * human-review operations the CLI uses (package hash, current checkpoints, seven checks, daily cap and lease).
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isSameOriginAuthPost(request.headers.get("origin"), getEditorialAuthOrigin(request.url), request.headers.get("sec-fetch-site"))) {
    return NextResponse.json({ error: "INVALID_ORIGIN" }, { status: 403, headers: privateHeaders });
  }
  const operator = await requireEditorialOperator();
  if (!isEditorialDecisionEnabled(process.env.EDITORIAL_DECISIONS_ENABLED, process.env.EDITORIAL_LIVE_DATA_ENABLED)) return back(request, "disabled");

  const form = await readSmallForm(request);
  if (!form) return back(request, "invalid");
  const parsed = parseEditorialDecisionForm(form);
  if (!parsed.ok) return back(request, parsed.code);

  const command = parsed.command;
  let operations;
  try { operations = createEditorialReviewOperations(); } catch { return back(request, "error"); }
  const outcome = await executeEditorialDecision(command, operator.email, operations);

  if (outcome === "published" || outcome === "approved_publish_failed") {
    // On an ambiguous publish result, refresh public paths too: the atomic article write may have completed.
    revalidatePath("/");
    revalidatePath("/sitemap.xml");
  }
  revalidatePath("/editorial");
  return back(request, outcome, command.action === "publish" ? undefined : command.reviewId);
}
