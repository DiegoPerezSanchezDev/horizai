import { NextResponse, type NextRequest } from "next/server";
import { revalidatePath } from "next/cache";
import { getEditorialAuthOrigin } from "@/lib/editorial-auth/config";
import { isSameOriginAuthPost } from "@/lib/editorial-auth/policy";
import { requireEditorialOperator } from "@/lib/editorial-auth/server";
import { isWithdrawalEnabled, parseWithdrawalForm, type WithdrawalOutcomeCode } from "@/lib/editorial/withdrawal-policy";
import { SupabaseWithdrawalRepository } from "@/lib/editorial/withdrawal-repository";

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
    if (length > 8192) { await reader.cancel(); return null; }
    chunks.push(chunk.value);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function back(request: NextRequest, state: string): NextResponse {
  const origin = getEditorialAuthOrigin(request.url) ?? request.url;
  const url = new URL("/editorial/publicadas", origin);
  url.searchParams.set("state", state);
  const response = NextResponse.redirect(url, 303);
  for (const [key, value] of Object.entries(privateHeaders)) response.headers.set(key, value);
  return response;
}

/**
 * First and only mutating editorial endpoint. Order matters: same-origin check, feature flag,
 * verified operator from the session, strict form parse, then a single service-role RPC.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isSameOriginAuthPost(request.headers.get("origin"), getEditorialAuthOrigin(request.url), request.headers.get("sec-fetch-site"))) {
    return NextResponse.json({ error: "INVALID_ORIGIN" }, { status: 403, headers: privateHeaders });
  }
  const operator = await requireEditorialOperator();
  if (!isWithdrawalEnabled(process.env.EDITORIAL_WITHDRAWAL_ENABLED)) return back(request, "disabled" satisfies WithdrawalOutcomeCode);

  const form = await readSmallForm(request);
  if (!form) return back(request, "invalid");
  const parsed = parseWithdrawalForm(form);
  if (!parsed.ok) return back(request, parsed.code);

  let outcome: WithdrawalOutcomeCode;
  try {
    outcome = await SupabaseWithdrawalRepository.fromEnvironment().execute(parsed.command, operator.email);
  } catch {
    outcome = "error";
  }

  if (outcome === "withdrawn" || outcome === "already_withdrawn" || outcome === "restored") {
    revalidatePath("/");
    revalidatePath(`/noticias/${parsed.command.slug}`);
    revalidatePath("/sitemap.xml");
  }
  return back(request, outcome);
}
