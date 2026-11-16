import type { EditorialDraft } from "../contracts/index.ts";
import type { EditorInput } from "./editor-types.ts";

/**
 * Deterministic "does the text say more than the evidence" guard.
 *
 * Small free models tend to pad: they restate the headline, add adjectives of
 * significance and claim things nobody verified. Two cheap checks catch most of it:
 *  1. Overreach vocabulary (efficacy, autonomy, "demuestra"...) is only allowed when
 *     the same word family already appears in the verified/translated material.
 *  2. Each factual sentence must be mostly made of words (word stems) that exist in
 *     the allowed material. A sentence of generic filler fails this test.
 */

export type GroundingIssue = {
  kind: "OVERREACH_TERM" | "UNGROUNDED_SENTENCE" | "UNGROUNDED_HEADLINE";
  field: string;
  detail: string;
};

const stopStems = new Set([
  "para", "como", "pero", "sobre", "entre", "desde", "hasta", "cuando", "donde", "tambien", "ademas", "segun", "esta", "este", "estos",
  "estas", "ese", "esa", "esos", "esas", "tiene", "tienen", "puede", "pueden", "hace", "hacen", "otros", "otras", "cada", "mismo", "misma",
  "ser", "sido", "esto", "eso", "aunque", "porque", "durante", "mediante", "dentro", "fuera", "mas", "muy", "solo", "asi", "aun", "todo",
  "toda", "todos", "todas", "cual", "cuales", "quien", "quienes", "tras", "ante", "bajo", "contra", "sin", "con", "los", "las", "una", "uno",
]);

/** Word families that signal a claim of efficacy, autonomy, significance or hype. */
const overreachFamilies: Array<{ label: string; draftPattern: RegExp; evidenceStem: RegExp }> = [
  { label: "demuestra/demostrar", draftPattern: /\bdemuestr\w*|\bdemostr\w*/iu, evidenceStem: /demuestr|demostr|demonstr|prove[nd]?\b|proven|shows? that/iu },
  { label: "eficacia/eficaz", draftPattern: /\befica(?:z|ces|cia|cias)\b/iu, evidenceStem: /efica|effective|efficacy/iu },
  { label: "eficiencia", draftPattern: /\beficien\w*/iu, evidenceStem: /eficien|efficien/iu },
  { label: "sin intervención humana", draftPattern: /sin\s+(?:ninguna\s+)?(?:intervenci[oó]n|supervisi[oó]n|ayuda)\s+humana/iu, evidenceStem: /sin\s+(?:ninguna\s+)?(?:intervenci|supervisi|ayuda)|without\s+(?:any\s+)?human/iu },
  { label: "autonomía", draftPattern: /\baut[oó]nom\w*/iu, evidenceStem: /aut[oó]nom|autonomous|autonomy/iu },
  { label: "avances significativos", draftPattern: /\b(?:avances?|progresos?|mejoras?)\s+(?:significativ|sustancial|notable|importante|considerable|enorme)\w*/iu, evidenceStem: /significativ|sustancial|notable|importante|considerable|significant|substantial|major/iu },
  { label: "revolución/histórico", draftPattern: /\brevolucion\w*|\bhist[oó]ric[oa]s?\b|\bantes y un despu[eé]s\b|\bsin precedentes\b/iu, evidenceStem: /revoluci|hist[oó]ric|historic|antes y un despu|unprecedented|sin precedentes|breakthrough/iu },
  { label: "transformará", draftPattern: /\b(?:transformar[aá]n?|cambiar[aá]n?|revolucionar[aá]n?)\b/iu, evidenceStem: /transformar|cambiar[aá]|revolucion|will (?:transform|change)/iu },
  { label: "garantiza/asegura el éxito", draftPattern: /\b(?:garantiza|garantizan|asegura|aseguran)\b/iu, evidenceStem: /garantiz|asegur|guarantee|ensure/iu },
];

function fold(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLocaleLowerCase();
}

/** Crude cross-inflection stem: first five letters of an accent-folded word. */
export function contentStems(text: string): string[] {
  const words = fold(text).match(/[a-z0-9]{4,}/g) ?? [];
  return words.map((word) => word.slice(0, 5)).filter((stem) => !stopStems.has(stem) && !/^\d+$/.test(stem));
}

function allowedMaterial(input: EditorInput): string {
  return [
    input.event.canonicalTitle,
    input.translation.translatedTitle,
    input.translation.translatedSourceMaterial,
    ...input.translation.translatedFacts.flatMap((fact) => [fact.translatedText, fact.sourceText]),
    ...input.verification.verifiedFacts.map((fact) => fact.claim),
    ...input.verification.uncertainClaims.map((claim) => claim.claim),
    ...input.verification.contradictions.map((claim) => claim.claim),
    ...input.sources.map((source) => source.sourceName),
    ...input.translation.preservedNames,
  ].join(" ");
}

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/u).map((sentence) => sentence.trim()).filter((sentence) => sentence.length > 0);
}

// A cautionary sentence ("no permite concluir", "sigue sin confirmarse") asserts nothing new.
const cautionaryPattern = /\b(?:no\s+(?:permite|confirma|confirman|est[aá]|puede|debe|se\s+ha|queda)|sigue\s+sin|a[uú]n\s+no|por\s+s[ií]\s+solo|depender[aá]|depende\s+de|queda\s+por|habr[aá]\s+que|a\s+falta\s+de|conviene\s+(?:distinguir|se[nñ]alar)|procede\s+de|se\s+mantiene\s+la\s+atribuci[oó]n|la\s+atribuci[oó]n\s+se\s+mantiene)(?![\p{L}])/iu;
const MIN_STEMS = 6;
const MIN_COVERAGE = 0.25;
const HEADLINE_MIN_STEMS = 3;
const HEADLINE_MIN_COVERAGE = 0.55;

export function analyzeEditorialGrounding(input: EditorInput, draft: EditorialDraft): GroundingIssue[] {
  const material = allowedMaterial(input);
  const foldedMaterial = fold(material);
  const allowed = new Set(contentStems(material));
  const issues: GroundingIssue[] = [];

  const fields: Array<[string, string]> = [
    ["headlineEs", draft.headlineEs], ["dekEs", draft.dekEs], ["summaryEs", draft.summaryEs],
    ["whyItMattersEs", draft.whyItMattersEs], ["bodyEs", draft.bodyEs], ...draft.keyPoints.map((point, index): [string, string] => [`keyPoints[${index}]`, point]),
  ];
  for (const [field, text] of fields) {
    for (const family of overreachFamilies) {
      if (family.draftPattern.test(text) && !family.evidenceStem.test(material) && !family.evidenceStem.test(foldedMaterial)) {
        issues.push({ kind: "OVERREACH_TERM", field, detail: family.label });
      }
    }
  }

  const headlineStems = contentStems(draft.headlineEs);
  if (headlineStems.length >= HEADLINE_MIN_STEMS) {
    const covered = headlineStems.filter((stem) => allowed.has(stem)).length / headlineStems.length;
    if (covered < HEADLINE_MIN_COVERAGE) issues.push({ kind: "UNGROUNDED_HEADLINE", field: "headlineEs", detail: `coverage ${covered.toFixed(2)}` });
  }

  // whyItMattersEs is allowed to be interpretive; the factual fields are not.
  const factual: Array<[string, string]> = [["dekEs", draft.dekEs], ["summaryEs", draft.summaryEs], ["bodyEs", draft.bodyEs], ...draft.keyPoints.map((point, index): [string, string] => [`keyPoints[${index}]`, point])];
  for (const [field, text] of factual) {
    for (const sentence of sentences(text)) {
      if (cautionaryPattern.test(sentence)) continue;
      const stems = contentStems(sentence);
      if (stems.length < MIN_STEMS) continue;
      const covered = stems.filter((stem) => allowed.has(stem)).length / stems.length;
      if (covered < MIN_COVERAGE) issues.push({ kind: "UNGROUNDED_SENTENCE", field, detail: `coverage ${covered.toFixed(2)}: ${sentence.slice(0, 90)}` });
    }
  }
  return issues;
}
