import { z } from "zod";
import { AgentError } from "../runtime/agent-errors.ts";
import type { ExtractedItem } from "../contracts/index.ts";
import { verifierInputSchema, type VerifierInput } from "./verifier-types.ts";

const httpUrl = z.string().url().refine((value) => /^https?:\/\//i.test(value), "URL must use http or https");

const modelSourceSchema = z.object({
  sourceId: z.string().uuid(),
  sourceName: z.string().trim().min(1).max(200),
  sourceType: z.string().trim().min(1).max(80).nullable(),
  canonicalUrl: httpUrl,
  title: z.string().trim().min(1).max(500),
  description: z.string().trim().max(3_000).nullable(),
  publishedAt: z.string().datetime({ offset: true }).nullable(),
  author: z.string().trim().max(300).nullable(),
  content: z.string().trim().min(1).max(12_000),
  originalChars: z.number().int().nonnegative(),
  sentChars: z.number().int().nonnegative(),
  truncated: z.boolean(),
}).strict();

export const verifierModelInputSchema = z.object({
  event: z.object({
    eventKey: z.string().trim().min(1).max(200),
    canonicalTitle: z.string().trim().min(1).max(500),
    probableOccurredAt: z.string().datetime({ offset: true }).nullable(),
  }).strict(),
  sources: z.array(modelSourceSchema).min(1).max(100),
  contentMayBeTruncated: z.boolean(),
}).strict();

export type VerifierModelInput = z.infer<typeof verifierModelInputSchema>;

export type VerifierInputMetrics = {
  inputChars: number;
  originalContentChars: number[];
  sentContentChars: number[];
  truncated: boolean[];
  sourceCount: number;
};

export type BuiltVerifierInput = {
  input: VerifierModelInput;
  metrics: VerifierInputMetrics;
};

type EvidenceSentence = { text: string; index: number; critical: boolean; relevance: number; information: number };

const titleStopWords = new Set([
  "about", "after", "before", "from", "into", "over", "that", "their", "there", "this", "with",
  "para", "como", "desde", "entre", "hasta", "sobre", "tras", "una", "uno", "unos", "unas", "the", "and", "for", "are", "was", "were", "has", "have",
]);

function titleTerms(value: string): Set<string> {
  return new Set((value.toLocaleLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((word) => !titleStopWords.has(word)));
}

function evidenceSentences(content: string, locale: string, eventTitle: string, sourceTitle: string): EvidenceSentence[] {
  const rawSegments = typeof Intl.Segmenter === "function"
    ? [...new Intl.Segmenter(locale, { granularity: "sentence" }).segment(content)].map(({ segment }) => segment)
    : content.split(/(?<=[.!?])\s+|\n+/u);
  const seen = new Set<string>();
  const relatedTerms = new Set([...titleTerms(eventTitle), ...titleTerms(sourceTitle)]);
  return rawSegments.map((segment, index) => ({ text: segment.trim(), index })).filter(({ text }) => text.length > 0).flatMap(({ text, index }) => {
    const duplicateKey = text.normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase();
    if (seen.has(duplicateKey)) return [];
    seen.add(duplicateKey);
    const words = text.toLocaleLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [];
    const uniqueWords = new Set(words);
    const relevance = [...uniqueWords].filter((word) => relatedTerms.has(word)).length;
    const monthOrWeekday = /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|monday|tuesday|wednesday|thursday|friday|saturday|sunday|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre|lunes|martes|miércoles|jueves|viernes|sábado|domingo)\b/iu.test(text);
    return [{ text, index, critical: /\d/u.test(text) || monthOrWeekday, relevance, information: uniqueWords.size }];
  });
}

function cleanMetadata(item: ExtractedItem): { sourceType: string | null } {
  const sourceType = item.metadata.sourceType;
  return { sourceType: typeof sourceType === "string" && sourceType.trim() ? sourceType.trim().slice(0, 80) : null };
}

function inputTooLarge(): never {
  throw new AgentError("VERIFIER_INPUT_TOO_LARGE", "Verifier evidence cannot fit the bounded request while preserving complete evidence sentences and source attribution");
}

/**
 * Builds a bounded, source-balanced Verifier request. The content limit is an
 * aggregate character ceiling; maxModelInputChars optionally bounds the full
 * serialized model input after metadata is included.
 */
export function buildVerifierModelInput(rawInput: VerifierInput, maxInputChars: number, maxModelInputChars = Number.POSITIVE_INFINITY): BuiltVerifierInput {
  const validated = verifierInputSchema.parse(rawInput);
  if (!Number.isInteger(maxInputChars) || maxInputChars < validated.event.sourceItems.length
    || !(Number.isInteger(maxModelInputChars) || maxModelInputChars === Number.POSITIVE_INFINITY) || maxModelInputChars < 0) {
    throw new Error("AGENT_MAX_INPUT_CHARS must be an integer large enough to preserve content for each source");
  }
  const itemByCandidate = new Map(validated.items.map((item) => [item.candidateId, item]));
  const originalContentChars: number[] = [];
  const sourceRecords = validated.event.sourceItems.map((sourceItem) => {
    const item = itemByCandidate.get(sourceItem.candidateId);
    if (!item) throw new Error(`Missing extracted item ${sourceItem.candidateId}`);
    originalContentChars.push(item.content.length);
    return {
      sourceId: sourceItem.sourceId,
      sourceName: sourceItem.sourceName,
      sourceType: cleanMetadata(item).sourceType,
      canonicalUrl: item.canonicalUrl,
      title: item.title,
      description: item.description,
      publishedAt: item.publishedAt,
      author: item.author,
      originalChars: item.content.length,
      evidence: evidenceSentences(item.content, item.language, validated.event.canonicalTitle, sourceItem.title),
    };
  });
  const contents = sourceRecords.map(() => [] as EvidenceSentence[]);
  const selected = contents.map(() => new Set<number>());
  const makeInput = () => ({
    event: {
      eventKey: validated.event.eventKey,
      canonicalTitle: validated.event.canonicalTitle,
      probableOccurredAt: validated.event.probableOccurredAt,
    },
    sources: sourceRecords.map((source, index) => {
      const ordered = [...contents[index]].sort((left, right) => left.index - right.index);
      const content = ordered.map((sentence) => sentence.text).join(" ");
      return {
        sourceId: source.sourceId,
        sourceName: source.sourceName,
        sourceType: source.sourceType,
        canonicalUrl: source.canonicalUrl,
        title: source.title,
        description: source.description,
        publishedAt: source.publishedAt,
        author: source.author,
        content,
        originalChars: source.originalChars,
        sentChars: content.length,
        truncated: content.length < source.originalChars,
      };
    }),
    contentMayBeTruncated: contents.some((sentences, index) => sentences.reduce((sum, sentence) => sum + sentence.text.length, 0) < originalContentChars[index]),
  });
  const fits = () => contents.reduce((sum, sentences) => sum + sentences.reduce((chars, sentence) => chars + sentence.text.length, 0), 0) <= maxInputChars
    && JSON.stringify(makeInput()).length <= maxModelInputChars;
  const add = (sourceIndex: number, sentence: EvidenceSentence) => {
    if (selected[sourceIndex].has(sentence.index)) return;
    selected[sourceIndex].add(sentence.index);
    contents[sourceIndex].push(sentence);
  };

  // Keep one complete lead sentence per source. If even that cannot fit, fail
  // closed. Sentences with a numeric/date fact are prioritised below but, for
  // long documents, only as many as fit: the Verifier then judges an explicitly
  // truncated excerpt (contentMayBeTruncated) instead of rejecting the source.
  for (let index = 0; index < sourceRecords.length; index += 1) {
    const evidence = sourceRecords[index].evidence;
    if (evidence.length === 0) inputTooLarge();
    add(index, evidence[0]);
  }
  if (!fits()) inputTooLarge();

  // Add complete high-information, candidate-related sentences in balanced
  // rounds. Exact duplicate sentences are removed within a source only;
  // matching text from separate sources stays attributable to both sources.
  const optional = sourceRecords.map((source, index) => source.evidence
    .filter((sentence) => !selected[index].has(sentence.index))
    .sort((left, right) => Number(right.critical) - Number(left.critical) || right.relevance - left.relevance || right.information - left.information || left.index - right.index));
  let addedInRound = true;
  while (addedInRound) {
    addedInRound = false;
    for (let index = 0; index < sourceRecords.length; index += 1) {
      for (let candidateIndex = 0; candidateIndex < optional[index].length;) {
        const sentence = optional[index][candidateIndex];
        add(index, sentence);
        if (fits()) {
          optional[index].splice(candidateIndex, 1);
          addedInRound = true;
        } else {
          contents[index].pop();
          selected[index].delete(sentence.index);
          candidateIndex += 1;
        }
      }
    }
  }

  const input = verifierModelInputSchema.parse(makeInput());
  const sentContentChars = input.sources.map((source) => source.sentChars);
  const truncated = input.sources.map((source) => source.truncated);
  return {
    input,
    metrics: {
      inputChars: JSON.stringify(input).length,
      originalContentChars,
      sentContentChars,
      truncated,
      sourceCount: sourceRecords.length,
    },
  };
}
