/**
 * Prints the "pending editorial reviews" message (text, HTML or JSON). READ-ONLY and delivery-free:
 * the repository has no email/SMS/webhook infrastructure, so this only renders the message to stdout.
 *
 *   npm run editorial:digest -- --sample            invented examples, no database access
 *   npm run editorial:digest                        real pending reviews (read-only M32 RPCs + local review packages)
 *   npm run editorial:digest -- --format=html --base-url=https://<panel-origin>
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readHumanReviewArtifact, verifyHumanReviewArtifact } from "../lib/agents/publisher/human-review.ts";
import { SupabaseHumanReviewReadRepository } from "../lib/agents/publisher/human-review-read-repository.ts";
import { SupabaseHumanReviewRepository } from "../lib/agents/publisher/human-review-repository.ts";
import { createSupabaseServerClient } from "../lib/supabase/server-client.ts";
import { loadWaitingEditorialReviewsWith } from "../lib/editorial/live-service.ts";
import { buildEditorialReviewDigest } from "../lib/editorial/review-digest.ts";
import type { EditorialReview } from "../lib/editorial/review.ts";

type Format = "text" | "html" | "json";

function parseArgs(argv: readonly string[]): { sample: boolean; format: Format; baseUrl: string | null } {
  let sample = false;
  let format: Format = "text";
  let baseUrl: string | null = process.env.EDITORIAL_AUTH_ORIGIN?.trim() || process.env.NEXT_PUBLIC_SITE_URL?.trim() || null;
  for (const arg of argv) {
    if (arg === "--sample") sample = true;
    else if (arg.startsWith("--format=")) {
      const value = arg.slice("--format=".length);
      if (value !== "text" && value !== "html" && value !== "json") throw new Error("USAGE:--format=text|html|json");
      format = value;
    } else if (arg.startsWith("--base-url=")) baseUrl = arg.slice("--base-url=".length).trim() || null;
    else throw new Error(`UNKNOWN_ARGUMENT:${arg}`);
  }
  return { sample, format, baseUrl };
}

async function loadSample(): Promise<{ reviews: EditorialReview[]; publishedToday: number }> {
  const { editorialFixtures } = await import("../lib/editorial/fixtures.ts");
  return { reviews: editorialFixtures.filter((review) => review.reviewStatus === "WAITING_FOR_HUMAN_REVIEW"), publishedToday: 0 };
}

async function loadLive(): Promise<{ reviews: EditorialReview[]; publishedToday: number }> {
  const client = createSupabaseServerClient();
  const artifactRoot = process.env.HUMAN_REVIEW_ARTIFACT_ROOT?.trim() || "artifacts/human-review-packages";
  return loadWaitingEditorialReviewsWith({
    repository: new SupabaseHumanReviewReadRepository(client),
    async readArtifact(row) {
      const artifact = await readHumanReviewArtifact(artifactRoot, row.attempt_id);
      if (!verifyHumanReviewArtifact(artifact)) throw new Error("REVIEW_PACKAGE_INVALID");
      return artifact;
    },
    readRevision: (reviewId) => new SupabaseHumanReviewRepository(client).getRevision(reviewId),
  });
}

async function main(argv: readonly string[]): Promise<void> {
  const options = parseArgs(argv);
  const { reviews, publishedToday } = options.sample ? await loadSample() : await loadLive();
  const digest = buildEditorialReviewDigest(reviews, { adminBaseUrl: options.baseUrl, generatedAt: new Date().toISOString(), publishedToday });
  if (options.format === "html") console.log(digest.html);
  else if (options.format === "json") console.log(JSON.stringify({ subject: digest.subject, reviewCount: digest.reviewCount, text: digest.text, html: digest.html }, null, 2));
  else console.log(digest.text);
  if (options.sample) console.error("\n(Ejemplo: datos inventados. Nada se ha enviado; este repositorio no tiene infraestructura de envío.)");
  else console.error("\n(Solo lectura. Nada se ha enviado; este repositorio no tiene infraestructura de envío.)");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "EDITORIAL_DIGEST_FAILED");
  process.exitCode = 1;
});
