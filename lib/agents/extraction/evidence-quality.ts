import type { ExtractedItem } from "../contracts/index.ts";
import { eventTokens, normalizeEventText } from "../clustering/normalize-event-text.ts";

export const extractionEvidenceInsufficient = "EXTRACTION_EVIDENCE_INSUFFICIENT" as const;
export type EvidenceQualityReason = "ELIGIBLE" | "NO_ARTICLE_BODY" | "NO_SUBSTANTIVE_TEXT" | "NO_CANDIDATE_RELATION";
export type EvidenceQualityInput = Pick<ExtractedItem, "title" | "description" | "content" | "extractionQuality">;

const wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });
const sentenceSegmenter = new Intl.Segmenter(undefined, { granularity: "sentence" });
function words(text: string): string[] {
  return [...wordSegmenter.segment(text)].filter((part) => part.isWordLike).map((part) => part.segment);
}
function terms(text: string): Set<string> {
  return new Set([...eventTokens(words(normalizeEventText(text)).join(" "))].filter((term) => /\p{L}/u.test(term)));
}

/** Admission only: these signals do not establish truth, credibility, or facts. */
export function assessExtractionEvidence(item: EvidenceQualityInput, candidateTitle = item.title) {
  const titleTerms = terms(`${candidateTitle} ${item.title}`);
  const paragraphs = item.content.trim().split(/\n\s*\n|\r?\n/).map((text) => text.trim()).filter(Boolean);
  const body = paragraphs.filter((text) => ![item.title, candidateTitle].some((title) => normalizeEventText(text) === normalizeEventText(title)));
  const sentences = body.flatMap((text) => [...sentenceSegmenter.segment(text)].map((part) => part.segment.trim()));
  const sentenceSignals = sentences.map((text) => {
    const contentTerms = terms(text);
    const matchedTitleTerms = [...titleTerms].filter((term) => contentTerms.has(term));
    const novelTerms = [...contentTerms].filter((term) => !titleTerms.has(term));
    // The corpus's short legitimate sentence has ten words. Eight words and
    // three distinct terms beyond the headline retain it while excluding
    // headings, repeated titles, and terse menu labels. This is prose, not fact checking.
    return { text, wordCount: words(text).length, novelTerms: novelTerms.length, matchedTitleTerms,
      substantive: words(text).length >= 8 && novelTerms.length >= 3 };
  });
  const substantive = sentenceSignals.filter((sentence) => sentence.substantive);
  const related = substantive.filter((sentence) => sentence.matchedTitleTerms.length > 0);
  const coveredTerms = [...new Set(related.flatMap((sentence) => sentence.matchedTitleTerms))];
  const signals = {
    textLength: item.content.length, wordCount: words(item.content).length,
    paragraphCount: paragraphs.length,
    substantiveParagraphCount: body.filter((paragraph) => sentenceSignals.some((sentence) => sentence.substantive && paragraph.includes(sentence.text))).length,
    sentenceCount: sentences.length, substantiveSentenceCount: substantive.length,
    candidateRelatedSentenceCount: related.length,
    titleTerms: [...titleTerms], coveredTitleTerms: coveredTerms,
    candidateKeyTermCoverage: titleTerms.size ? coveredTerms.length / titleTerms.size : 0,
    uniqueTermCount: terms(item.content).size,
    uniqueSentenceCount: new Set(sentences.map(normalizeEventText)).size,
    metadataOnly: item.extractionQuality === "metadata_only",
  };
  const reason: EvidenceQualityReason = !item.content.trim() || signals.metadataOnly ? "NO_ARTICLE_BODY"
    : substantive.length === 0 ? "NO_SUBSTANTIVE_TEXT"
    : related.length === 0 ? "NO_CANDIDATE_RELATION" : "ELIGIBLE";
  return { eligible: reason === "ELIGIBLE", reason, signals };
}

export type ExtractionEvidenceAssessment = ReturnType<typeof assessExtractionEvidence>;
export type CandidateEvidenceAssessment =
  | { eligible: true; terminalReason: null; assessments: ExtractionEvidenceAssessment[] }
  | { eligible: false; terminalReason: typeof extractionEvidenceInsufficient; assessments: ExtractionEvidenceAssessment[] };

export function assessCandidateEvidence(candidateTitle: string, items: readonly EvidenceQualityInput[]): CandidateEvidenceAssessment {
  const assessments = items.map((item) => assessExtractionEvidence(item, candidateTitle));
  const eligible = assessments.some((item) => item.eligible);
  return eligible ? { eligible: true, terminalReason: null, assessments }
    : { eligible: false, terminalReason: extractionEvidenceInsufficient, assessments };
}
